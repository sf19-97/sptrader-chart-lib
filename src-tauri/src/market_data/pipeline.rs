// src-tauri/src/market_data/pipeline.rs

use super::*;
use sqlx::postgres::PgPool;
use std::time::Duration;
use chrono::Timelike;

impl AssetPipeline {
    pub async fn start(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        
        // Update status
        {
            let mut status = self.status.lock().await;
            *status = PipelineStatus::Starting;
        }
        
        // Connect ingester
        if let Some(ref mut ingester) = self.ingester {
            ingester.connect().await?;
            
            // Subscribe to symbol
            ingester.subscribe(vec![self.config.symbol.clone()]).await?;
        } else {
            return Err("Ingester not available".into());
        }
        
        // Start ingestion loop in background
        let symbol = self.config.symbol.clone();
        let tick_table = self.config.tick_table.clone();
        let db_pool = self.db_pool.clone();
        let status_arc = self.status.clone();
        let mut ingester = self.ingester.take().ok_or("Ingester already taken")?;
        
        tokio::spawn(async move {
            let mut batch: Vec<MarketTick> = Vec::new();
            let mut last_flush = std::time::Instant::now();
            let batch_size = 100;
            let flush_interval = Duration::from_secs(5);
            
            loop {
                match ingester.next_tick().await {
                    Ok(tick) => {
                        // Update last tick time in status
                        {
                            let mut status = status_arc.lock().await;
                            if let PipelineStatus::Running { ref mut last_tick, .. } = *status {
                                *last_tick = Some(tick.time);
                            }
                        }
                        
                        batch.push(tick);
                        
                        // Flush if batch is full or time elapsed
                        if batch.len() >= batch_size || last_flush.elapsed() > flush_interval {
                            if let Err(e) = flush_batch(&db_pool, &tick_table, &batch).await {
                                eprintln!("[MarketData] Error flushing batch: {}", e);
                            }
                            batch.clear();
                            last_flush = std::time::Instant::now();
                        }
                    }
                    Err(e) => {
                        eprintln!("[MarketData] Error getting tick: {}", e);
                        drop(e); // Drop the error before await
                        // Try to reconnect
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        if let Err(reconnect_err) = ingester.connect().await {
                            eprintln!("[MarketData] Reconnection failed: {}", reconnect_err);
                        } else {
                            // Re-subscribe after successful reconnection
                            if let Err(sub_err) = ingester.subscribe(vec![symbol.clone()]).await {
                                eprintln!("[MarketData] Re-subscription failed: {}", sub_err);
                            } else {
                                println!("[MarketData] Reconnected to {}", symbol);
                            }
                        }
                    }
                }
            }
        });
        
        {
            let mut status = self.status.lock().await;
            *status = PipelineStatus::Running { 
                connected: true, 
                last_tick: Some(Utc::now()) 
            };
        }
        
        Ok(())
    }
}

async fn flush_batch(
    pool: &PgPool,
    table: &str,
    batch: &[MarketTick]
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if batch.is_empty() {
        return Ok(());
    }
    
    // Build bulk insert query
    let mut query = format!(
        "INSERT INTO {} (time, symbol, source, bid, ask) VALUES ",
        table
    );
    
    for (i, _tick) in batch.iter().enumerate() {
        if i > 0 {
            query.push_str(", ");
        }
        query.push_str(&format!(
            "(${}, ${}, ${}, ${}, ${})",
            i * 5 + 1,
            i * 5 + 2,
            i * 5 + 3,
            i * 5 + 4,
            i * 5 + 5,
        ));
    }
    
    query.push_str(" ON CONFLICT (symbol, time) DO NOTHING");
    
    // Execute the batch insert
    let mut query_builder = sqlx::query(&query);
    
    // Bind all values in the correct order
    for tick in batch {
        query_builder = query_builder
            .bind(tick.time)
            .bind(&tick.symbol)
            .bind(&tick.source)
            .bind(tick.bid)
            .bind(tick.ask);
    }
    
    query_builder.execute(pool).await?;
    
    Ok(())
}

impl PipelineBuilder {
    #[allow(dead_code)]
    async fn create_schema_detailed(
        &self,
        tick_table: &str,
        aggregate_tables: &[(String, String)],
        cascade_procedure: &str,
        source: &DataSource,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Get source-specific columns
        let extra_columns = match source {
            DataSource::Kraken { .. } => {
                "side CHAR(1),
                 trade_id BIGINT,"
            },
            DataSource::Oanda { .. } => {
                "spread NUMERIC(10,5),
                 tradeable BOOLEAN,
                 closeout_bid NUMERIC(12,5),
                 closeout_ask NUMERIC(12,5),"
            },
            _ => "",
        };
        
        // Create tick table
        let create_tick_table = format!(
            "CREATE TABLE IF NOT EXISTS {} (
                time TIMESTAMPTZ NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                source VARCHAR(20) NOT NULL,
                bid NUMERIC(20,10),
                ask NUMERIC(20,10),
                last NUMERIC(20,10),
                volume NUMERIC(20,10),
                {}
                spread NUMERIC(10,5) GENERATED ALWAYS AS (ask - bid) STORED,
                mid_price NUMERIC(20,10) GENERATED ALWAYS AS ((bid + ask) / 2) STORED,
                PRIMARY KEY (symbol, source, time)
            )",
            tick_table,
            extra_columns
        );
        
        sqlx::query(&create_tick_table).execute(&self.db_pool).await?;
        
        // Convert to hypertable
        let create_hypertable = format!(
            "SELECT create_hypertable('{}', 'time', if_not_exists => TRUE)",
            tick_table
        );
        sqlx::query(&create_hypertable).execute(&self.db_pool).await?;
        
        // Create continuous aggregates
        for (i, (table_name, timeframe)) in aggregate_tables.iter().enumerate() {
            let interval = match timeframe.as_str() {
                "1m" => "1 minute",
                "5m" => "5 minutes",
                "15m" => "15 minutes",
                "1h" => "1 hour",
                "4h" => "4 hours",
                "12h" => "12 hours",
                _ => continue,
            };
            
            // Determine source table (hierarchical aggregation)
            let source_table = if i == 0 {
                tick_table.to_string()
            } else {
                match timeframe.as_str() {
                    "5m" => tick_table.to_string(), // From ticks
                    "15m" => aggregate_tables[1].0.clone(), // From 5m
                    "1h" => aggregate_tables[2].0.clone(),  // From 15m
                    "4h" => aggregate_tables[3].0.clone(),  // From 1h
                    "12h" => aggregate_tables[4].0.clone(), // From 4h
                    _ => tick_table.to_string(),
                }
            };
            
            let create_aggregate = format!(
                "CREATE MATERIALIZED VIEW IF NOT EXISTS {}
                WITH (timescaledb.continuous) AS
                SELECT 
                    time_bucket('{}', time) AS time,
                    symbol,
                    first(bid, time) AS open,
                    max(bid) AS high,
                    min(bid) AS low,
                    last(bid, time) AS close,
                    count(*) AS tick_count
                FROM {}
                GROUP BY time_bucket('{}', time), symbol
                WITH NO DATA",
                table_name,
                interval,
                source_table,
                interval
            );
            
            sqlx::query(&create_aggregate).execute(&self.db_pool).await?;
        }
        
        // Create cascade refresh procedure
        let mut cascade_body = String::from("BEGIN\n");
        cascade_body.push_str("    RAISE NOTICE 'Starting cascade refresh at %', NOW();\n");
        
        for (table_name, _) in aggregate_tables {
            cascade_body.push_str(&format!(
                "    CALL refresh_continuous_aggregate('{}', NULL, NULL);\n",
                table_name
            ));
        }
        
        cascade_body.push_str("    RAISE NOTICE 'Cascade refresh complete at %', NOW();\n");
        cascade_body.push_str("END;");
        
        let create_procedure = format!(
            "CREATE OR REPLACE PROCEDURE {}()
            LANGUAGE plpgsql
            AS $$
            {}
            $$",
            cascade_procedure,
            cascade_body
        );
        
        sqlx::query(&create_procedure).execute(&self.db_pool).await?;
        
        Ok(())
    }
}

impl CascadeScheduler {
    pub async fn schedule_cascade(&mut self, procedure_name: String, interval_seconds: u64) {
        // Cancel existing schedule if any
        if let Some(handle) = self.intervals.remove(&procedure_name) {
            handle.abort();
        }
        
        let db_pool = self.db_pool.clone();
        let procedure = procedure_name.clone();
        
        // Spawn cascade refresh task
        let handle = tokio::spawn(async move {
            // Calculate initial delay to align with clock
            let now = chrono::Local::now();
            let current_second = now.second();
            let targets = [1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56];
            
            let next_target = targets.iter()
                .find(|&&t| t > current_second)
                .copied()
                .unwrap_or(targets[0] + 60);
            
            let delay_seconds = if next_target > 60 {
                (next_target - 60).saturating_sub(current_second)
            } else {
                next_target.saturating_sub(current_second)
            };
            
            tokio::time::sleep(Duration::from_secs(delay_seconds as u64)).await;
            
            // Now run on schedule
            let mut interval = tokio::time::interval(Duration::from_secs(interval_seconds));
            
            loop {
                interval.tick().await;
                
                
                if let Err(e) = sqlx::query(&format!("CALL {}()", procedure))
                    .execute(&db_pool)
                    .await
                {
                    eprintln!("[MarketData] Error running cascade refresh: {}", e);
                }
            }
        });
        
        self.intervals.insert(procedure_name, handle);
    }
}