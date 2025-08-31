// src-tauri/src/market_data/mod.rs

pub mod commands;
pub mod pipeline;
pub mod ingesters;
pub mod symbols;

use serde::{Deserialize, Serialize};
use async_trait::async_trait;
use sqlx::PgPool;
use std::collections::HashMap;
use chrono::{DateTime, Utc};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AssetClass {
    Forex,
    Crypto,
    Stock,
    Future,
    Option,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DataSource {
    Kraken { api_key: Option<String>, api_secret: Option<String> },
    Oanda { account_id: String, api_token: String },
    Alpaca { api_key: String, api_secret: String },
    Dukascopy, // Historical only
    IBKR { username: String, password: String },
    Coinbase { api_key: String, api_secret: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetInfo {
    pub symbol: String,
    pub class: AssetClass,
    pub base: Option<String>,  // For pairs like EURUSD
    pub quote: Option<String>,
    pub available_sources: Vec<DataSource>,
    pub decimals: u8,
    pub min_tick: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketTick {
    pub time: DateTime<Utc>,
    pub symbol: String,
    pub source: String,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub last: Option<f64>,
    pub volume: Option<f64>,
    pub extra: serde_json::Value, // Source-specific fields
}

#[derive(Debug)]
pub struct PipelineConfig {
    pub symbol: String,
    pub asset_class: AssetClass,
    pub source: DataSource,
    pub tick_table: String,
    #[allow(dead_code)]
    pub aggregate_tables: Vec<(String, String)>, // (table_name, timeframe)
    pub cascade_procedure: String,
    pub profile_id: Option<String>, // Broker profile used for this pipeline
    pub profile_name: Option<String>, // Display name of the profile
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PipelineStatus {
    Stopped,
    Starting,
    Running { connected: bool, last_tick: Option<DateTime<Utc>> },
    Error { message: String },
}

#[async_trait]
pub trait Ingester: Send + Sync {
    /// Connect to the data source
    async fn connect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    
    /// Subscribe to symbols
    async fn subscribe(&mut self, symbols: Vec<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    
    /// Get next tick (blocks until available)
    async fn next_tick(&mut self) -> Result<MarketTick, Box<dyn std::error::Error + Send + Sync>>;
    
    /// Disconnect and cleanup
    async fn disconnect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
    
    /// Get source-specific column definitions for tick table
    #[allow(dead_code)]
    fn extra_columns(&self) -> &'static str;
}

pub struct AssetPipeline {
    pub config: PipelineConfig,
    pub ingester: Option<Box<dyn Ingester>>,
    pub status: Arc<Mutex<PipelineStatus>>,
    pub db_pool: PgPool,
}


pub struct MarketDataEngine {
    pub pipelines: HashMap<String, AssetPipeline>,
    pub db_pool: PgPool,
    pub cascade_scheduler: CascadeScheduler,
    pub restore_completed: bool, // Track if restore has happened
}

pub struct CascadeScheduler {
    db_pool: PgPool,
    intervals: HashMap<String, tokio::task::JoinHandle<()>>,
}

impl CascadeScheduler {
    pub fn new(db_pool: PgPool) -> Self {
        Self {
            db_pool,
            intervals: HashMap::new(),
        }
    }
}

impl MarketDataEngine {
    pub fn new(db_pool: PgPool) -> Self {
        Self {
            pipelines: HashMap::new(),
            db_pool: db_pool.clone(),
            cascade_scheduler: CascadeScheduler::new(db_pool),
            restore_completed: false,
        }
    }
    
    pub fn start_auto_save(engine: Arc<Mutex<Self>>) {
        tokio::spawn(async move {
            // CRITICAL: Wait before first save to allow restore
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            interval.tick().await; // Consume the immediate tick
            
            loop {
                interval.tick().await;
                
                // Check if restore has completed
                let should_save = {
                    let engine_lock = engine.lock().await;
                    engine_lock.restore_completed
                };
                
                if !should_save {
                    continue;
                }
                
                // Extract configs directly without needing State
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
                        
                        configs.push(commands::PipelineConfig {
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
                
                // Save directly
                let config_file = commands::PipelineConfigFile {
                    version: 1,
                    pipelines: configs,
                    saved_at: chrono::Utc::now().to_rfc3339(),
                    clean_shutdown: false,  // Always false for auto-save
                };
                
                let config_dir = dirs::config_dir()
                    .map(|d| d.join("sptraderb"));
                    
                if let Some(dir) = config_dir {
                    if let Err(e) = std::fs::create_dir_all(&dir) {
                        eprintln!("[MarketData] Failed to create config dir: {}", e);
                        continue;
                    }
                    
                    let config_path = dir.join("active_pipelines.json");
                    match serde_json::to_string_pretty(&config_file) {
                        Ok(json) => {
                            if let Err(e) = std::fs::write(&config_path, json) {
                                eprintln!("[MarketData] Auto-save write failed: {}", e);
                            }
                        }
                        Err(e) => eprintln!("[MarketData] Auto-save serialization failed: {}", e),
                    }
                }
            }
        });
    }
    
    pub async fn add_asset(&mut self, symbol: String, source: Option<DataSource>, profile_id: Option<String>, profile_name: Option<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // 1. Discover asset info
        let asset_info = AssetDiscovery::identify(&symbol).await?;
        
        // 2. Select source (use provided or auto-select)
        let selected_source = match source {
            Some(s) => s,
            None => self.select_best_source(&asset_info).await?,
        };
        
        // 3. Build pipeline configuration
        let mut config = PipelineBuilder::new(self.db_pool.clone())
            .symbol(&symbol)
            .asset_info(&asset_info)
            .source(selected_source)
            .build()
            .await?;
        
        // Set profile information
        config.profile_id = profile_id;
        config.profile_name = profile_name;
        
        // 4. Create ingester
        let ingester = create_ingester(&config)?;
        
        // 5. Create pipeline
        let mut pipeline = AssetPipeline {
            config,
            ingester: Some(ingester),
            status: Arc::new(Mutex::new(PipelineStatus::Stopped)),
            db_pool: self.db_pool.clone(),
        };
        
        // 6. Start it
        pipeline.start().await?;
        
        // 7. Store it
        self.pipelines.insert(symbol.clone(), pipeline);
        
        Ok(())
    }
    
    async fn select_best_source(&self, asset_info: &AssetInfo) -> Result<DataSource, Box<dyn std::error::Error + Send + Sync>> {
        // TODO: Check which sources we have credentials for
        // For now, just return the first available
        asset_info.available_sources.first()
            .cloned()
            .ok_or_else(|| "No available sources for asset".into())
    }
}

pub struct AssetDiscovery;

impl AssetDiscovery {
    pub async fn identify(symbol: &str) -> Result<AssetInfo, Box<dyn std::error::Error + Send + Sync>> {
        let symbol = symbol.to_uppercase();
        
        // Forex pairs (6 chars, common currencies)
        if symbol.len() == 6 {
            let base = &symbol[0..3];
            let quote = &symbol[3..6];
            
            let forex_currencies = ["EUR", "USD", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"];
            if forex_currencies.contains(&base) && forex_currencies.contains(&quote) {
                return Ok(AssetInfo {
                    symbol: symbol.clone(),
                    class: AssetClass::Forex,
                    base: Some(base.to_string()),
                    quote: Some(quote.to_string()),
                    available_sources: vec![
                        DataSource::Oanda { account_id: String::new(), api_token: String::new() },
                        DataSource::Dukascopy,
                    ],
                    decimals: 5,
                    min_tick: 0.00001,
                });
            }
        }
        
        // Crypto (ends with USD, USDT, BTC, ETH)
        if symbol.ends_with("USD") || symbol.ends_with("USDT") || symbol.ends_with("BTC") || symbol.ends_with("ETH") {
            let base = symbol.trim_end_matches("USD")
                .trim_end_matches("USDT")
                .trim_end_matches("BTC")
                .trim_end_matches("ETH");
            
            let crypto_symbols = ["BTC", "ETH", "SOL", "AVAX", "LINK", "DOT", "MATIC"];
            if crypto_symbols.contains(&base) {
                return Ok(AssetInfo {
                    symbol: symbol.clone(),
                    class: AssetClass::Crypto,
                    base: Some(base.to_string()),
                    quote: Some(
                        if symbol.ends_with("USDT") { "USDT" }
                        else if symbol.ends_with("BTC") { "BTC" }
                        else if symbol.ends_with("ETH") { "ETH" }
                        else { "USD" }.to_string()
                    ),
                    available_sources: vec![
                        DataSource::Kraken { api_key: None, api_secret: None },
                        DataSource::Coinbase { api_key: String::new(), api_secret: String::new() },
                    ],
                    decimals: 2,
                    min_tick: 0.01,
                });
            }
        }
        
        // Stocks (1-5 chars, all letters)
        if symbol.len() <= 5 && symbol.chars().all(|c| c.is_alphabetic()) {
            return Ok(AssetInfo {
                symbol: symbol.clone(),
                class: AssetClass::Stock,
                base: None,
                quote: None,
                available_sources: vec![
                    DataSource::Alpaca { api_key: String::new(), api_secret: String::new() },
                ],
                decimals: 2,
                min_tick: 0.01,
            });
        }
        
        Err(format!("Unable to identify asset type for symbol: {}", symbol).into())
    }
}

pub struct PipelineBuilder {
    db_pool: PgPool,
    symbol: Option<String>,
    asset_info: Option<AssetInfo>,
    source: Option<DataSource>,
}

impl PipelineBuilder {
    pub fn new(db_pool: PgPool) -> Self {
        Self {
            db_pool,
            symbol: None,
            asset_info: None,
            source: None,
        }
    }
    
    pub fn symbol(mut self, symbol: &str) -> Self {
        self.symbol = Some(symbol.to_string());
        self
    }
    
    pub fn asset_info(mut self, info: &AssetInfo) -> Self {
        self.asset_info = Some(info.clone());
        self
    }
    
    pub fn source(mut self, source: DataSource) -> Self {
        self.source = Some(source);
        self
    }
    
    pub async fn build(self) -> Result<PipelineConfig, Box<dyn std::error::Error + Send + Sync>> {
        let symbol = self.symbol.as_ref().ok_or("Symbol not set")?;
        let asset_info = self.asset_info.as_ref().ok_or("Asset info not set")?;
        let source = self.source.as_ref().ok_or("Source not set")?;
        
        // Generate table names based on asset class
        let table_prefix = match asset_info.class {
            AssetClass::Forex => "forex",
            AssetClass::Crypto => "crypto",
            AssetClass::Stock => "stock",
            AssetClass::Future => "future",
            AssetClass::Option => "option",
        };
        
        let tick_table = format!("{}_ticks", table_prefix);
        let aggregate_tables = vec![
            (format!("{}_candles_1m", table_prefix), "1m".to_string()),
            (format!("{}_candles_5m", table_prefix), "5m".to_string()),
            (format!("{}_candles_15m", table_prefix), "15m".to_string()),
            (format!("{}_candles_1h", table_prefix), "1h".to_string()),
            (format!("{}_candles_4h", table_prefix), "4h".to_string()),
            (format!("{}_candles_12h", table_prefix), "12h".to_string()),
        ];
        let cascade_procedure = format!("cascade_{}_aggregate_refresh", table_prefix);
        
        Ok(PipelineConfig {
            symbol: symbol.clone(),
            asset_class: asset_info.class.clone(),
            source: source.clone(),
            tick_table,
            aggregate_tables,
            cascade_procedure,
            profile_id: None, // Will be set by caller
            profile_name: None, // Will be set by caller
        })
    }
}

fn create_ingester(config: &PipelineConfig) -> Result<Box<dyn Ingester>, Box<dyn std::error::Error + Send + Sync>> {
    match &config.source {
        DataSource::Kraken { .. } => Ok(Box::new(KrakenIngester::new(config.symbol.clone()))),
        DataSource::Oanda { account_id, api_token } => {
            Ok(Box::new(OandaIngester::new(config.symbol.clone(), account_id.clone(), api_token.clone())))
        },
        _ => Err("Ingester not implemented for this source".into()),
    }
}

// Import the actual ingester implementations
use ingesters::kraken::KrakenIngester;
use ingesters::oanda::OandaIngester;