// Generate base tick data (1-minute resolution)
const generateBaseTicks = (from: number, to: number) => {
  const ticks = [];
  const tickInterval = 60; // 1 minute
  
  for (let time = from; time <= to; time += tickInterval) {
    // Deterministic price based on time for consistency
    const daysSinceEpoch = time / 86400;
    const trendFactor = Math.sin(daysSinceEpoch / 30) * 0.02; // Monthly trend
    const dailyFactor = Math.sin(daysSinceEpoch) * 0.005; // Daily cycle
    const hourlyFactor = Math.sin((time % 86400) / 3600) * 0.001; // Hourly cycle
    
    // Use time as seed for consistent "randomness"
    const pseudoRandom = Math.sin(time * 12.9898) * 43758.5453;
    const noise = (pseudoRandom - Math.floor(pseudoRandom) - 0.5) * 0.0002;
    
    const price = 1.0800 + trendFactor + dailyFactor + hourlyFactor + noise;
    
    ticks.push({
      time,
      price,
      volume: Math.floor(Math.abs(pseudoRandom % 100) + 10)
    });
  }
  
  return ticks;
};

// Aggregate ticks into candles
const aggregateCandles = (ticks: any[], interval: number, from: number, to: number) => {
  const candles = [];
  
  for (let candleTime = from; candleTime <= to - interval; candleTime += interval) {
    const candleTicks = ticks.filter(t => 
      t.time >= candleTime && t.time < candleTime + interval
    );
    
    if (candleTicks.length > 0) {
      const open = candleTicks[0].price;
      const close = candleTicks[candleTicks.length - 1].price;
      const high = Math.max(...candleTicks.map(t => t.price));
      const low = Math.min(...candleTicks.map(t => t.price));
      const volume = candleTicks.reduce((sum, t) => sum + t.volume, 0);
      
      candles.push({
        time: candleTime,
        open,
        high,
        low,
        close,
        volume
      });
    }
  }
  
  return candles;
};

// Mock Tauri API for browser development
export const mockInvoke = async (cmd: string, args?: any): Promise<any> => {
  console.log(`[Mock Tauri] Command: ${cmd}`, args);
  
  // Mock responses for different commands
  switch (cmd) {
    case 'fetch_candles':
      // Return mock candle data
      const { request } = args;
      const { timeframe, from, to } = request;
      
      // Determine interval in seconds based on timeframe
      const intervals: Record<string, number> = {
        '5m': 300,     // 5 minutes
        '15m': 900,    // 15 minutes
        '1h': 3600,    // 1 hour
        '4h': 14400,   // 4 hours
        '12h': 43200   // 12 hours
      };
      
      const interval = intervals[timeframe] || 3600;
      
      // Generate base tick data for the range (with some padding)
      const baseTicks = generateBaseTicks(from - interval, to + interval);
      
      // Aggregate into requested timeframe
      const candles = aggregateCandles(baseTicks, interval, from, to);
      
      console.log(`[Mock Tauri] Generated ${candles.length} ${timeframe} candles`);
      return candles;
      
    case 'get_symbol_metadata':
      return {
        data_from: Date.now() / 1000 - (365 * 24 * 60 * 60), // 1 year ago
        data_to: Date.now() / 1000,
        total_ticks: 1000000
      };
      
    case 'start_candle_monitor':
    case 'stop_candle_monitor':
      return null;
      
    default:
      console.warn(`[Mock Tauri] Unknown command: ${cmd}`);
      return null;
  }
};

export const mockListen = async (event: string, handler: (payload: any) => void): Promise<() => void> => {
  console.log(`[Mock Tauri] Listening to event: ${event}`);
  
  // Simulate some events for testing
  if (event.includes('candles-updated')) {
    // Simulate periodic candle updates
    const interval = setInterval(() => {
      const timeframe = event.split('-').pop(); // Extract timeframe from event name
      handler({
        symbol: 'EURUSD',
        timeframe: timeframe || '1h',
        timestamp: new Date().toISOString()
      });
    }, 5000); // Every 5 seconds
    
    // Return unlisten function that clears the interval
    return () => {
      console.log(`[Mock Tauri] Stopped listening to event: ${event}`);
      clearInterval(interval);
    };
  }
  
  // Return a mock unlisten function for other events
  return () => {
    console.log(`[Mock Tauri] Stopped listening to event: ${event}`);
  };
};