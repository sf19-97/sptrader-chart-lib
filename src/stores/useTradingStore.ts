import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

interface TradingState {
  // Chart settings (from TradingContext)
  selectedPair: string;
  selectedTimeframe: string;
  chartType: 'candlestick' | 'line' | 'bar';
  chartVersion: 'v1' | 'v2';

  // Indicators
  indicators: {
    ma: boolean;
    rsi: boolean;
    macd: boolean;
    volume: boolean;
  };

  // Actions
  setPair: (pair: string) => void;
  setTimeframe: (tf: string) => void;
  setChartType: (type: 'candlestick' | 'line' | 'bar') => void;
  setChartVersion: (version: 'v1' | 'v2') => void;
  toggleIndicator: (indicator: keyof TradingState['indicators']) => void;
}

export const useTradingStore = create<TradingState>()(
  devtools(
    persist(
      (set) => ({
        // Initial state - matches TradingContext defaults
        selectedPair: 'EURUSD',
        selectedTimeframe: '1h',
        chartType: 'candlestick',
        chartVersion: 'v1',
        indicators: {
          ma: false,
          rsi: false,
          macd: false,
          volume: false,
        },

        // Actions - same API as TradingContext
        setPair: (pair) => {
          console.log('[TradingStore] setPair called with:', pair);
          set((state) => {
            console.log('[TradingStore] Current selectedPair:', state.selectedPair);
            console.log('[TradingStore] New selectedPair will be:', pair);
            return { selectedPair: pair };
          });
        },

        setTimeframe: (timeframe) => {
          console.log('[TradingStore] setTimeframe:', timeframe);
          set({ selectedTimeframe: timeframe });
        },

        setChartType: (chartType) => {
          console.log('[TradingStore] setChartType:', chartType);
          set({ chartType });
        },

        setChartVersion: (chartVersion) => {
          console.log('[TradingStore] setChartVersion:', chartVersion);
          set({ chartVersion });
        },

        toggleIndicator: (indicator) => {
          console.log('[TradingStore] toggleIndicator:', indicator);
          set((state) => ({
            indicators: {
              ...state.indicators,
              [indicator]: !state.indicators[indicator],
            },
          }));
        },
      }),
      {
        name: 'trading-storage',
        // Only persist user preferences, not UI state
        partialize: (state) => ({
          selectedPair: state.selectedPair,
          selectedTimeframe: state.selectedTimeframe,
          chartType: state.chartType,
          chartVersion: state.chartVersion,
          indicators: state.indicators,
        }),
      }
    ),
    {
      name: 'trading-store',
    }
  )
);

// Compatibility hook to ease migration
export const useTrading = () => {
  const state = useTradingStore();
  return {
    ...state,
    // Ensure complete compatibility with TradingContext API
    setTimeframe: state.setTimeframe,
  };
};
