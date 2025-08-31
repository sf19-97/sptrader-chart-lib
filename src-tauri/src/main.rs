#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{Mutex, RwLock};
use tauri::{State, Builder, Manager, WindowEvent, Emitter};

mod market_data;
mod candle_monitor;
mod candles;

use market_data::symbols::CachedMetadata;
use market_data::commands::*;

#[derive(Clone, Debug, Serialize)]
struct LogEvent {
    timestamp: String,
    level: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Candle {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: i64,  // Note: This is tick_count (number of price updates), not traded volume
}

#[derive(Debug, Deserialize)]
struct DataRequest {
    symbol: String,
    timeframe: String,
    from: i64,
    to: i64,
}

struct AppState {
    db_pool: Arc<Mutex<sqlx::PgPool>>,
    candle_cache: Arc<RwLock<HashMap<String, CachedCandles>>>,
    market_candle_cache: candles::cache::CandleCache,  // Cache for MarketCandle (string-based)
    metadata_cache: Arc<RwLock<HashMap<String, CachedMetadata>>>,
    // Candle update monitors
    candle_monitors: Arc<Mutex<HashMap<String, Arc<candle_monitor::CandleUpdateMonitor>>>>,
}

#[derive(Clone)]
struct CachedCandles {
    data: Vec<Candle>,
    cached_at: i64,
}

// Helper function to emit log events to frontend
fn emit_log<R: tauri::Runtime>(window: &impl Emitter<R>, level: &str, message: &str) {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let event = LogEvent {
        timestamp,
        level: level.to_string(),
        message: message.to_string(),
    };
    
    // Still print to console for debugging
    println!("[{}] {}", level, message);
    
    // Emit to frontend
    window.emit("backend-log", &event).ok();
}

#[tauri::command]
async fn fetch_candles(
    request: DataRequest,
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<Candle>, String> {
    // Create cache key
    let cache_key = format!("{}-{}-{}-{}", request.symbol, request.timeframe, request.from, request.to);
    let current_time = chrono::Utc::now().timestamp();
    
    // Try to get from cache first
    {
        let cache = state.candle_cache.read().await;
        if let Some(cached) = cache.get(&cache_key) {
            // Check if cache is still fresh (10 minutes)
            if current_time - cached.cached_at < 600 {
                emit_log(&window, "DEBUG", &format!("[CACHE HIT] Returning cached data for {}", cache_key));
                return Ok(cached.data.clone());
            }
        }
    }
    
    emit_log(&window, "DEBUG", &format!("[CACHE MISS] Fetching from database for {}", cache_key));
    
    let table_name = match request.timeframe.as_str() {
        "15m" => "forex_candles_15m",
        "1h" => "forex_candles_1h",
        "4h" => "forex_candles_4h",
        "12h" => "forex_candles_12h",
        _ => return Err(format!("Invalid timeframe: {}", request.timeframe)),
    };

    let query = format!(
        "SELECT
            time,
            open::FLOAT8 as open,
            high::FLOAT8 as high,
            low::FLOAT8 as low,
            close::FLOAT8 as close,
            tick_count::INT8 as volume  -- Volume is tick count (number of price updates), not traded volume
         FROM {} 
         WHERE symbol = $1
           AND time >= to_timestamp($2)
           AND time <= to_timestamp($3)
         ORDER BY time",
        table_name
    );

    emit_log(&window, "DEBUG", &format!("[FETCH_CANDLES] Query: {}", query));
    emit_log(&window, "DEBUG", &format!("[FETCH_CANDLES] Params: symbol={}, from={}, to={}",
             request.symbol, request.from, request.to));

    let pool = state.db_pool.lock().await;
    let rows = sqlx::query_as::<_, (chrono::DateTime<chrono::Utc>, f64, f64, f64, f64, i64)>(&query)
        .bind(&request.symbol)
        .bind(request.from)
        .bind(request.to)
        .fetch_all(&*pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?;

    let candles: Vec<Candle> = rows.into_iter().map(|(time, open, high, low, close, volume)| Candle {
        time: time.timestamp(),
        open,
        high,
        low,
        close,
        volume,
    }).collect();
    
    // Update cache with new data
    {
        let mut cache = state.candle_cache.write().await;
        
        // Simple LRU: if cache is full (>100 entries), remove oldest
        if cache.len() >= 100 {
            // Find the oldest entry
            if let Some(oldest_key) = cache.iter()
                .min_by_key(|(_, v)| v.cached_at)
                .map(|(k, _)| k.clone()) {
                cache.remove(&oldest_key);
                emit_log(&window, "DEBUG", &format!("[CACHE EVICT] Removed oldest entry: {}", oldest_key));
            }
        }
        
        cache.insert(cache_key.clone(), CachedCandles {
            data: candles.clone(),
            cached_at: current_time,
        });
        emit_log(&window, "DEBUG", &format!("[CACHE UPDATE] Stored {} candles for {}", candles.len(), cache_key));
    }
    
    Ok(candles)
}

#[tokio::main]
async fn main() {
    env_logger::init();
    
    // Database connection
    let database_url = "postgresql://postgres@localhost:5432/forex_trading";
    // Database connection logging will be done after we have window access
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
        .expect("Failed to connect to database");

    // Pre-warm the database connection and caches with a more realistic query
    // This loads actual data pages and indexes that will be used
    let three_months_ago = chrono::Utc::now().timestamp() - (90 * 24 * 60 * 60);
    match sqlx::query(
        "SELECT time, open, high, low, close, tick_count 
         FROM forex_candles_1h 
         WHERE symbol = 'EURUSD' 
           AND time >= to_timestamp($1)
         ORDER BY time
         LIMIT 100"
    )
        .bind(three_months_ago)
        .fetch_all(&pool)
        .await {
        Ok(_) => {
            // Connection is warm, caches are primed with actual data pages
        },
        Err(e) => {
            eprintln!("Warning: Failed to pre-warm database connection: {}", e);
            // Non-fatal - continue with cold connection
        }
    }
    
    // Pre-warm metadata queries for common symbols using optimized queries
    println!("[INFO] Pre-warming metadata cache...");
    let symbols = vec!["EURUSD", "USDJPY"];
    for symbol in symbols {
        // Pre-warm MIN query
        let _ = sqlx::query("SELECT time FROM forex_ticks WHERE symbol = $1 ORDER BY time ASC LIMIT 1")
            .bind(symbol)
            .fetch_optional(&pool)
            .await;
            
        // Pre-warm MAX query
        let _ = sqlx::query("SELECT time FROM forex_ticks WHERE symbol = $1 ORDER BY time DESC LIMIT 1")
            .bind(symbol)
            .fetch_optional(&pool)
            .await;
            
        // Pre-warm COUNT query
        match sqlx::query("SELECT COUNT(*) FROM forex_ticks WHERE symbol = $1")
            .bind(symbol)
            .fetch_optional(&pool)
            .await {
            Ok(_) => {
                println!("[INFO] Pre-warmed metadata for {}", symbol);
            },
            Err(e) => {
                eprintln!("Warning: Failed to pre-warm metadata for {}: {}", symbol, e);
            }
        }
    }
    
    // Initialize market data engine
    let market_data_state = market_data::commands::init_market_data_engine(pool.clone());
    
    let app_state = AppState { 
        db_pool: Arc::new(Mutex::new(pool)),
        candle_cache: Arc::new(RwLock::new(HashMap::new())),
        market_candle_cache: candles::cache::create_cache(),  // Initialize the market candle cache
        metadata_cache: Arc::new(RwLock::new(HashMap::new())),
        candle_monitors: Arc::new(Mutex::new(HashMap::new())),
    };

    Builder::default()
        .manage(app_state)
        .manage(market_data_state)
        .invoke_handler(tauri::generate_handler![
            fetch_candles,
            market_data::symbols::commands::get_available_data,
            market_data::symbols::commands::get_all_available_symbols,
            market_data::symbols::commands::get_symbol_metadata,
            // Candle monitor commands
            candle_monitor::start_candle_monitor,
            candle_monitor::stop_candle_monitor,
            candle_monitor::trigger_candle_update,
            // Market data commands
            search_assets,
            add_market_asset,
            get_pipeline_status,
            list_active_pipelines,
            stop_pipeline,
            save_pipeline_config,
            load_pipeline_config,
            check_data_gaps,
            mark_restore_completed,
            // Candles module commands
            candles::commands::get_market_candles
        ])
        .setup(|app| {
            // Get the main window handle
            let window = app.get_webview_window("main").expect("Failed to get main window");
            
            // Now we can log the database connection
            emit_log(&window, "INFO", &format!("Connecting to database: {}", "postgresql://postgres@localhost:5432/forex_trading"));
            emit_log(&window, "SUCCESS", "Database connected successfully");
            emit_log(&window, "INFO", "Connection pool established (10 connections)");
            
            // Show window fullscreen
            window.show()?;
            window.set_fullscreen(true)?;
            
            Ok(())
        })
        .on_window_event(|window, event| {
            // Handle window close event
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
                
                // Save market data pipelines with clean shutdown flag
                let app_handle = window.app_handle();
                if let Some(market_data_state) = app_handle.try_state::<MarketDataState>() {
                    let engine = market_data_state.engine.clone();
                    tokio::spawn(async move {
                        if let Err(e) = save_final_state(engine).await {
                            eprintln!("[Shutdown] Failed to save pipeline state: {}", e);
                        } else {
                            println!("[Shutdown] Pipeline state saved successfully");
                        }
                    });
                }
                
                // Give async save a moment to complete
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::process::exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}

// Helper function to save pipeline state on shutdown
async fn save_final_state(engine: Arc<Mutex<market_data::MarketDataEngine>>) -> Result<(), String> {
    let configs = {
        let engine_lock = engine.lock().await;
        let mut configs = Vec::new();
        for (symbol, pipeline) in engine_lock.pipelines.iter() {
            let source_name = match &pipeline.config.source {
                market_data::DataSource::Oanda { .. } => "oanda",
                market_data::DataSource::Kraken { .. } => "kraken",
                market_data::DataSource::Alpaca { .. } => "alpaca",
                market_data::DataSource::Dukascopy => "dukascopy",
                market_data::DataSource::IBKR { .. } => "ibkr",
                market_data::DataSource::Coinbase { .. } => "coinbase",
            };
            
            let status = pipeline.status.lock().await;
            let last_tick_str = match &*status {
                market_data::PipelineStatus::Running { last_tick, .. } => 
                    last_tick.map(|t| t.to_rfc3339()),
                _ => None,
            };
            
            configs.push(market_data::commands::PipelineConfig {
                symbol: symbol.clone(),
                source: source_name.to_string(),
                asset_class: format!("{:?}", pipeline.config.asset_class).to_lowercase(),
                added_at: chrono::Utc::now().to_rfc3339(),
                last_tick: last_tick_str,
                profile_id: pipeline.config.profile_id.clone(),
                profile_name: pipeline.config.profile_name.clone(),
            });
        }
        configs
    };
    
    // Save with clean_shutdown flag set to true
    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("sptraderb");
    
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    
    let config_file = market_data::commands::PipelineConfigFile {
        version: 1,
        pipelines: configs,
        saved_at: chrono::Utc::now().to_rfc3339(),
        clean_shutdown: true,  // Mark as clean shutdown
    };
    
    let config_path = config_dir.join("active_pipelines.json");
    let json = serde_json::to_string_pretty(&config_file)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    std::fs::write(&config_path, json)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    
    Ok(())
}