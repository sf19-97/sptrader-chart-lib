use serde::{Deserialize, Serialize};

pub mod commands;
pub mod cache;

// Following the exact Bitcoin pattern - strings for everything
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MarketCandle {
    pub time: String,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub volume: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarketChartResponse {
    pub data: Vec<MarketCandle>,
    pub metadata: Option<MarketMetadata>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarketMetadata {
    pub symbol: String,
    pub start_timestamp: i64,
    pub end_timestamp: i64,
    pub has_data: bool,
}

// Route to correct table based on symbol
pub fn get_table_name(symbol: &str, timeframe: &str) -> Result<String, String> {
    let prefix = if symbol == "BTCUSD" || symbol == "BTC/USD" {
        "bitcoin"
    } else if is_forex_pair(symbol) {
        "forex"
    } else {
        return Err(format!("Unknown asset type for symbol: {}", symbol));
    };
    
    let timeframe_suffix = match timeframe {
        "1m" => "1m",
        "5m" => "5m",
        "15m" => "15m",
        "1h" => "1h",
        "4h" => "4h",
        "12h" => "12h",
        _ => return Err(format!("Unsupported timeframe: {}", timeframe)),
    };
    
    Ok(format!("{}_candles_{}", prefix, timeframe_suffix))
}

// Get the ticks table name for metadata queries
pub fn get_ticks_table(symbol: &str) -> Result<&'static str, String> {
    if symbol == "BTCUSD" || symbol == "BTC/USD" {
        Ok("bitcoin_ticks")
    } else if is_forex_pair(symbol) {
        Ok("forex_ticks")
    } else {
        Err(format!("Unknown asset type for symbol: {}", symbol))
    }
}

fn is_forex_pair(symbol: &str) -> bool {
    // Common forex pairs - exactly as we've been using
    let forex_currencies = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
    
    // Check if symbol is 6 chars (EURUSD) or has a separator (EUR/USD)
    if symbol.len() == 6 {
        let first = &symbol[0..3];
        let second = &symbol[3..6];
        return forex_currencies.contains(&first) && forex_currencies.contains(&second);
    } else if symbol.contains('/') && symbol.len() == 7 {
        let parts: Vec<&str> = symbol.split('/').collect();
        if parts.len() == 2 {
            return forex_currencies.contains(&parts[0]) && forex_currencies.contains(&parts[1]);
        }
    }
    
    false
}