import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { debounce } from 'lodash';

interface SaveChartStateParams {
  symbol: string;
  timeframe: string;
  visibleRange: { from: number; to: number } | null;
  barSpacing: number;
}

export function useChartSessionPersistence() {
  const saveChartStateDebounced = useRef(
    debounce(async (params: SaveChartStateParams) => {
      if (!params.visibleRange) return;
      
      try {
        await invoke('save_chart_state', {
          symbol: params.symbol,
          timeframe: params.timeframe,
          visibleRangeFrom: params.visibleRange.from,
          visibleRangeTo: params.visibleRange.to,
          barSpacing: params.barSpacing,
        });
        console.log('[Session] Saved chart state');
      } catch (error) {
        console.error('[Session] Failed to save chart state:', error);
      }
    }, 2000) // Save after 2 seconds of no changes
  );

  const saveChartState = (params: SaveChartStateParams) => {
    saveChartStateDebounced.current(params);
  };

  // Cleanup
  useEffect(() => {
    return () => {
      saveChartStateDebounced.current.cancel();
    };
  }, []);

  return { saveChartState };
}