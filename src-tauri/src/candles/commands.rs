use chrono::{DateTime, Utc};
use tauri::State;
use crate::AppState;
use super::{MarketCandle, MarketChartResponse, MarketMetadata, get_table_name, get_ticks_table};
use super::cache::CachedMarketCandles;

// Type alias for complex query result
type CandleRow = (DateTime<Utc>, String, String, String, String, Option<i64>);

#[tauri::command]
pub async fn get_market_candles(
    state: State<'_, AppState>,
    symbol: String,
    timeframe: String,
    from: i64,
    to: i64,
) -> Result<MarketChartResponse, String> {
    // CRITICAL CACHE FIX: Normalize timestamps to prevent cache misses
    // Problem: Frontend sends slightly different timestamps on each request (e.g., Date.now())
    // Solution: Round timestamps to predictable boundaries based on timeframe
    // This ensures requests within the same time window hit the same cache entry
    
    // Example: For 1h timeframe with 2-hour normalization:
    // - Request at 10:00:00 → normalized to 10:00:00
    // - Request at 10:30:00 → normalized to 10:00:00 (same cache key!)
    // - Request at 11:59:59 → normalized to 10:00:00 (still same cache key!)
    let normalization_factor = match timeframe.as_str() {
        "1m" => 300,      // 5 minutes - prevents new cache entry every few seconds
        "5m" => 900,      // 15 minutes - good for 5-min periodic refreshes
        "15m" => 3600,    // 1 hour - reasonable window for 15-min data
        "1h" => 7200,     // 2 hours - covers multiple refresh cycles
        "4h" => 14400,    // 4 hours - aligns with timeframe
        "12h" => 43200,   // 12 hours - aligns with timeframe
        _ => 3600,        // Default to 1 hour
    };
    
    let normalized_from = (from / normalization_factor) * normalization_factor;
    let normalized_to = (to / normalization_factor) * normalization_factor;
    
    // Cache key format: "SYMBOL-TIMEFRAME-NORMALIZED_FROM-NORMALIZED_TO"
    // Example: "EURUSD-1h-1754784000-1754870400"
    let cache_key = format!("{}-{}-{}-{}", symbol, timeframe, normalized_from, normalized_to);
    let current_time = chrono::Utc::now().timestamp();
    
    // Try to get from cache first
    {
        let cache = state.market_candle_cache.read().await;
        if let Some(cached) = cache.get(&cache_key) {
            // Check if cache is still fresh (10 minutes)
            if current_time - cached.cached_at < 600 {
                println!("[CACHE HIT] Returning cached market candles for {}", cache_key);
                
                // Return cached data with metadata
                return Ok(MarketChartResponse {
                    data: cached.data.clone(),
                    metadata: None, // We could cache metadata too if needed
                });
            }
        }
    }
    
    println!("[CACHE MISS] Fetching fresh market candles for {}", cache_key);
    
    // Get the correct table based on symbol
    let table_name = get_table_name(&symbol, &timeframe)?;
    
    // Get the pool from AppState
    let pool = state.db_pool.lock().await;
    
    // Convert timestamps to DateTime
    let from_time = DateTime::<Utc>::from_timestamp(from, 0)
        .ok_or_else(|| "Invalid from timestamp".to_string())?;
    let to_time = DateTime::<Utc>::from_timestamp(to, 0)
        .ok_or_else(|| "Invalid to timestamp".to_string())?;

    // Query data with date range - following exact Bitcoin pattern
    let query = format!(
        r#"
        SELECT 
            time,
            open::text,
            high::text,
            low::text,
            close::text,
            tick_count::INT8 as volume
        FROM {}
        WHERE symbol = $1
            AND time >= $2
            AND time <= $3
        ORDER BY time ASC
        "#,
        table_name
    );


    let rows: Vec<CandleRow> = 
        sqlx::query_as(&query)
            .bind(symbol.clone())
            .bind(from_time)
            .bind(to_time)
            .fetch_all(&*pool)
            .await
            .map_err(|e| format!("Database error: {}", e))?;
    

    if rows.is_empty() {
        return Ok(MarketChartResponse {
            data: vec![],
            metadata: Some(MarketMetadata {
                symbol: symbol.clone(),
                start_timestamp: 0,
                end_timestamp: 0,
                has_data: false,
            }),
        });
    }

    let candles: Vec<MarketCandle> = rows
        .into_iter()
        .map(|(time, open, high, low, close, volume)| {
            MarketCandle {
                time: time.to_rfc3339(),
                open,
                high,
                low,
                close,
                volume,
            }
        })
        .collect();

    // Get metadata from appropriate ticks table
    let ticks_table = get_ticks_table(&symbol)?;
    let metadata_query = format!(
        r#"
        SELECT 
            MIN(time) as start_time,
            MAX(time) as end_time,
            COUNT(*) as count
        FROM {}
        WHERE symbol = $1
        "#,
        ticks_table
    );

    let metadata_row: Option<(DateTime<Utc>, DateTime<Utc>, i64)> = 
        sqlx::query_as(&metadata_query)
            .bind(symbol.clone())
            .fetch_optional(&*pool)
            .await
            .map_err(|e| format!("Metadata query error: {}", e))?;

    let metadata = if let Some((start_time, end_time, _count)) = metadata_row {
        Some(MarketMetadata {
            symbol: symbol.clone(),
            start_timestamp: start_time.timestamp(),
            end_timestamp: end_time.timestamp(),
            has_data: true,
        })
    } else {
        Some(MarketMetadata {
            symbol: symbol.clone(),
            start_timestamp: 0,
            end_timestamp: 0,
            has_data: false,
        })
    };

    // Update cache with new data before returning
    {
        let mut cache = state.market_candle_cache.write().await;
        
        // Simple LRU: if cache is full (>100 entries), remove oldest
        if cache.len() >= 100 {
            // Find the oldest entry
            if let Some(oldest_key) = cache.iter()
                .min_by_key(|(_, v)| v.cached_at)
                .map(|(k, _)| k.clone()) {
                cache.remove(&oldest_key);
                println!("[CACHE EVICT] Removed oldest entry: {}", oldest_key);
            }
        }
        
        // Insert new data into cache
        cache.insert(cache_key.clone(), CachedMarketCandles {
            data: candles.clone(),
            cached_at: current_time,
        });
        println!("[CACHE UPDATE] Stored {} candles for {}", candles.len(), cache_key);
    }
    
    Ok(MarketChartResponse {
        data: candles,
        metadata,
    })
}