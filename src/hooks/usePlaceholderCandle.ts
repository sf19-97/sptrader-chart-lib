import { useRef, useCallback } from 'react';
import { ISeriesApi, CandlestickData, Time } from 'lightweight-charts';

export interface UsePlaceholderCandleOptions {
  onPlaceholderCreated?: (time: number) => void;
  resetDelay?: number;
}

export interface UsePlaceholderCandleReturn {
  createPlaceholder: (candleTime: number) => void;
  updateWithRealData: (data: CandlestickData[]) => void;
  hasPlaceholder: () => boolean;
  getPlaceholderTime: () => number | null;
  resetTrigger: () => void;
}

/**
 * Hook to manage placeholder candles on the chart
 * 
 * Placeholders are temporary candles created at timeframe boundaries
 * before real data arrives, using the previous candle's close price
 * 
 * @param series - The chart series to add placeholders to
 * @param options - Configuration options
 */
export function usePlaceholderCandle(
  series: ISeriesApi<'Candlestick'> | null,
  options?: UsePlaceholderCandleOptions
): UsePlaceholderCandleReturn {
  const { onPlaceholderCreated, resetDelay = 5000 } = options || {};
  
  const hasTriggeredRef = useRef<boolean>(false);
  const placeholderTimeRef = useRef<number | null>(null);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Create a placeholder candle
  const createPlaceholder = useCallback((candleTime: number) => {
    if (!series || hasTriggeredRef.current) {
      console.log('[usePlaceholderCandle] Skipping - no series or already triggered');
      return;
    }

    console.log(`[usePlaceholderCandle] Creating placeholder at ${new Date(candleTime * 1000).toISOString()}`);
    hasTriggeredRef.current = true;
    
    const currentData = series.data();
    if (currentData.length === 0) {
      console.log('[usePlaceholderCandle] No data to create placeholder from');
      return;
    }

    const lastCandle = currentData[currentData.length - 1];
    
    // Type guard - only process if it's actual candle data
    if (!('close' in lastCandle)) {
      console.log('[usePlaceholderCandle] Last data point is not a candle');
      return;
    }
    
    // Create placeholder with previous close as all values
    const placeholderCandle: CandlestickData = {
      time: candleTime as Time,
      open: lastCandle.close,
      high: lastCandle.close,
      low: lastCandle.close,
      close: lastCandle.close,
    };
    
    // Add placeholder to chart
    const newData = [...currentData, placeholderCandle];
    series.setData(newData);
    console.log(
      '[usePlaceholderCandle] Placeholder created at',
      new Date(candleTime * 1000).toLocaleTimeString()
    );
    
    // Store placeholder time for later update
    placeholderTimeRef.current = candleTime;
    
    // Notify callback
    onPlaceholderCreated?.(candleTime);
    
    // Reset trigger after delay
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
    }
    
    resetTimeoutRef.current = setTimeout(() => {
      console.log('[usePlaceholderCandle] Resetting trigger');
      hasTriggeredRef.current = false;
      if (placeholderTimeRef.current === -1) {
        placeholderTimeRef.current = null;
      }
    }, resetDelay);
  }, [series, onPlaceholderCreated, resetDelay]);

  // Update placeholder with real data
  const updateWithRealData = useCallback((data: CandlestickData[]) => {
    if (!placeholderTimeRef.current || !series) {
      return;
    }

    // Check if the new data includes our placeholder time
    const placeholderTime = placeholderTimeRef.current;
    const hasRealData = data.some(candle => 
      (candle.time as number) === placeholderTime
    );

    if (hasRealData) {
      console.log(
        '[usePlaceholderCandle] Replacing placeholder with real data at',
        new Date(placeholderTime * 1000).toLocaleTimeString()
      );
      
      // Clear placeholder reference
      placeholderTimeRef.current = null;
      
      // Update the chart with new data
      series.setData(data);
    }
  }, [series]);

  // Check if there's an active placeholder
  const hasPlaceholder = useCallback(() => {
    return placeholderTimeRef.current !== null;
  }, []);

  // Get current placeholder time
  const getPlaceholderTime = useCallback(() => {
    return placeholderTimeRef.current;
  }, []);

  // Manually reset the trigger
  const resetTrigger = useCallback(() => {
    hasTriggeredRef.current = false;
    placeholderTimeRef.current = null;
    
    if (resetTimeoutRef.current) {
      clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = null;
    }
  }, []);

  return {
    createPlaceholder,
    updateWithRealData,
    hasPlaceholder,
    getPlaceholderTime,
    resetTrigger,
  };
}

/**
 * Helper function to calculate candle time for a given timeframe
 */
export function calculateCandleTime(timestamp: number, timeframe: string): number {
  const periods: Record<string, number> = {
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '12h': 43200,
  };
  
  const period = periods[timeframe] || 3600;
  return Math.floor(timestamp / period) * period;
}