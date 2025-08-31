// src-tauri/src/market_data/symbols.rs
// Symbol-related queries and commands for market data

use super::*;
use crate::AppState;
use serde::Serialize;
use sqlx::Row;
use tauri::{State, Window};

// Re-export for convenience
pub use self::commands::*;

// Data structures

#[derive(Clone)]
pub struct CachedMetadata {
    pub metadata: SymbolMetadata,
    pub cached_at: i64,
}


#[derive(Debug, Serialize, Clone)]
pub struct SymbolMetadata {
    pub symbol: String,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub has_data: bool,
}

#[derive(Debug, Serialize)]
pub struct AvailableDataItem {
    pub symbol: String,
    pub start_date: String,
    pub end_date: String,
    pub tick_count: i64,
    pub candle_count_5m: i64,
    pub candle_count_15m: i64,
    pub candle_count_1h: i64,
    pub candle_count_4h: i64,
    pub candle_count_12h: i64,
    pub last_updated: String,
    pub size_mb: f64,
    pub candles_up_to_date: bool,
    pub last_candle_refresh: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AvailableSymbol {
    pub symbol: String,
    pub label: String,
    pub has_data: bool,
    pub is_active: bool,
    pub last_tick: Option<String>,
    pub tick_count: Option<i64>,
    pub source: Option<String>,
}

// Helper functions

pub fn format_symbol_label(symbol: &str) -> String {
    match symbol {
        "EURUSD" => "EUR/USD".to_string(),
        "GBPUSD" => "GBP/USD".to_string(),
        "USDJPY" => "USD/JPY".to_string(),
        "AUDUSD" => "AUD/USD".to_string(),
        "USDCAD" => "USD/CAD".to_string(),
        "NZDUSD" => "NZD/USD".to_string(),
        "USDCHF" => "USD/CHF".to_string(),
        "EURJPY" => "EUR/JPY".to_string(),
        "EURGBP" => "EUR/GBP".to_string(),
        _ => {
            // Try to format forex pairs
            if symbol.len() == 6 {
                format!("{}/{}", &symbol[0..3], &symbol[3..6])
            } else {
                symbol.to_string()
            }
        }
    }
}

// Commands module
pub mod commands {
    use super::*;
    use crate::market_data::commands::MarketDataState;
    
    #[tauri::command]
    pub async fn get_all_available_symbols(
        state: State<'_, AppState>,
        market_data_state: State<'_, MarketDataState>,
    ) -> Result<Vec<AvailableSymbol>, String> {
        let mut symbols_map = std::collections::HashMap::new();
        
        // Get symbols from database
        let pool = state.db_pool.lock().await;
        
        // Query forex_ticks - optimized to avoid COUNT(*)
        let forex_query = r#"
            SELECT DISTINCT symbol, MAX(time) as last_tick
            FROM forex_ticks
            GROUP BY symbol
            ORDER BY symbol
        "#;
        
        let forex_rows = sqlx::query(forex_query)
            .fetch_all(&*pool)
            .await
            .map_err(|e| format!("Failed to query forex symbols: {}", e))?;
        
        for row in forex_rows {
            let symbol: String = row.try_get("symbol").unwrap_or_default();
            let last_tick: Option<chrono::DateTime<chrono::Utc>> = row.try_get("last_tick").ok();
            
            symbols_map.insert(symbol.clone(), AvailableSymbol {
                symbol: symbol.clone(),
                label: format_symbol_label(&symbol),
                has_data: true,
                is_active: false,
                last_tick: last_tick.map(|t| t.to_rfc3339()),
                tick_count: None, // Skip expensive COUNT(*)
                source: Some("forex".to_string()),
            });
        }
        

        
        // Get active pipelines from market data engine
        let engine = market_data_state.engine.lock().await;
        for (symbol, pipeline) in engine.pipelines.iter() {
            let status = pipeline.status.lock().await;
            let (is_active, last_tick) = match &*status {
                PipelineStatus::Running { connected, last_tick } => (*connected, last_tick.map(|t| t.to_rfc3339())),
                _ => (false, None),
            };
            
            let source_name = match &pipeline.config.source {
                DataSource::Kraken { .. } => "kraken",
                DataSource::Oanda { .. } => "oanda",
                DataSource::Alpaca { .. } => "alpaca",
                DataSource::Dukascopy => "dukascopy",
                DataSource::IBKR { .. } => "ibkr",
                DataSource::Coinbase { .. } => continue, // Skip Coinbase pipelines
            };
            
            if let Some(existing) = symbols_map.get_mut(symbol) {
                existing.is_active = is_active;
                if existing.last_tick.is_none() {
                    existing.last_tick = last_tick;
                }
            } else {
                symbols_map.insert(symbol.clone(), AvailableSymbol {
                    symbol: symbol.clone(),
                    label: format_symbol_label(symbol),
                    has_data: false,
                    is_active,
                    last_tick,
                    tick_count: None,
                    source: Some(source_name.to_string()),
                });
            }
        }
        
        // Convert to sorted vector
        let mut result: Vec<AvailableSymbol> = symbols_map.into_values().collect();
        result.sort_by(|a, b| a.symbol.cmp(&b.symbol));
        
        Ok(result)
    }

    #[tauri::command]
    pub async fn get_symbol_metadata(
        symbol: String,
        state: State<'_, AppState>,
    ) -> Result<SymbolMetadata, String> {
        let current_time = chrono::Utc::now().timestamp();
        
        // Check cache first
        {
            let cache = state.metadata_cache.read().await;
            if let Some(cached) = cache.get(&symbol) {
                // Metadata cache can be valid for longer (5 minutes)
                if current_time - cached.cached_at < 300 {
                    // Cache hit - return cached metadata
                    return Ok(cached.metadata.clone());
                }
            }
        }
        
        let pool = state.db_pool.lock().await;
        
        // Optimized queries using the index efficiently
        // First, get the earliest tick
        let min_query = "SELECT time FROM forex_ticks WHERE symbol = $1 ORDER BY time ASC LIMIT 1";
        let min_result = sqlx::query(min_query)
            .bind(&symbol)
            .fetch_optional(&*pool)
            .await
            .map_err(|e| format!("Database error: {}", e))?;
        
        // Then, get the latest tick
        let max_query = "SELECT time FROM forex_ticks WHERE symbol = $1 ORDER BY time DESC LIMIT 1";
        let max_result = sqlx::query(max_query)
            .bind(&symbol)
            .fetch_optional(&*pool)
            .await
            .map_err(|e| format!("Database error: {}", e))?;
        
        if let (Some(min_row), Some(max_row)) = (min_result, max_result) {
            let start_time: chrono::DateTime<chrono::Utc> = min_row.try_get("time").unwrap();
            let end_time: chrono::DateTime<chrono::Utc> = max_row.try_get("time").unwrap();
            
            let metadata = SymbolMetadata {
                symbol: symbol.clone(),
                start_timestamp: start_time.timestamp(),
                end_timestamp: end_time.timestamp(),
                has_data: true,
            };
            
            // Update cache
            {
                let mut cache = state.metadata_cache.write().await;
                cache.insert(symbol.clone(), crate::CachedMetadata {
                    metadata: metadata.clone(),
                    cached_at: current_time,
                });
            }
            
            Ok(metadata)
        } else {
            Ok(SymbolMetadata {
                symbol,
                start_timestamp: 0,
                end_timestamp: 0,
                has_data: false,
            })
        }
    }

    #[tauri::command]
    pub async fn get_available_data(
        state: State<'_, AppState>,
        _window: Window,
    ) -> Result<Vec<AvailableDataItem>, String> {
        
        let pool = state.db_pool.lock().await;
        
        // Query to get summary of available data
        let query = r#"
            WITH tick_summary AS (
                SELECT 
                    symbol,
                    MIN(time)::date as start_date,
                    MAX(time)::date as end_date,
                    COUNT(*) as tick_count,
                    MAX(time) as last_updated
                FROM forex_ticks
                GROUP BY symbol
            ),
            candle_summary AS (
                SELECT
                    symbol,
                    COUNT(CASE WHEN time > NOW() - INTERVAL '7 days' THEN 1 END) as candle_count_5m
                FROM forex_candles_5m
                GROUP BY symbol
            ),
            candle_15m AS (
                SELECT
                    symbol,
                    COUNT(CASE WHEN time > NOW() - INTERVAL '14 days' THEN 1 END) as candle_count_15m
                FROM forex_candles_15m
                GROUP BY symbol
            ),
            candle_1h AS (
                SELECT
                    symbol,
                    COUNT(CASE WHEN time > NOW() - INTERVAL '30 days' THEN 1 END) as candle_count_1h
                FROM forex_candles_1h
                GROUP BY symbol
            ),
            candle_4h AS (
                SELECT
                    symbol,
                    COUNT(CASE WHEN time > NOW() - INTERVAL '90 days' THEN 1 END) as candle_count_4h
                FROM forex_candles_4h
                GROUP BY symbol
            ),
            candle_12h AS (
                SELECT
                    symbol,
                    COUNT(*) as candle_count_12h
                FROM forex_candles_12h
                GROUP BY symbol
            ),
            refresh_info AS (
                SELECT 
                    symbol,
                    MAX(last_refresh) as last_candle_refresh
                FROM candle_refresh_log
                GROUP BY symbol
            )
            SELECT 
                t.symbol,
                t.start_date::text,
                t.end_date::text,
                t.tick_count,
                COALESCE(c5.candle_count_5m, 0) as candle_count_5m,
                COALESCE(c15.candle_count_15m, 0) as candle_count_15m,
                COALESCE(c1h.candle_count_1h, 0) as candle_count_1h,
                COALESCE(c4h.candle_count_4h, 0) as candle_count_4h,
                COALESCE(c12h.candle_count_12h, 0) as candle_count_12h,
                t.last_updated::text,
                ROUND((t.tick_count * 80.0 / 1024 / 1024)::numeric, 2) as size_mb,
                CASE 
                    WHEN r.last_candle_refresh IS NOT NULL AND 
                         r.last_candle_refresh > NOW() - INTERVAL '1 hour' 
                    THEN true 
                    ELSE false 
                END as candles_up_to_date,
                r.last_candle_refresh::text
            FROM tick_summary t
            LEFT JOIN candle_summary c5 ON t.symbol = c5.symbol
            LEFT JOIN candle_15m c15 ON t.symbol = c15.symbol
            LEFT JOIN candle_1h c1h ON t.symbol = c1h.symbol
            LEFT JOIN candle_4h c4h ON t.symbol = c4h.symbol
            LEFT JOIN candle_12h c12h ON t.symbol = c12h.symbol
            LEFT JOIN refresh_info r ON t.symbol = r.symbol
            ORDER BY t.symbol
        "#;
        
        let rows = sqlx::query(query)
            .fetch_all(&*pool)
            .await
            .map_err(|e| format!("Failed to query available data: {}", e))?;
        
        let mut result = Vec::new();
        for row in rows {
            result.push(AvailableDataItem {
                symbol: row.try_get("symbol").unwrap_or_default(),
                start_date: row.try_get("start_date").unwrap_or_default(),
                end_date: row.try_get("end_date").unwrap_or_default(),
                tick_count: row.try_get("tick_count").unwrap_or(0),
                candle_count_5m: row.try_get("candle_count_5m").unwrap_or(0),
                candle_count_15m: row.try_get("candle_count_15m").unwrap_or(0),
                candle_count_1h: row.try_get("candle_count_1h").unwrap_or(0),
                candle_count_4h: row.try_get("candle_count_4h").unwrap_or(0),
                candle_count_12h: row.try_get("candle_count_12h").unwrap_or(0),
                last_updated: row.try_get("last_updated").unwrap_or_default(),
                size_mb: row.try_get("size_mb").unwrap_or(0.0),
                candles_up_to_date: row.try_get("candles_up_to_date").unwrap_or(false),
                last_candle_refresh: row.try_get("last_candle_refresh").ok(),
            });
        }
        
        Ok(result)
    }
}