import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { ChartData, ViewState } from '../types';

interface CachedData {
  candles: ChartData[];
  timestamp: number;
}

interface MetadataCache {
  [symbol: string]: {
    from: number;
    to: number;
    timestamp: number;
  };
}

interface ChartState {
  // Cache
  candleCache: Map<string, CachedData>;
  viewStates: Map<string, ViewState>;
  metadataCache: MetadataCache;

  // Current state
  isLoading: boolean;
  currentSymbol: string;
  currentTimeframe: string;

  // Actions
  setLoading: (loading: boolean) => void;
  setCurrentSymbol: (symbol: string) => void;
  setCurrentTimeframe: (timeframe: string) => void;

  // Cache actions
  getCachedCandles: (key: string) => ChartData[] | null;
  setCachedCandles: (key: string, candles: ChartData[]) => void;
  invalidateCache: (pattern?: string) => void;

  // Metadata cache actions
  getCachedMetadata: (symbol: string) => { from: number; to: number } | null;
  setCachedMetadata: (symbol: string, from: number, to: number) => void;

  // View state actions
  saveViewState: (symbol: string, state: ViewState) => void;
  getViewState: (symbol: string) => ViewState | null;

  // Utility
  getCacheKey: (symbol: string, timeframe: string, from: number, to: number) => string;
}

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export const useChartStore = create<ChartState>()(
  devtools(
    (set, get) => ({
      // Initial state
      candleCache: new Map(),
      viewStates: new Map(),
      metadataCache: {},
      isLoading: false,
      currentSymbol: 'EURUSD',
      currentTimeframe: '1h',

      // Basic setters
      setLoading: (loading) => set({ isLoading: loading }),
      setCurrentSymbol: (symbol) => set({ currentSymbol: symbol }),
      setCurrentTimeframe: (timeframe) => set({ currentTimeframe: timeframe }),

      // Cache key generator - MUST match backend normalization
      getCacheKey: (symbol, timeframe, from, to) => {
        // CRITICAL: Match backend timestamp normalization from candles/commands.rs
        const normalizationFactor: Record<string, number> = {
          '1m': 300,      // 5 minutes
          '5m': 900,      // 15 minutes
          '15m': 3600,    // 1 hour
          '1h': 7200,     // 2 hours
          '4h': 14400,    // 4 hours
          '12h': 43200,   // 12 hours
        };
        
        const factor = normalizationFactor[timeframe] || 3600;
        const normalizedFrom = Math.floor(from / factor) * factor;
        const normalizedTo = Math.floor(to / factor) * factor;
        
        return `${symbol}-${timeframe}-${normalizedFrom}-${normalizedTo}`;
      },

      // Get cached candles
      getCachedCandles: (key) => {
        const cached = get().candleCache.get(key);
        if (!cached) {
          console.log('[ChartStore] Cache miss for:', key);
          console.log('[ChartStore] Current cache keys:', Array.from(get().candleCache.keys()));
          return null;
        }

        // Check if expired
        const now = Date.now();
        const age = now - cached.timestamp;
        if (age > CACHE_TTL) {
          console.log('[ChartStore] Cache expired for:', key, {
            age: `${(age / 1000).toFixed(0)}s`,
            ttl: `${(CACHE_TTL / 1000).toFixed(0)}s`,
            cachedAt: new Date(cached.timestamp).toISOString(),
            now: new Date(now).toISOString(),
          });
          // Remove expired entry
          const newCache = new Map(get().candleCache);
          newCache.delete(key);
          set({ candleCache: newCache });
          return null;
        }

        console.log(
          '[ChartStore] Cache hit for:',
          key,
          `(${cached.candles.length} candles, age: ${(age / 1000).toFixed(0)}s)`
        );
        return cached.candles;
      },

      // Set cached candles
      setCachedCandles: (key, candles) => {
        const newCache = new Map(get().candleCache);

        // Simple LRU: if cache is too big, remove oldest
        if (newCache.size >= 100) {
          const entries = Array.from(newCache.entries()).sort(
            (a, b) => a[1].timestamp - b[1].timestamp
          );
          if (entries.length > 0 && entries[0]) {
            const oldestKey = entries[0][0];
            newCache.delete(oldestKey);
            console.log('[ChartStore] Cache eviction, removed:', oldestKey);
          }
        }

        newCache.set(key, {
          candles,
          timestamp: Date.now(),
        });

        console.log('[ChartStore] Cached', candles.length, 'candles for:', key);
        set({ candleCache: newCache });
      },

      // Invalidate cache
      invalidateCache: (pattern) => {
        const cache = get().candleCache;
        if (!pattern) {
          console.log('[ChartStore] Clearing entire cache');
          set({ candleCache: new Map() });
          return;
        }

        const newCache = new Map(cache);
        let removed = 0;

        cache.forEach((_, key) => {
          if (key.includes(pattern)) {
            newCache.delete(key);
            removed++;
          }
        });

        console.log(`[ChartStore] Invalidated ${removed} cache entries matching:`, pattern);
        set({ candleCache: newCache });
      },

      // Save view state
      saveViewState: (symbol, state) => {
        const newViewStates = new Map(get().viewStates);
        newViewStates.set(symbol, state);
        console.log('[ChartStore] Saved view state for:', symbol, state);
        set({ viewStates: newViewStates });
      },

      // Get view state
      getViewState: (symbol) => {
        const state = get().viewStates.get(symbol);
        if (state) {
          console.log('[ChartStore] Retrieved view state for:', symbol, state);
        }
        return state || null;
      },

      // Get cached metadata
      getCachedMetadata: (symbol) => {
        const cached = get().metadataCache[symbol];
        if (!cached) {
          console.log(
            '[ChartStore] Metadata cache miss for:',
            symbol,
            'Available keys:',
            Object.keys(get().metadataCache)
          );
          return null;
        }

        // Check if expired
        const now = Date.now();
        const age = now - cached.timestamp;
        if (age > CACHE_TTL) {
          console.log(
            '[ChartStore] Metadata cache expired for:',
            symbol,
            `age: ${(age / 1000).toFixed(0)}s`
          );
          // Remove expired entry
          const newCache = { ...get().metadataCache };
          delete newCache[symbol];
          set({ metadataCache: newCache });
          return null;
        }

        console.log('[ChartStore] Metadata cache hit for:', symbol);
        return { from: cached.from, to: cached.to };
      },

      // Set cached metadata
      setCachedMetadata: (symbol, from, to) => {
        const newCache = {
          ...get().metadataCache,
          [symbol]: {
            from,
            to,
            timestamp: Date.now(),
          },
        };
        console.log('[ChartStore] Cached metadata for:', symbol, { from, to });
        set({ metadataCache: newCache });
      },
    }),
    {
      name: 'chart-store',
    }
  )
);