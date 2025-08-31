// src-tauri/src/market_data/ingesters/kraken.rs

use super::*;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{StreamExt, SinkExt};
use serde_json::json;

pub struct KrakenIngester {
    symbol: String,
    ws_stream: Option<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>,
    pending_ticks: Vec<MarketTick>,
}

impl KrakenIngester {
    pub fn new(symbol: String) -> Self {
        Self {
            symbol,
            ws_stream: None,
            pending_ticks: Vec::new(),
        }
    }
    
    fn parse_trade_message_static(data: &serde_json::Value, symbol: &str) -> Option<MarketTick> {
        // Kraken trade format: [channelID, [[price, volume, time, side, orderType, misc]], channelName, pair]
        if let Some(trades) = data.get(1)?.as_array() {
            for trade in trades {
                if let Some(trade_array) = trade.as_array() {
                    let price = trade_array.first()?.as_str()?.parse::<f64>().ok()?;
                    let volume = trade_array.get(1)?.as_str()?.parse::<f64>().ok()?;
                    let timestamp = trade_array.get(2)?.as_f64()?;
                    let side = trade_array.get(3)?.as_str()?;
                    
                    let time = DateTime::<Utc>::from_timestamp(timestamp as i64, ((timestamp % 1.0) * 1_000_000_000.0) as u32)?;
                    
                    // For trades, we create bid/ask from the trade price with small spread
                    let (bid, ask) = if side == "b" {
                        (price - 0.10, price) // Buy trade, price is ask
                    } else {
                        (price, price + 0.10) // Sell trade, price is bid
                    };
                    
                    return Some(MarketTick {
                        time,
                        symbol: symbol.to_string(),
                        source: "kraken".to_string(),
                        bid: Some(bid),
                        ask: Some(ask),
                        last: Some(price),
                        volume: Some(volume),
                        extra: json!({
                            "side": side,
                            "trade_id": timestamp
                        }),
                    });
                }
            }
        }
        None
    }
}

#[async_trait]
impl Ingester for KrakenIngester {
    async fn connect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let url = "wss://ws.kraken.com";
        let (ws_stream, _) = connect_async(url).await?;
        self.ws_stream = Some(ws_stream);
        println!("[Kraken] Connected to WebSocket");
        Ok(())
    }
    
    async fn subscribe(&mut self, symbols: Vec<String>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(ws) = &mut self.ws_stream {
            // Convert symbols to Kraken format (BTCUSD -> XBT/USD)
            let kraken_pairs: Vec<String> = symbols.iter()
                .map(|s| {
                    match s.as_str() {
                        "BTCUSD" => "XBT/USD".to_string(),
                        "ETHUSD" => "ETH/USD".to_string(),
                        _ => format!("{}/{}", &s[..3], &s[3..])
                    }
                })
                .collect();
            
            let subscribe_msg = json!({
                "event": "subscribe",
                "pair": kraken_pairs,
                "subscription": {
                    "name": "trade"
                }
            });
            
            ws.send(Message::Text(subscribe_msg.to_string())).await?;
            println!("[Kraken] Subscribed to: {:?}", kraken_pairs);
        }
        Ok(())
    }
    
    async fn next_tick(&mut self) -> Result<MarketTick, Box<dyn std::error::Error + Send + Sync>> {
        // Return buffered tick if available
        if let Some(tick) = self.pending_ticks.pop() {
            return Ok(tick);
        }
        
        // Otherwise, read from WebSocket until we get trade data
        if let Some(ws) = &mut self.ws_stream {
            while let Some(msg) = ws.next().await {
                match msg? {
                    Message::Text(text) => {
                        if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                            // Skip status messages
                            if data.get("event").is_some() {
                                continue;
                            }
                            
                            // Clone self to avoid borrow conflict
                            let symbol = self.symbol.clone();
                            // Parse trade message
                            if let Some(tick) = Self::parse_trade_message_static(&data, &symbol) {
                                return Ok(tick);
                            }
                        }
                    }
                    Message::Close(_) => {
                        return Err("WebSocket closed".into());
                    }
                    _ => {}
                }
            }
        }
        
        Err("No WebSocket connection".into())
    }
    
    async fn disconnect(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if let Some(mut ws) = self.ws_stream.take() {
            ws.close(None).await?;
        }
        Ok(())
    }
    
    fn extra_columns(&self) -> &'static str {
        "side CHAR(1),
         trade_id BIGINT"
    }
}