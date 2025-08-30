import { useState, useCallback, useRef, useEffect } from 'react';
import { chartDataCoordinator } from '../services/ChartDataCoordinator';

interface ChartData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface UseChartDataOptions {
  autoLoad?: boolean;
  range?: { from: number; to: number };
}

interface UseChartDataReturn {
  data: ChartData[];
  isLoading: boolean;
  error: string | null;
  fetchData: (options?: { forceRefresh?: boolean; range?: { from: number; to: number } }) => Promise<void>;
  invalidateCache: (pattern?: string) => void;
  setDefaultRange: (from: number, to: number) => void;
}

export function useChartData(
  symbol: string,
  timeframe: string,
  options?: UseChartDataOptions
): UseChartDataReturn {
  const [data, setData] = useState<ChartData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Track current symbol/timeframe to detect changes
  const currentRef = useRef({ symbol, timeframe });
  
  // Fetch data with coordination
  const fetchData = useCallback(async (fetchOptions?: { 
    forceRefresh?: boolean; 
    range?: { from: number; to: number } 
  }) => {
    // Don't fetch if already loading
    if (isLoading) {
      console.log('[useChartData] Already loading, skipping fetch');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await chartDataCoordinator.fetchChartData(
        symbol,
        timeframe,
        {
          forceRefresh: fetchOptions?.forceRefresh,
          range: fetchOptions?.range || options?.range
        }
      );
      
      // Only update if we're still looking at the same symbol/timeframe
      if (currentRef.current.symbol === symbol && currentRef.current.timeframe === timeframe) {
        setData(result);
        console.log(`[useChartData] Updated data for ${symbol}-${timeframe}: ${result.length} candles`);
      }
    } catch (err) {
      console.error('[useChartData] Fetch error:', err);
      if (currentRef.current.symbol === symbol && currentRef.current.timeframe === timeframe) {
        setError(err instanceof Error ? err.message : 'Failed to fetch data');
      }
    } finally {
      if (currentRef.current.symbol === symbol && currentRef.current.timeframe === timeframe) {
        setIsLoading(false);
      }
    }
  }, [symbol, timeframe, isLoading, options?.range]);

  // Set default range for this symbol/timeframe
  const setDefaultRange = useCallback((from: number, to: number) => {
    chartDataCoordinator.setDefaultRange(symbol, timeframe, from, to);
  }, [symbol, timeframe]);

  // Invalidate cache
  const invalidateCache = useCallback((pattern?: string) => {
    chartDataCoordinator.invalidateCache(pattern);
  }, []);

  // Auto-load on mount or when symbol/timeframe changes
  useEffect(() => {
    // Update ref
    currentRef.current = { symbol, timeframe };
    
    // Clear previous data when switching
    setData([]);
    
    // Auto-load if enabled (default true)
    if (options?.autoLoad !== false) {
      fetchData();
    }
  }, [symbol, timeframe, options?.autoLoad]); // Don't include fetchData to avoid loops

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Could cancel pending requests here if needed
      console.log(`[useChartData] Unmounting for ${symbol}-${timeframe}`);
    };
  }, [symbol, timeframe]);

  return {
    data,
    isLoading,
    error,
    fetchData,
    invalidateCache,
    setDefaultRange
  };
}