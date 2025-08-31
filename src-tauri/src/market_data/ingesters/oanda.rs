// src-tauri/src/market_data/ingesters/oanda.rs

use super::*;
use reqwest::{Client, Response};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct OandaPrice {
    #[serde(rename = "type")]
    msg_type: String,
    time: String,
    bids: Vec<PricePoint>,
    asks: Vec<PricePoint>,
    #[serde(rename = "closeoutBid")]
    closeout_bid: String,
    #[serde(rename = "closeoutAsk")]
    closeout_ask: String,
    #[allow(dead_code)]
    status: String,
    tradeable: bool,
    instrument: String,
}

#[derive(Debug, Deserialize)]
struct PricePoint {
    price: String,
    #[allow(dead_code)]
    liquidity: i64,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct OandaHeartbeat {
    #[serde(rename = "type")]
    msg_type: String,
    time: String,
}

pub struct OandaIngester {
    symbol: String,
    account_id: String,
    api_token: String,
    client: Client,
    stream: Option<Response>,
    api_url: String,
}

impl OandaIngester {
    pub fn new(symbol: String, account_id: String, api_token: String) -> Self {
        Self {
            symbol,
            account_id,
            api_token,
            client: Client::new(),
            stream: None,
            api_url: "https://stream-fxpractice.oanda.com".to_string(), // Practice account
        }
    }
    
    fn convert_symbol(&self, symbol: &str) -> String {
        // Convert EURUSD to EUR_USD format
        if symbol.len() == 6 {
            format!("{}_{}", &symbol[..3], &symbol[3..])
        } else {
            symbol.to_string()
        }
    }
    
    fn parse_price(price_str: &str) -> Option<f64> {
        price_str.parse::<f64>().ok()
    }
}

#[async_trait]
impl Ingester for OandaIngester {
    async fn connect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Oanda doesn't require a separate connection step
        // Connection happens when subscribing
        println!("[Oanda] Ingester initialized for account: {}", self.account_id);
        Ok(())
    }
    
    async fn subscribe(&mut self, symbols: Vec<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Convert symbols to Oanda format
        let oanda_instruments: Vec<String> = symbols.iter()
            .map(|s| self.convert_symbol(s))
            .collect();
        
        let instruments_param = oanda_instruments.join(",");
        
        // Start streaming endpoint
        let url = format!(
            "{}/v3/accounts/{}/pricing/stream?instruments={}",
            self.api_url, self.account_id, instruments_param
        );
        
        let response = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_token))
            .header("Accept-Datetime-Format", "RFC3339")
            .send()
            .await?;
        
        if !response.status().is_success() {
            return Err(format!("Oanda API error: {}", response.status()).into());
        }
        
        self.stream = Some(response);
        println!("[Oanda] Subscribed to: {:?}", oanda_instruments);
        Ok(())
    }
    
    async fn next_tick(&mut self) -> Result<MarketTick, Box<dyn std::error::Error + Send + Sync>> {
        let symbol = self.symbol.clone();
        let converted_symbol = self.convert_symbol(&symbol);
        
        if let Some(stream) = &mut self.stream {
            
            let mut buffer = String::new();
            
            // Read chunks from the response
            loop {
                let chunk = stream.chunk().await?;
                if let Some(bytes) = chunk {
                    let text = String::from_utf8_lossy(&bytes);
                    buffer.push_str(&text);
                
                // Oanda sends line-delimited JSON
                while let Some(newline_pos) = buffer.find('\n') {
                    let line = buffer[..newline_pos].trim().to_string();
                    buffer = buffer[newline_pos + 1..].to_string();
                    
                    if line.is_empty() {
                        continue;
                    }
                    
                    // Try to parse as price update
                    if let Ok(price) = serde_json::from_str::<OandaPrice>(&line) {
                        if price.msg_type == "PRICE" && price.instrument == converted_symbol {
                            let time = DateTime::parse_from_rfc3339(&price.time)?
                                .with_timezone(&Utc);
                            
                            let bid = Self::parse_price(&price.bids[0].price)
                                .ok_or("Failed to parse bid price")?;
                            let ask = Self::parse_price(&price.asks[0].price)
                                .ok_or("Failed to parse ask price")?;
                            
                            return Ok(MarketTick {
                                time,
                                symbol: symbol.clone(),
                                source: "oanda".to_string(),
                                bid: Some(bid),
                                ask: Some(ask),
                                last: None, // Oanda doesn't provide last trade price
                                volume: None, // No volume in forex
                                extra: json!({
                                    "spread": ask - bid,
                                    "tradeable": price.tradeable,
                                    "closeout_bid": price.closeout_bid,
                                    "closeout_ask": price.closeout_ask,
                                }),
                            });
                        }
                    }
                    // Ignore heartbeats and other message types
                }
                } else {
                    break; // No more chunks
                }
            }
        }
        
        Err("No stream available".into())
    }
    
    async fn disconnect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.stream = None;
        Ok(())
    }
    
    fn extra_columns(&self) -> &'static str {
        "spread NUMERIC(10,5),
         tradeable BOOLEAN,
         closeout_bid NUMERIC(12,5),
         closeout_ask NUMERIC(12,5)"
    }
}