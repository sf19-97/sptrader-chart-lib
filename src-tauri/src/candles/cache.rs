use std::collections::HashMap;
use tokio::sync::RwLock;
use std::sync::Arc;
use super::MarketCandle;

#[derive(Clone)]
pub struct CachedMarketCandles {
    pub data: Vec<MarketCandle>,
    pub cached_at: i64,
}

pub type CandleCache = Arc<RwLock<HashMap<String, CachedMarketCandles>>>;

pub fn create_cache() -> CandleCache {
    Arc::new(RwLock::new(HashMap::new()))
}