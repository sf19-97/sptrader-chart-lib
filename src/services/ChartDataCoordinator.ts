import { invoke } from '@tauri-apps/api/core';

interface ChartData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface CachedData {
  data: ChartData[];
  metadata: SymbolMetadata | null;
  timestamp: number;
  range: { from: number; to: number };
}

interface FetchOptions {
  forceRefresh?: boolean;
  range?: { from: number; to: number };
}

export interface SymbolMetadata {
  data_from: number;
  data_to: number;
  total_ticks?: number;
}

export class ChartDataCoordinator {
  private cache = new Map<string, CachedData>();
  private pendingRequests = new Map<string, Promise<ChartData[]>>();
  private defaultRanges = new Map<string, { from: number; to: number }>();
  private cacheTimeout = 10 * 60 * 1000; // 10 minutes
  
  // Normalization factors must match backend
  private normalizationFactors: Record<string, number> = {
    '5m': 900,      // 15 minutes
    '15m': 3600,    // 1 hour
    '1h': 7200,     // 2 hours
    '4h': 14400,    // 4 hours
    '12h': 43200,   // 12 hours
  };

  /**
   * Get or set the default range for a symbol-timeframe combination
   */
  public setDefaultRange(symbol: string, timeframe: string, from: number, to: number) {
    const key = `${symbol}-${timeframe}`;
    this.defaultRanges.set(key, { from, to });
    console.log(`[ChartDataCoordinator] Set default range for ${key}: ${from} - ${to}`);
  }

  /**
   * Generate cache key matching backend logic
   */
  private getCacheKey(symbol: string, timeframe: string, from: number, to: number): string {
    const factor = this.normalizationFactors[timeframe] || 3600;
    const normalizedFrom = Math.floor(from / factor) * factor;
    const normalizedTo = Math.floor(to / factor) * factor;
    
    return `${symbol}-${timeframe}-${normalizedFrom}-${normalizedTo}`;
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid(cached: CachedData): boolean {
    const age = Date.now() - cached.timestamp;
    return age < this.cacheTimeout;
  }

  /**
   * Calculate default range based on timeframe
   */
  private calculateDefaultRange(timeframe: string): { from: number; to: number } {
    const now = Math.floor(Date.now() / 1000);
    const factor = this.normalizationFactors[timeframe] || 3600;
    const to = Math.floor(now / factor) * factor + factor; // Align to next normalization boundary
    
    let from: number;
    switch (timeframe) {
      case '5m':
        from = now - 30 * 24 * 60 * 60; // 30 days
        break;
      case '15m':
      case '1h':
        from = now - 90 * 24 * 60 * 60; // 90 days
        break;
      default:
        from = now - 180 * 24 * 60 * 60; // 180 days for 4h, 12h
    }
    
    return { from, to };
  }

  /**
   * Main method to fetch chart data with coordination
   */
  public async fetchChartData(
    symbol: string, 
    timeframe: string, 
    options?: FetchOptions
  ): Promise<ChartData[]> {
    // Validate inputs
    if (!symbol || symbol.trim() === '') {
      console.warn('[ChartDataCoordinator] Cannot fetch data for empty symbol');
      return [];
    }
    
    // 1. Determine the range to use
    let range: { from: number; to: number };
    
    if (options?.range) {
      // Use explicitly provided range
      range = options.range;
    } else {
      // Try to use stored default range for this symbol-timeframe
      const defaultKey = `${symbol}-${timeframe}`;
      const storedRange = this.defaultRanges.get(defaultKey);
      
      if (storedRange) {
        range = storedRange;
      } else {
        // Calculate and store default range
        range = this.calculateDefaultRange(timeframe);
        this.setDefaultRange(symbol, timeframe, range.from, range.to);
      }
    }

    // 2. Generate cache key
    const cacheKey = this.getCacheKey(symbol, timeframe, range.from, range.to);
    console.log(`[ChartDataCoordinator] Fetching ${symbol}-${timeframe} with key: ${cacheKey}`);

    // 3. Check for in-flight requests
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`[ChartDataCoordinator] Reusing pending request for ${cacheKey}`);
      return this.pendingRequests.get(cacheKey)!;
    }

    // 4. Check cache (unless force refresh)
    if (!options?.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && this.isCacheValid(cached)) {
        console.log(`[ChartDataCoordinator] Cache hit for ${cacheKey} (${cached.data.length} candles)`);
        return cached.data;
      }
    }

    // 5. Create new request
    console.log(`[ChartDataCoordinator] Cache miss for ${cacheKey}, fetching from backend...`);
    
    const requestPromise = this.doFetch(symbol, timeframe, range.from, range.to)
      .then(result => {
        // Cache the result with metadata
        this.cache.set(cacheKey, {
          data: result.data,
          metadata: result.metadata,
          timestamp: Date.now(),
          range
        });
        
        // Clean up pending request
        this.pendingRequests.delete(cacheKey);
        
        console.log(`[ChartDataCoordinator] Fetched and cached ${result.data.length} candles for ${cacheKey}`);
        return result.data;
      })
      .catch(error => {
        // Clean up pending request on error
        this.pendingRequests.delete(cacheKey);
        throw error;
      });

    // Store as pending
    this.pendingRequests.set(cacheKey, requestPromise);
    
    return requestPromise;
  }

  /**
   * Perform the actual backend fetch
   */
  private async doFetch(
    symbol: string, 
    timeframe: string, 
    from: number, 
    to: number
  ): Promise<{ data: ChartData[]; metadata: SymbolMetadata | null }> {
    try {
      const response = await invoke<any>('get_market_candles', {
        symbol,
        timeframe,
        from,
        to
      });

      if (!response.data || !Array.isArray(response.data)) {
        console.error('[ChartDataCoordinator] Invalid response format:', response);
        return { data: [], metadata: null };
      }

      // Convert string prices to numbers and parse time
      const data = response.data.map((candle: any) => ({
        time: Math.floor(new Date(candle.time).getTime() / 1000), // Convert ISO string to Unix timestamp
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
      }));

      // Extract metadata from response
      const metadata = response.metadata ? {
        data_from: response.metadata.start_timestamp,
        data_to: response.metadata.end_timestamp,
        total_ticks: response.metadata.total_ticks
      } : null;

      return { data, metadata };
    } catch (error) {
      console.error('[ChartDataCoordinator] Fetch error:', error);
      throw error;
    }
  }

  /**
   * Get metadata for a symbol
   */
  public async getSymbolMetadata(symbol: string): Promise<SymbolMetadata | null> {
    // Don't fetch metadata for empty symbols
    if (!symbol || symbol.trim() === '') {
      console.warn('[ChartDataCoordinator] Skipping metadata fetch for empty symbol');
      return null;
    }
    
    // Check if we have cached metadata from recent candles fetch
    for (const [key, cached] of this.cache.entries()) {
      if (key.startsWith(`${symbol}-`) && this.isCacheValid(cached) && cached.metadata) {
        console.log('[ChartDataCoordinator] Using cached metadata for', symbol);
        return cached.metadata;
      }
    }
    
    // If no cached metadata, make a separate request
    try {
      const response = await invoke<any>('get_symbol_metadata', { symbol });
      return response;
    } catch (error) {
      console.error('[ChartDataCoordinator] Failed to get metadata:', error);
      return null;
    }
  }

  /**
   * Invalidate cache entries
   */
  public invalidateCache(pattern?: string) {
    if (!pattern) {
      console.log('[ChartDataCoordinator] Clearing entire cache');
      this.cache.clear();
      return;
    }

    let removed = 0;
    for (const [key] of this.cache) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        removed++;
      }
    }
    console.log(`[ChartDataCoordinator] Invalidated ${removed} cache entries matching: ${pattern}`);
  }

  /**
   * Cancel all pending requests
   */
  public cancelPendingRequests() {
    console.log(`[ChartDataCoordinator] Cancelling ${this.pendingRequests.size} pending requests`);
    this.pendingRequests.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return {
      cacheSize: this.cache.size,
      pendingRequests: this.pendingRequests.size,
      defaultRanges: this.defaultRanges.size
    };
  }
}

// Export singleton instance
export const chartDataCoordinator = new ChartDataCoordinator();