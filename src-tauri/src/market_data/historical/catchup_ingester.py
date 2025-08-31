#!/usr/bin/env python3
"""
Catchup Ingester for Market Data Pipelines

This script handles gap filling when pipelines are restored after downtime.
It uses Dukascopy as the historical data source for forex pairs.

Major improvements:
- Concurrent downloads (25 workers by default)
- Batched database inserts (1M ticks per batch)
- Progress reporting in JSON format
- Memory-efficient processing
- Exponential backoff for retries

Usage:
    python3 catchup_ingester.py --symbol EURUSD --from "2024-01-15T10:30:00Z" --to "2024-01-15T11:00:00Z"
"""

import argparse
import lzma
import struct
import requests
import pandas as pd
from datetime import datetime, timedelta, timezone
import logging
import sys
import os
import json
import time
import psutil
from typing import List, Dict, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from queue import Queue
import signal
from sqlalchemy import create_engine, text
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Set up logging
logging.basicConfig(
    level=logging.WARNING,  # Reduce noise for Rust integration
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stderr  # Send logs to stderr, keep stdout for progress
)
logger = logging.getLogger(__name__)


class ProgressReporter:
    """Thread-safe progress reporter that outputs JSON to stdout"""
    
    def __init__(self, total_hours: int):
        self.total_hours = total_hours
        self.hours_completed = 0
        self.ticks_processed = 0
        self.ticks_inserted = 0
        self.failed_hours = []
        self.lock = Lock()
        self.start_time = time.time()
        
    def update(self, hours: int = 0, ticks: int = 0, failed_hour: Optional[str] = None):
        with self.lock:
            self.hours_completed += hours
            self.ticks_processed += ticks
            if failed_hour:
                self.failed_hours.append(failed_hour)
            
            # Calculate metrics
            elapsed = time.time() - self.start_time
            progress_pct = (self.hours_completed / self.total_hours * 100) if self.total_hours > 0 else 0
            ticks_per_sec = self.ticks_processed / elapsed if elapsed > 0 else 0
            eta_seconds = ((self.total_hours - self.hours_completed) / self.hours_completed * elapsed) if self.hours_completed > 0 else 0
            
            # Memory usage
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
            
            # Output progress as JSON line
            progress = {
                "type": "progress",
                "current_hour": self.hours_completed,
                "total_hours": self.total_hours,
                "progress_pct": round(progress_pct, 1),
                "ticks_processed": self.ticks_processed,
                "ticks_per_second": round(ticks_per_sec),
                "memory_mb": round(memory_mb),
                "eta_seconds": round(eta_seconds),
                "failed_hours": len(self.failed_hours)
            }
            print(json.dumps(progress), flush=True)
    
    def final_report(self, ticks_inserted: int):
        self.ticks_inserted = ticks_inserted
        elapsed = time.time() - self.start_time
        
        report = {
            "type": "complete",
            "status": "success" if not self.failed_hours else "partial",
            "ticks_inserted": ticks_inserted,
            "ticks_processed": self.ticks_processed,
            "hours_processed": self.hours_completed,
            "hours_failed": len(self.failed_hours),
            "elapsed_seconds": round(elapsed, 2),
            "ticks_per_second": round(self.ticks_processed / elapsed) if elapsed > 0 else 0
        }
        print(json.dumps(report), flush=True)


class CatchupIngester:
    def __init__(self, db_url: str = None, max_workers: int = 25, batch_size: int = 1_000_000):
        """
        Initialize the catchup ingester
        
        Args:
            db_url: Database connection string
            max_workers: Number of concurrent download workers
            batch_size: Number of ticks to insert per batch
        """
        self.base_url = "https://datafeed.dukascopy.com/datafeed"
        self.max_workers = max_workers
        self.batch_size = batch_size
        
        # Use environment variable if db_url not provided
        if not db_url:
            db_url = os.getenv('DATABASE_URL', 'postgresql://postgres@localhost:5432/forex_trading')
        
        self.engine = create_engine(db_url, pool_size=10, max_overflow=20)
        self.logger = logging.getLogger(__name__)
        
        # Setup session with retry strategy
        self.session = requests.Session()
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(
            max_retries=retry_strategy,
            pool_connections=max_workers,
            pool_maxsize=max_workers
        )
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)
        
        # For graceful shutdown
        self.shutdown = False
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals gracefully"""
        self.logger.info(f"Received signal {signum}, shutting down gracefully...")
        self.shutdown = True
        
    def download_bi5_file(self, symbol: str, date: datetime, hour: Optional[int] = None, 
                          daily: bool = False) -> Tuple[Optional[bytes], datetime, Optional[int]]:
        """
        Download compressed bi5 file for specific hour or full day
        
        Args:
            symbol: Trading symbol
            date: Date to fetch
            hour: Hour to fetch (None for daily)
            daily: If True, fetch daily file
        
        Returns:
            Tuple of (data, date, hour) to maintain context through concurrent execution
        """
        if self.shutdown:
            return None, date, hour
            
        if daily:
            # Daily file: /{year}/{month-1}/{day}_ticks.bi5 (discovered pattern)
            url = f"{self.base_url}/{symbol.upper()}/{date.year}/{date.month-1:02d}/{date.day:02d}_ticks.bi5"
            timeframe = "daily"
        else:
            # Hourly file: /{year}/{month-1}/{day}/{hour}h_ticks.bi5
            url = f"{self.base_url}/{symbol.upper()}/{date.year}/{date.month-1:02d}/{date.day:02d}/{hour:02d}h_ticks.bi5"
            timeframe = "hourly"
        
        try:
            response = self.session.get(url, timeout=30)
            if response.status_code == 404:
                self.logger.debug(f"No data available for {symbol} at {date.date()} {f'{hour:02d}:00' if hour is not None else 'daily'}")
                return None, date, hour
            response.raise_for_status()
            return response.content, date, hour
        except requests.RequestException as e:
            self.logger.error(f"Failed to download {url}: {e}")
            return None, date, hour
    
    def parse_bi5_data(self, compressed_data: bytes, symbol: str, base_time: datetime) -> List[Dict]:
        """Parse compressed bi5 data into tick records"""
        if not compressed_data:
            return []
            
        try:
            # Decompress LZMA data
            decompressed = lzma.decompress(compressed_data)
            
            # Parse binary records (each record is 20 bytes)
            chunk_size = struct.calcsize('>3I2f')
            ticks = []
            
            for i in range(0, len(decompressed), chunk_size):
                if i + chunk_size > len(decompressed):
                    break
                    
                chunk = decompressed[i:i + chunk_size]
                timestamp_ms, ask_raw, bid_raw, ask_vol, bid_vol = struct.unpack('>3I2f', chunk)
                
                # Convert to actual prices (Dukascopy uses integer representation)
                # JPY pairs use 3 decimal places, others use 5
                if 'JPY' in symbol.upper():
                    ask_price = ask_raw / 1000.0
                    bid_price = bid_raw / 1000.0
                else:
                    ask_price = ask_raw / 100000.0
                    bid_price = bid_raw / 100000.0
                
                # Calculate actual timestamp
                tick_time = base_time + timedelta(milliseconds=timestamp_ms)
                
                ticks.append({
                    'time': tick_time,
                    'symbol': symbol,
                    'ask': ask_price,
                    'bid': bid_price,
                    'ask_size': int(ask_vol * 1000000),
                    'bid_size': int(bid_vol * 1000000),
                    'source': 'dukascopy'
                })
            
            return ticks
        except Exception as e:
            self.logger.error(f"Error parsing bi5 data: {e}")
            return []
    
    def insert_batch(self, ticks: List[Dict]) -> int:
        """
        Insert a batch of ticks into the database
        
        Returns:
            Number of ticks inserted
        """
        if not ticks:
            return 0
            
        try:
            df = pd.DataFrame(ticks)
            
            with self.engine.begin() as conn:
                # Create temp table for this batch
                conn.execute(text("""
                    CREATE TEMP TABLE temp_catchup_ticks (
                        time TIMESTAMPTZ NOT NULL,
                        symbol VARCHAR(10) NOT NULL,
                        bid DECIMAL(10,5) NOT NULL,
                        ask DECIMAL(10,5) NOT NULL,
                        bid_size INTEGER DEFAULT 0,
                        ask_size INTEGER DEFAULT 0,
                        source VARCHAR(20) DEFAULT 'dukascopy'
                    ) ON COMMIT DROP
                """))
                
                # Bulk insert into temp table
                df.to_sql('temp_catchup_ticks', conn, if_exists='append', index=False, method='multi')
                
                # Upsert from temp table to main table
                result = conn.execute(text("""
                    INSERT INTO forex_ticks (time, symbol, bid, ask, bid_size, ask_size, source)
                    SELECT time, symbol, bid, ask, bid_size, ask_size, source 
                    FROM temp_catchup_ticks
                    ON CONFLICT (symbol, time) 
                    DO UPDATE SET 
                        bid = EXCLUDED.bid,
                        ask = EXCLUDED.ask,
                        bid_size = EXCLUDED.bid_size,
                        ask_size = EXCLUDED.ask_size,
                        source = EXCLUDED.source
                    RETURNING 1
                """))
                
                return result.rowcount
                
        except Exception as e:
            self.logger.error(f"Failed to insert batch of {len(ticks)} ticks: {e}")
            raise
    
    def catchup_gap(self, symbol: str, from_time: datetime, to_time: datetime) -> Dict[str, int]:
        """
        Fill data gap for a specific symbol and time range using concurrent downloads
        Intelligently uses daily files when fetching full days to reduce requests by 24x
        
        Returns:
            Dict with statistics: {'ticks_inserted': n, 'hours_processed': n}
        """
        stats = {'ticks_inserted': 0, 'hours_processed': 0}
        
        # Ensure we're working with UTC
        if from_time.tzinfo is None:
            from_time = from_time.replace(tzinfo=timezone.utc)
        if to_time.tzinfo is None:
            to_time = to_time.replace(tzinfo=timezone.utc)
        
        self.logger.info(f"Starting catchup for {symbol} from {from_time} to {to_time}")
        
        # Smart download planning: use daily files for full days, hourly for partial
        downloads_to_fetch = []
        current = from_time.replace(minute=0, second=0, microsecond=0)
        
        while current <= to_time:
            # Check if we can fetch a full day
            day_start = current.replace(hour=0)
            day_end = day_start + timedelta(days=1) - timedelta(seconds=1)
            
            # If current is at start of day AND we need the whole day
            if current == day_start and day_end <= to_time:
                # Fetch daily file (24x fewer requests!)
                downloads_to_fetch.append({
                    'date': current,
                    'hour': None,
                    'daily': True,
                    'expected_hours': 24
                })
                current = day_start + timedelta(days=1)
                self.logger.info(f"Using daily file for {day_start.date()}")
            else:
                # Fetch hourly file
                downloads_to_fetch.append({
                    'date': current,
                    'hour': current.hour,
                    'daily': False,
                    'expected_hours': 1
                })
                current += timedelta(hours=1)
        
        # Calculate total "hours" for progress (daily = 24 hours)
        total_hours = sum(d['expected_hours'] for d in downloads_to_fetch)
        progress = ProgressReporter(total_hours)
        
        self.logger.info(f"Fetching {len(downloads_to_fetch)} files ({total_hours} hours of data)")
        
        # Process downloads concurrently
        tick_buffer = []
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # Submit all download tasks
            future_to_download = {
                executor.submit(
                    self.download_bi5_file, 
                    symbol, 
                    dl['date'], 
                    dl['hour'],
                    dl['daily']
                ): dl
                for dl in downloads_to_fetch
            }
            
            # Process completed downloads
            for future in as_completed(future_to_download):
                if self.shutdown:
                    executor.shutdown(wait=False)
                    break
                    
                dl_info = future_to_download[future]
                
                try:
                    compressed_data, date, hour = future.result()
                    
                    if compressed_data:
                        # Parse ticks - base time is always the date (at 00:00)
                        base_time = date.replace(hour=0) if dl_info['daily'] else date
                        ticks = self.parse_bi5_data(
                            compressed_data, 
                            symbol, 
                            base_time
                        )
                        
                        # Filter ticks to only include those within our time range
                        filtered_ticks = [
                            tick for tick in ticks 
                            if from_time <= tick['time'] <= to_time
                        ]
                        
                        if filtered_ticks:
                            tick_buffer.extend(filtered_ticks)
                            progress.update(hours=dl_info['expected_hours'], ticks=len(filtered_ticks))
                        else:
                            progress.update(hours=dl_info['expected_hours'])
                    else:
                        progress.update(hours=dl_info['expected_hours'])
                    
                    # Insert batch if buffer is full
                    if len(tick_buffer) >= self.batch_size:
                        inserted = self.insert_batch(tick_buffer[:self.batch_size])
                        stats['ticks_inserted'] += inserted
                        tick_buffer = tick_buffer[self.batch_size:]
                        
                except Exception as e:
                    self.logger.error(f"Failed to process {dl_info}: {e}")
                    progress.update(failed_hour=f"{date.isoformat()}")
                
                stats['hours_processed'] += dl_info['expected_hours']
        
        # Insert remaining ticks
        if tick_buffer and not self.shutdown:
            inserted = self.insert_batch(tick_buffer)
            stats['ticks_inserted'] += inserted
        
        # Trigger cascade refresh after catchup (if not interrupted)
        if not self.shutdown and stats['ticks_inserted'] > 0:
            try:
                with self.engine.begin() as conn:
                    # For large imports, do batched refresh (weekly chunks)
                    if (to_time - from_time).days > 7:
                        current = from_time
                        while current < to_time:
                            next_refresh = min(current + timedelta(days=7), to_time)
                            conn.execute(text("""
                                SELECT cascade_forex_aggregate_refresh(:symbol, :start_time::timestamptz)
                            """), {'symbol': symbol, 'start_time': current})
                            current = next_refresh
                            self.logger.info(f"Triggered cascade refresh for {symbol} from {current}")
                    else:
                        conn.execute(text("""
                            SELECT cascade_forex_aggregate_refresh(:symbol, :start_time::timestamptz)
                        """), {'symbol': symbol, 'start_time': from_time})
                        self.logger.info(f"Triggered cascade refresh for {symbol}")
                        
            except Exception as e:
                self.logger.error(f"Failed to trigger cascade refresh: {e}")
        
        # Final progress report
        progress.final_report(stats['ticks_inserted'])
        
        return stats


def validate_timerange(from_time: datetime, to_time: datetime) -> None:
    """Validate the requested time range"""
    if from_time >= to_time:
        raise ValueError("from_time must be before to_time")
    
    # Warn for very large ranges
    days_diff = (to_time - from_time).days
    if days_diff > 30:
        logger.warning(f"Large time range requested: {days_diff} days. This may take a while.")
    
    # Check if requesting future data
    now = datetime.now(timezone.utc)
    if from_time > now:
        raise ValueError("Cannot fetch future data")


def main():
    parser = argparse.ArgumentParser(
        description='Catchup for historical forex data gaps'
    )
    parser.add_argument(
        '--symbol', 
        required=True,
        help='Symbol to catch up (e.g., EURUSD)'
    )
    parser.add_argument(
        '--from',
        dest='from_time',
        required=True,
        help='Start time in ISO format (e.g., 2024-01-15T10:30:00Z)'
    )
    parser.add_argument(
        '--to',
        dest='to_time',
        required=False,
        help='End time in ISO format (defaults to now)'
    )
    parser.add_argument(
        '--db-url',
        help='Database URL (defaults to DATABASE_URL env var)'
    )
    parser.add_argument(
        '--workers',
        type=int,
        default=25,
        help='Number of concurrent download workers (default: 25)'
    )
    parser.add_argument(
        '--batch-size',
        type=int,
        default=1_000_000,
        help='Number of ticks per database batch (default: 1000000)'
    )
    
    args = parser.parse_args()
    
    # Parse times
    try:
        from_time = datetime.fromisoformat(args.from_time.replace('Z', '+00:00'))
    except ValueError:
        error_msg = {"type": "error", "message": f"Invalid from time format: {args.from_time}"}
        print(json.dumps(error_msg), flush=True)
        sys.exit(1)
    
    if args.to_time:
        try:
            to_time = datetime.fromisoformat(args.to_time.replace('Z', '+00:00'))
        except ValueError:
            error_msg = {"type": "error", "message": f"Invalid to time format: {args.to_time}"}
            print(json.dumps(error_msg), flush=True)
            sys.exit(1)
    else:
        to_time = datetime.now(timezone.utc)
    
    # Validate time range
    try:
        validate_timerange(from_time, to_time)
    except ValueError as e:
        error_msg = {"type": "error", "message": str(e)}
        print(json.dumps(error_msg), flush=True)
        sys.exit(1)
    
    # Create ingester and run catchup
    ingester = CatchupIngester(
        args.db_url,
        max_workers=args.workers,
        batch_size=args.batch_size
    )
    
    try:
        stats = ingester.catchup_gap(args.symbol, from_time, to_time)
        sys.exit(0 if stats['ticks_inserted'] > 0 else 1)
    except Exception as e:
        error_msg = {"type": "error", "message": f"Catchup failed: {str(e)}"}
        print(json.dumps(error_msg), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()