use sqlx::postgres::PgListener;
use serde::{Deserialize, Serialize};
use tauri::{Window, Emitter};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CandleUpdateNotification {
    pub symbol: String,
    pub timeframe: String,
    pub timestamp: String,
}

pub struct CandleUpdateMonitor {
    window: Window,
    is_running: Arc<Mutex<bool>>,
}

impl CandleUpdateMonitor {
    pub fn new(window: Window) -> Self {
        Self {
            window,
            is_running: Arc::new(Mutex::new(false)),
        }
    }

    pub async fn start(&self, database_url: &str) -> Result<(), String> {
        let mut is_running = self.is_running.lock().await;
        if *is_running {
            return Ok(());
        }
        *is_running = true;
        drop(is_running);

        let window = self.window.clone();
        let is_running = self.is_running.clone();
        let database_url = database_url.to_string();

        tokio::spawn(async move {
            if let Err(e) = Self::monitor_loop(&window, &database_url, is_running).await {
                eprintln!("Candle monitor error: {}", e);
            }
        });

        Ok(())
    }

    async fn monitor_loop(
        window: &Window,
        database_url: &str,
        is_running: Arc<Mutex<bool>>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Create a listener
        let mut listener = PgListener::connect(database_url).await?;
        
        // Listen to the candle_updates channel
        listener.listen("candle_updates").await?;
        
        println!("[CandleMonitor] Listening for candle update notifications");

        while *is_running.lock().await {
            // Wait for notification with timeout
            match tokio::time::timeout(
                tokio::time::Duration::from_secs(5),
                listener.recv()
            ).await {
                Ok(Ok(notification)) => {
                    // Parse the notification payload
                    if let Ok(update) = serde_json::from_str::<CandleUpdateNotification>(notification.payload()) {
                        println!("[CandleMonitor] Candle update: {} {}", update.symbol, update.timeframe);
                        
                        // Emit specific event for this timeframe
                        let event_name = format!("bitcoin-candles-updated-{}", update.timeframe);
                        window.emit(&event_name, &update).ok();
                        
                        // Also emit general update event
                        window.emit("candle-update", &update).ok();
                    }
                }
                Ok(Err(_)) => {
                    // Connection closed, try to reconnect
                    println!("[CandleMonitor] Connection closed, reconnecting...");
                    listener = PgListener::connect(database_url).await?;
                    listener.listen("candle_updates").await?;
                }
                Err(_) => {
                    // Timeout - check if we should continue
                    continue;
                }
            }
        }

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut is_running = self.is_running.lock().await;
        *is_running = false;
        Ok(())
    }
}

// Tauri commands
#[tauri::command]
pub async fn start_candle_monitor(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let database_url = "postgresql://postgres@localhost:5432/forex_trading";
    
    // Check if monitor already exists for this window
    let monitors = state.candle_monitors.lock().await;
    let window_label = window.label().to_string();
    if monitors.contains_key(&window_label) {
        return Ok(());
    }
    drop(monitors);

    // Create new monitor
    let monitor = CandleUpdateMonitor::new(window.clone());
    monitor.start(database_url).await?;

    // Store monitor
    let mut monitors = state.candle_monitors.lock().await;
    monitors.insert(window_label, Arc::new(monitor));

    Ok(())
}

#[tauri::command]
pub async fn stop_candle_monitor(
    window: Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut monitors = state.candle_monitors.lock().await;
    let window_label = window.label().to_string();
    if let Some(monitor) = monitors.remove(&window_label) {
        monitor.stop().await?;
    }
    Ok(())
}

// Function to manually trigger an update notification (for testing)
#[tauri::command]
pub async fn trigger_candle_update(
    state: tauri::State<'_, crate::AppState>,
    symbol: String,
    timeframe: String,
) -> Result<(), String> {
    let pool = &*state.db_pool.lock().await;
    
    sqlx::query("SELECT track_aggregate_refresh($1, $2)")
        .bind(&symbol)
        .bind(&timeframe)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to trigger update: {}", e))?;
    
    Ok(())
}