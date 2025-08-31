// src-tauri/src/market_data/commands.rs

use super::*;
use tauri::{State, Emitter};
use std::sync::Arc;
use tokio::sync::Mutex;

// Default historical data to fetch for new assets (2 months)
const DEFAULT_INITIAL_HISTORY_DAYS: i64 = 60;

// Add to your AppState
#[derive(Clone)]
pub struct MarketDataState {
    pub engine: Arc<Mutex<MarketDataEngine>>,
}

#[derive(Serialize, Deserialize)]
pub struct AddAssetRequest {
    pub symbol: String,
    pub source: Option<String>, // "kraken", "oanda", etc.
    pub account_id: Option<String>,
    pub api_token: Option<String>,
    pub profile_id: Option<String>, // Specific broker profile to use
    pub catchup_from: Option<String>, // ISO timestamp to catch up from
}

#[derive(Serialize, Deserialize)]
pub struct AssetSearchResult {
    pub symbol: String,
    pub name: String,
    pub asset_class: String,
    pub available_sources: Vec<String>,
    pub is_available: bool,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineStatusResponse {
    pub symbol: String,
    pub status: String,
    pub connected: bool,
    pub last_tick: Option<String>,
    pub source: String,
}

#[tauri::command]
pub async fn search_assets(
    query: String,
) -> Result<Vec<AssetSearchResult>, String> {
    let query = query.to_uppercase();
    let mut results = Vec::new();
    
    // Common forex pairs
    let forex_pairs = vec![
        ("EURUSD", "Euro / US Dollar"),
        ("GBPUSD", "British Pound / US Dollar"),
        ("USDJPY", "US Dollar / Japanese Yen"),
        ("AUDUSD", "Australian Dollar / US Dollar"),
        ("USDCAD", "US Dollar / Canadian Dollar"),
        ("NZDUSD", "New Zealand Dollar / US Dollar"),
        ("USDCHF", "US Dollar / Swiss Franc"),
    ];
    
    // Common crypto pairs
    let crypto_pairs = vec![
        ("BTCUSD", "Bitcoin / US Dollar"),
        ("ETHUSD", "Ethereum / US Dollar"),
        ("SOLUSD", "Solana / US Dollar"),
        ("AVAXUSD", "Avalanche / US Dollar"),
        ("LINKUSD", "Chainlink / US Dollar"),
        ("DOTUSD", "Polkadot / US Dollar"),
        ("MATICUSD", "Polygon / US Dollar"),
    ];
    
    // Common stocks
    let stocks = vec![
        ("AAPL", "Apple Inc."),
        ("MSFT", "Microsoft Corporation"),
        ("GOOGL", "Alphabet Inc."),
        ("AMZN", "Amazon.com Inc."),
        ("TSLA", "Tesla Inc."),
        ("META", "Meta Platforms Inc."),
        ("NVDA", "NVIDIA Corporation"),
    ];
    
    // Search forex
    for (symbol, name) in forex_pairs {
        if symbol.contains(&query) || name.to_uppercase().contains(&query) {
            results.push(AssetSearchResult {
                symbol: symbol.to_string(),
                name: name.to_string(),
                asset_class: "forex".to_string(),
                available_sources: vec!["oanda".to_string()],
                is_available: true,
            });
        }
    }
    
    // Search crypto
    for (symbol, name) in crypto_pairs {
        if symbol.contains(&query) || name.to_uppercase().contains(&query) {
            results.push(AssetSearchResult {
                symbol: symbol.to_string(),
                name: name.to_string(),
                asset_class: "crypto".to_string(),
                available_sources: vec!["kraken".to_string(), "coinbase".to_string()],
                is_available: true,
            });
        }
    }
    
    // Search stocks
    for (symbol, name) in stocks {
        if symbol.contains(&query) || name.to_uppercase().contains(&query) {
            results.push(AssetSearchResult {
                symbol: symbol.to_string(),
                name: name.to_string(),
                asset_class: "stock".to_string(),
                available_sources: vec!["alpaca".to_string()],
                is_available: true,
            });
        }
    }
    
    // If exact match not found, try to identify the asset
    if results.is_empty() && !query.is_empty() {
        if let Ok(asset_info) = AssetDiscovery::identify(&query).await {
            let sources: Vec<String> = asset_info.available_sources.iter()
                .map(|s| match s {
                    DataSource::Kraken { .. } => "kraken",
                    DataSource::Oanda { .. } => "oanda",
                    DataSource::Alpaca { .. } => "alpaca",
                    DataSource::Dukascopy => "dukascopy",
                    DataSource::IBKR { .. } => "ibkr",
                    DataSource::Coinbase { .. } => "coinbase",
                })
                .map(|s| s.to_string())
                .collect();
            
            results.push(AssetSearchResult {
                symbol: asset_info.symbol.clone(),
                name: format!("{:?} - {}", asset_info.class, asset_info.symbol),
                asset_class: format!("{:?}", asset_info.class).to_lowercase(),
                available_sources: sources,
                is_available: true,
            });
        }
    }
    
    Ok(results)
}

#[tauri::command]
pub async fn add_market_asset(
    request: AddAssetRequest,
    state: State<'_, MarketDataState>,
    window: tauri::Window,
) -> Result<String, String> {
    let mut engine = state.engine.lock().await;
    
    // Get profile information if profile_id is provided
    let (profile_id, profile_name) = if let Some(pid) = &request.profile_id {
        (Some(pid.clone()), None) // Profile name could be looked up from broker store
    } else {
        (None, None)
    };
    
    // Convert source string to DataSource enum
    let source = match request.source.as_deref() {
        Some("kraken") => Some(DataSource::Kraken { 
            api_key: None, 
            api_secret: None 
        }),
        Some("oanda") => {
            // Require credentials from the request (no env var fallback)
            match (request.account_id.clone(), request.api_token.clone()) {
                (Some(account_id), Some(api_token)) if !account_id.is_empty() && !api_token.is_empty() => {
                    Some(DataSource::Oanda { account_id, api_token })
                },
                _ => {
                    return Err("OANDA requires account_id and api_token".to_string());
                }
            }
        },
        _ => None,
    };
    
    // FIRST: Check if this is a new asset that needs historical data
    let symbol_for_check = request.symbol.clone();
    let db_pool_for_check = engine.db_pool.clone();
    
    // Check for existing data BEFORE starting pipeline
    let needs_initial_history = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM forex_ticks WHERE symbol = $1"
    )
    .bind(&symbol_for_check)
    .fetch_one(&db_pool_for_check)
    .await
    .unwrap_or(0) == 0;
    
    if needs_initial_history {
        println!("[MarketData] New asset {} detected, will download {} days of historical data after pipeline starts", 
            symbol_for_check, DEFAULT_INITIAL_HISTORY_DAYS);
    }
    
    // Add the asset (this starts the pipeline)
    match engine.add_asset(request.symbol.clone(), source, profile_id, profile_name).await {
        Ok(_) => {
            // Emit event to frontend
            window.emit("asset-added", &request.symbol).ok();
            
            // Start cascade refresh for this asset
            let cascade_procedure = engine.pipelines.get(&request.symbol)
                .map(|p| p.config.cascade_procedure.clone());
            
            if let Some(procedure) = cascade_procedure {
                engine.cascade_scheduler.schedule_cascade(
                    procedure,
                    5 // Every 5 seconds
                ).await;
            }
            
            // Now handle historical data based on what we found earlier
            let symbol_for_gap_check = request.symbol.clone();
            let db_pool_clone = engine.db_pool.clone();
            let window_for_gap_check = window.clone();
            let is_new_asset = needs_initial_history;
            
            tokio::spawn(async move {
                // If this is a brand new asset, download initial history
                if is_new_asset {
                    let from_time = chrono::Utc::now() - chrono::Duration::days(DEFAULT_INITIAL_HISTORY_DAYS);
                    
                    // Wait a moment for the pipeline to stabilize
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    
                    if let Err(e) = run_historical_catchup(
                        symbol_for_gap_check.clone(),
                        from_time,
                        window_for_gap_check.clone()
                    ).await {
                        eprintln!("[MarketData] Initial history download failed: {}", e);
                    }
                    return;
                }
                
                // Otherwise, check for gaps in existing data
                match sqlx::query_as::<_, (Option<chrono::DateTime<chrono::Utc>>,)>(
                    r#"
                    WITH recent_data AS (
                        -- Check if we have data in the last 5 minutes
                        SELECT COUNT(*) > 0 as has_recent
                        FROM forex_ticks
                        WHERE symbol = $1 
                            AND time > NOW() - INTERVAL '5 minutes'
                    ),
                    gap_boundaries AS (
                        -- Find all gaps > 1 hour
                        SELECT 
                            time,
                            time - LAG(time) OVER (ORDER BY time) as gap_from_previous
                        FROM forex_ticks 
                        WHERE symbol = $1
                            AND time > NOW() - INTERVAL '90 days'
                    ),
                    last_before_gap AS (
                        -- Find the last tick before the most recent gap
                        SELECT MAX(time) as tick_time
                        FROM forex_ticks
                        WHERE symbol = $1
                            AND time < (
                                SELECT MIN(time)
                                FROM gap_boundaries
                                WHERE time >= COALESCE(
                                    (SELECT MAX(time) FROM gap_boundaries WHERE gap_from_previous > INTERVAL '1 hour'),
                                    '1900-01-01'::timestamp
                                )
                            )
                    )
                    SELECT 
                        CASE 
                            WHEN (SELECT has_recent FROM recent_data) THEN
                                -- If we have recent data, check for historical gaps
                                (SELECT tick_time FROM last_before_gap)
                            ELSE
                                -- If no recent data, just get the most recent tick
                                (SELECT MAX(time) FROM forex_ticks WHERE symbol = $1)
                        END as last_tick
                    "#
                )
                .bind(&symbol_for_gap_check)
                .bind(&symbol_for_gap_check)
                .bind(&symbol_for_gap_check)
                .bind(&symbol_for_gap_check)
                .fetch_one(&db_pool_clone)
                .await
                {
                    Ok((last_tick,)) => {
                        if let Some(last_tick) = last_tick {
                            let now = chrono::Utc::now();
                            let gap_minutes = (now - last_tick).num_minutes();
                            
                            println!("[MarketData] Found existing data for {}, gap: {} minutes", 
                                symbol_for_gap_check, gap_minutes);
                            
                            // If there's a significant gap, run catchup
                            if gap_minutes > 5 {
                                println!("[MarketData] Auto-detected gap for {}, initiating catchup", 
                                    symbol_for_gap_check);
                                
                                if let Err(e) = run_historical_catchup(
                                    symbol_for_gap_check.clone(),
                                    last_tick,
                                    window_for_gap_check.clone()
                                ).await {
                                    eprintln!("[MarketData] Catchup error: {}", e);
                                }
                            }
                        }
                    }
                    Err(_) => {
                        // No existing data - this is a new asset, download initial history
                        println!("[MarketData] New asset {} detected, downloading {} days of historical data", 
                            symbol_for_gap_check, DEFAULT_INITIAL_HISTORY_DAYS);
                        
                        let from_time = chrono::Utc::now() - chrono::Duration::days(DEFAULT_INITIAL_HISTORY_DAYS);
                        
                        if let Err(e) = run_historical_catchup(
                            symbol_for_gap_check.clone(),
                            from_time,
                            window_for_gap_check.clone()
                        ).await {
                            eprintln!("[MarketData] Initial history download failed: {}", e);
                        }
                    }
                }
            });
            
            // Handle explicit catchup if requested (for restore scenarios)
            if let Some(catchup_from) = request.catchup_from {
                
                // Parse the timestamp
                if let Ok(from_time) = chrono::DateTime::parse_from_rfc3339(&catchup_from) {
                    let from_utc = from_time.with_timezone(&chrono::Utc);
                    let now = chrono::Utc::now();
                    let gap_minutes = (now - from_utc).num_minutes();
                    
                    
                    // Only catchup if gap is significant (>1 minute)
                    if gap_minutes > 1 {
                        // Spawn catchup task
                        let symbol_clone = request.symbol.clone();
                        let window_clone = window.clone();
                        
                        tokio::spawn(async move {
                            if let Err(e) = run_historical_catchup(
                                symbol_clone,
                                from_utc,
                                window_clone
                            ).await {
                                eprintln!("[MarketData] Restore catchup error: {}", e);
                            }
                        });
                    }
                }
            }
            
            // Trigger immediate save - extract Arc before spawning
            let engine_arc = state.engine.clone();
            tokio::spawn(async move {
                if let Err(e) = save_engine_state(engine_arc).await {
                    eprintln!("[MarketData] Failed to save config: {}", e);
                }
            });
            
            Ok(format!("Successfully added {}", request.symbol))
        }
        Err(e) => {
            eprintln!("[MarketData] Error adding asset: {}", e);
            Err(format!("Failed to add asset: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_pipeline_status(
    symbol: String,
    state: State<'_, MarketDataState>,
) -> Result<PipelineStatusResponse, String> {
    let engine = state.engine.lock().await;
    
    if let Some(pipeline) = engine.pipelines.get(&symbol) {
        let status = pipeline.status.lock().await;
        let (status_str, connected, last_tick) = match &*status {
            PipelineStatus::Stopped => ("stopped".to_string(), false, None),
            PipelineStatus::Starting => ("starting".to_string(), false, None),
            PipelineStatus::Running { connected, last_tick } => {
                ("running".to_string(), *connected, last_tick.map(|t| t.to_rfc3339()))
            },
            PipelineStatus::Error { message } => (format!("error: {}", message), false, None),
        };
        
        let source_name = match &pipeline.config.source {
            DataSource::Kraken { .. } => "kraken",
            DataSource::Oanda { .. } => "oanda",
            DataSource::Alpaca { .. } => "alpaca",
            DataSource::Dukascopy => "dukascopy",
            DataSource::IBKR { .. } => "ibkr",
            DataSource::Coinbase { .. } => "coinbase",
        };
        
        Ok(PipelineStatusResponse {
            symbol,
            status: status_str,
            connected,
            last_tick,
            source: source_name.to_string(),
        })
    } else {
        Err(format!("Pipeline not found for symbol: {}", symbol))
    }
}

#[tauri::command]
pub async fn list_active_pipelines(
    state: State<'_, MarketDataState>,
) -> Result<Vec<PipelineStatusResponse>, String> {
    let engine = state.engine.lock().await;
    let mut results = Vec::new();
    
    for (symbol, pipeline) in &engine.pipelines {
        let status = pipeline.status.lock().await;
        let (status_str, connected, last_tick) = match &*status {
            PipelineStatus::Stopped => ("stopped".to_string(), false, None),
            PipelineStatus::Starting => ("starting".to_string(), false, None),
            PipelineStatus::Running { connected, last_tick } => {
                ("running".to_string(), *connected, last_tick.map(|t| t.to_rfc3339()))
            },
            PipelineStatus::Error { message } => (format!("error: {}", message), false, None),
        };
        
        let source_name = match &pipeline.config.source {
            DataSource::Kraken { .. } => "kraken",
            DataSource::Oanda { .. } => "oanda",
            DataSource::Alpaca { .. } => "alpaca",
            DataSource::Dukascopy => "dukascopy",
            DataSource::IBKR { .. } => "ibkr",
            DataSource::Coinbase { .. } => "coinbase",
        };
        
        results.push(PipelineStatusResponse {
            symbol: symbol.clone(),
            status: status_str,
            connected,
            last_tick,
            source: source_name.to_string(),
        });
    }
    
    Ok(results)
}

#[tauri::command]
pub async fn stop_pipeline(
    symbol: String,
    state: State<'_, MarketDataState>,
) -> Result<String, String> {
    let mut engine = state.engine.lock().await;
    
    if let Some(pipeline) = engine.pipelines.remove(&symbol) {
        // Stop the ingester
        if let Some(mut ingester) = pipeline.ingester {
            if let Err(e) = ingester.disconnect().await {
                eprintln!("[MarketData] Error disconnecting ingester: {}", e);
            }
        }
        
        {
            let mut status = pipeline.status.lock().await;
            *status = PipelineStatus::Stopped;
        }
        
        Ok(format!("Stopped pipeline for {}", symbol))
    } else {
        Err(format!("Pipeline not found for symbol: {}", symbol))
    }
}

// Pipeline persistence structures
#[derive(Serialize, Deserialize)]
pub struct PipelineConfigFile {
    pub version: u32,
    pub pipelines: Vec<PipelineConfig>,
    pub saved_at: String,
    pub clean_shutdown: bool,
}

#[derive(Serialize, Deserialize)]
pub struct PipelineConfig {
    pub symbol: String,
    pub source: String,
    pub asset_class: String,
    pub added_at: String,
    pub last_tick: Option<String>,
    pub profile_id: Option<String>, // Which broker profile this pipeline uses
    pub profile_name: Option<String>, // Display name for UI
}

#[tauri::command]
pub async fn save_pipeline_config(
    state: State<'_, MarketDataState>,
) -> Result<(), String> {
    let engine = state.engine.lock().await;
    
    // Extract current pipeline configurations
    let mut configs = Vec::new();
    for (symbol, pipeline) in engine.pipelines.iter() {
        let source_name = match &pipeline.config.source {
            DataSource::Oanda { .. } => "oanda",
            DataSource::Kraken { .. } => "kraken",
            DataSource::Alpaca { .. } => "alpaca",
            DataSource::Dukascopy => "dukascopy",
            DataSource::IBKR { .. } => "ibkr",
            DataSource::Coinbase { .. } => "coinbase",
        };
        
        let status = pipeline.status.lock().await;
        let last_tick_str = match &*status {
            PipelineStatus::Running { last_tick, .. } => 
                last_tick.map(|t| t.to_rfc3339()),
            _ => None,
        };
        
        configs.push(PipelineConfig {
            symbol: symbol.clone(),
            source: source_name.to_string(),
            asset_class: format!("{:?}", pipeline.config.asset_class).to_lowercase(),
            added_at: chrono::Utc::now().to_rfc3339(),
            last_tick: last_tick_str,
            profile_id: pipeline.config.profile_id.clone(),
            profile_name: pipeline.config.profile_name.clone(),
        });
    }
    
    let config_file = PipelineConfigFile {
        version: 1,
        pipelines: configs,
        saved_at: chrono::Utc::now().to_rfc3339(),
        clean_shutdown: false,  // Will be set to true on graceful shutdown
    };
    
    // Get app config directory using dirs crate
    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("sptraderb");
    
    // Ensure directory exists
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    
    let config_path = config_dir.join("active_pipelines.json");
    let json = serde_json::to_string_pretty(&config_file)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    std::fs::write(&config_path, json)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    
    Ok(())
}

#[tauri::command]
pub async fn load_pipeline_config() -> Result<PipelineConfigFile, String> {
    // Note: This needs app handle but we can't get it without State
    // Will need to pass config path from frontend or refactor
    let config_path = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("sptraderb")
        .join("active_pipelines.json");
    
    if !config_path.exists() {
        return Ok(PipelineConfigFile {
            version: 1,
            pipelines: vec![],
            saved_at: chrono::Utc::now().to_rfc3339(),
            clean_shutdown: true,  // No previous file means clean start
        });
    }
    
    let json = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;
    
    let config_file: PipelineConfigFile = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse config file: {}", e))?;
    
    Ok(config_file)
}

// Helper function to save engine state (works with Arc directly)
async fn save_engine_state(engine: Arc<Mutex<MarketDataEngine>>) -> Result<(), String> {
    let configs = {
        let engine_lock = engine.lock().await;
        let mut configs = Vec::new();
        for (symbol, pipeline) in engine_lock.pipelines.iter() {
            let source_name = match &pipeline.config.source {
                DataSource::Oanda { .. } => "oanda",
                DataSource::Kraken { .. } => "kraken",
                DataSource::Alpaca { .. } => "alpaca",
                DataSource::Dukascopy => "dukascopy",
                DataSource::IBKR { .. } => "ibkr",
                DataSource::Coinbase { .. } => "coinbase",
            };
            
            let status = pipeline.status.lock().await;
            let last_tick_str = match &*status {
                PipelineStatus::Running { last_tick, .. } => 
                    last_tick.map(|t| t.to_rfc3339()),
                _ => None,
            };
            
            configs.push(PipelineConfig {
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
    }; // Lock released here
    
    save_configs_to_file(configs).await
}

// Standalone function to save configs to file
async fn save_configs_to_file(configs: Vec<PipelineConfig>) -> Result<(), String> {
    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("sptraderb");
    
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;
    
    let config_file = PipelineConfigFile {
        version: 1,
        pipelines: configs,
        saved_at: chrono::Utc::now().to_rfc3339(),
        clean_shutdown: false,  // Will be set to true on graceful shutdown
    };
    
    let config_path = config_dir.join("active_pipelines.json");
    let json = serde_json::to_string_pretty(&config_file)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    
    std::fs::write(&config_path, json)
        .map_err(|e| format!("Failed to write config file: {}", e))?;
    
    Ok(())
}

// Helper function to run historical catchup
async fn run_historical_catchup(
    symbol: String,
    from_time: chrono::DateTime<chrono::Utc>,
    window: tauri::Window,
) -> Result<(), String> {
    let gap_minutes = (chrono::Utc::now() - from_time).num_minutes();
    
    // Get path to catchup script relative to the Cargo manifest directory
    let script_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("market_data")
        .join("historical")
        .join("catchup_ingester.py");
    
    // Run Python catchup script - use full path to ensure we get the right Python
    let python_path = if std::path::Path::new("/Users/sebastian/anaconda3/bin/python3").exists() {
        "/Users/sebastian/anaconda3/bin/python3"
    } else {
        "python3"
    };
    
    match tokio::process::Command::new(python_path)
        .arg(script_path)
        .arg("--symbol")
        .arg(&symbol)
        .arg("--from")
        .arg(from_time.to_rfc3339())
        .output()
        .await
    {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                println!("[MarketData] Catchup completed for {}", symbol);
                
                window.emit("catchup-status", serde_json::json!({
                    "symbol": symbol,
                    "gap_minutes": gap_minutes,
                    "status": "completed",
                    "message": stdout.trim()
                })).ok();
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let error_msg = format!("Catchup failed: {}", stderr);
                eprintln!("[MarketData] {}", error_msg);
                
                // Log full error for debugging
                eprintln!("[MarketData] Full catchup error output:\n{}", stderr);
                
                window.emit("catchup-status", serde_json::json!({
                    "symbol": symbol,
                    "gap_minutes": gap_minutes,
                    "status": "failed",
                    "error": stderr.trim()
                })).ok();
                Err(error_msg)
            }
        }
        Err(e) => {
            let error_msg = format!("Error running catchup script: {}", e);
            eprintln!("[MarketData] {}", error_msg);
            window.emit("catchup-status", serde_json::json!({
                "symbol": symbol,
                "gap_minutes": gap_minutes,
                "status": "error",
                "error": e.to_string()
            })).ok();
            Err(error_msg)
        }
    }
}

// Initialize market data engine in main.rs
pub fn init_market_data_engine(pool: PgPool) -> MarketDataState {
    let engine = Arc::new(Mutex::new(MarketDataEngine::new(pool)));
    
    // Start auto-save task
    MarketDataEngine::start_auto_save(engine.clone());
    
    MarketDataState { engine }
}

#[tauri::command]
pub async fn mark_restore_completed(
    state: State<'_, MarketDataState>,
) -> Result<(), String> {
    let mut engine = state.engine.lock().await;
    engine.restore_completed = true;
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct DataGapInfo {
    pub symbol: String,
    pub has_data: bool,
    pub last_tick: Option<String>,
    pub gap_minutes: Option<i64>,
    pub gaps: Vec<GapPeriod>,
}

#[derive(Serialize, Deserialize)]
pub struct GapPeriod {
    pub start: String,
    pub end: String,
    pub gap_hours: f64,
}

#[tauri::command]
pub async fn check_data_gaps(
    symbol: String,
    state: State<'_, MarketDataState>,
) -> Result<DataGapInfo, String> {
    let engine = state.engine.lock().await;
    let db_pool = &engine.db_pool;
    
    // First check if we have any data
    let last_tick_result = sqlx::query_as::<_, (Option<chrono::DateTime<chrono::Utc>>,)>(
        "SELECT MAX(time) as last_tick FROM forex_ticks WHERE symbol = $1"
    )
    .bind(&symbol)
    .fetch_one(db_pool)
    .await
    .map_err(|e| format!("Database error: {}", e))?;
    
    if let (Some(last_tick),) = last_tick_result {
        let now = chrono::Utc::now();
        let gap_minutes = (now - last_tick).num_minutes();
        
        // Query for significant gaps in the data
        #[derive(sqlx::FromRow)]
        struct GapRow {
            prev_time: Option<chrono::DateTime<chrono::Utc>>,
            time: chrono::DateTime<chrono::Utc>,
            gap_hours: Option<f64>,
        }
        
        let gaps = sqlx::query_as::<_, GapRow>(
            r#"
            WITH tick_gaps AS (
                SELECT 
                    time,
                    LAG(time) OVER (ORDER BY time) as prev_time,
                    time - LAG(time) OVER (ORDER BY time) as gap
                FROM forex_ticks 
                WHERE symbol = $1 
                    AND time > NOW() - INTERVAL '30 days'
            )
            SELECT 
                prev_time,
                time,
                EXTRACT(epoch FROM gap)/3600 as gap_hours
            FROM tick_gaps 
            WHERE gap > INTERVAL '1 hour' 
            ORDER BY gap DESC 
            LIMIT 10
            "#
        )
        .bind(&symbol)
        .fetch_all(db_pool)
        .await
        .map_err(|e| format!("Database error: {}", e))?;
        
        let gap_periods: Vec<GapPeriod> = gaps.iter()
            .filter_map(|row| {
                row.prev_time.map(|start| GapPeriod {
                    start: start.to_rfc3339(),
                    end: row.time.to_rfc3339(),
                    gap_hours: row.gap_hours.unwrap_or(0.0),
                })
            })
            .collect();
        
        Ok(DataGapInfo {
            symbol,
            has_data: true,
            last_tick: Some(last_tick.to_rfc3339()),
            gap_minutes: Some(gap_minutes),
            gaps: gap_periods,
        })
    } else {
        Ok(DataGapInfo {
            symbol,
            has_data: false,
            last_tick: None,
            gap_minutes: None,
            gaps: vec![],
        })
    }
}