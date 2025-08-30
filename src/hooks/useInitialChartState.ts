import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CandlestickData } from 'lightweight-charts';

export interface ChartSession {
  symbol: string;
  timeframe: string;
  candles: MarketCandle[];
  visible_range: {
    from: number;
    to: number;
  };
  bar_spacing: number;
  saved_at: string;
}

export interface MarketCandle {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number | null;
}

// Convert MarketCandle to CandlestickData
function convertToCandlestickData(candle: MarketCandle): CandlestickData {
  return {
    time: Math.floor(new Date(candle.time).getTime() / 1000) as any,
    open: parseFloat(candle.open),
    high: parseFloat(candle.high),
    low: parseFloat(candle.low),
    close: parseFloat(candle.close),
  };
}

export function useInitialChartState() {
  const [initialState, setInitialState] = useState<ChartSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const state = await invoke<ChartSession | null>('get_initial_state');
        if (state) {
          // Also save to localStorage for fallback
          localStorage.setItem('lastViewedSymbol', state.symbol);
          localStorage.setItem('lastViewedTimeframe', state.timeframe);
        }
        setInitialState(state);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load initial state');
      } finally {
        setIsLoading(false);
      }
    };

    loadInitialState();
  }, []);

  return { 
    initialState, 
    isLoading, 
    error,
    convertedCandles: initialState ? initialState.candles.map(convertToCandlestickData) : null
  };
}