import { useEffect, useRef, useCallback } from 'react';
import { useChartZoom } from './useChartZoom';
import { IChartApi } from 'lightweight-charts';
import { TIMEFRAME_SWITCH_THRESHOLDS } from '../constants/timeframes';

interface UseAutoTimeframeSwitchOptions {
  enabled?: boolean;
  cooldownMs?: number;
  onTimeframeChange?: (newTimeframe: string) => void;
}

interface UseAutoTimeframeSwitchReturn {
  barSpacing: number;
  isShiftPressed: boolean;
  shouldSwitch: boolean;
  suggestedTimeframe: string | null;
}

/**
 * Hook to handle automatic timeframe switching based on zoom level
 * 
 * @param chart - The chart instance
 * @param currentTimeframe - Current timeframe
 * @param options - Configuration options
 */
export function useAutoTimeframeSwitch(
  chart: IChartApi | null,
  currentTimeframe: string,
  options?: UseAutoTimeframeSwitchOptions
): UseAutoTimeframeSwitchReturn {
  const { enabled = true, cooldownMs = 700, onTimeframeChange } = options || {};
  
  const lastSwitchRef = useRef<number>(0);
  const suggestedTimeframeRef = useRef<string | null>(null);
  
  // Use zoom hook to monitor bar spacing
  const { barSpacing, isShiftPressed } = useChartZoom(chart, {
    onBarSpacingChange: (spacing) => {
      if (!enabled) return;
      
      // Check if we should switch
      const suggestion = getSuggestedTimeframe(currentTimeframe, spacing);
      suggestedTimeframeRef.current = suggestion;
      
      // Apply cooldown and trigger change
      if (suggestion && Date.now() - lastSwitchRef.current > cooldownMs) {
        console.log(
          `[useAutoTimeframeSwitch] Suggesting switch from ${currentTimeframe} to ${suggestion} (bar spacing: ${spacing})`
        );
        lastSwitchRef.current = Date.now();
        onTimeframeChange?.(suggestion);
      }
    },
  });

  // Helper to determine suggested timeframe
  const getSuggestedTimeframe = useCallback((timeframe: string, spacing: number): string | null => {
    const threshold = TIMEFRAME_SWITCH_THRESHOLDS[timeframe as keyof typeof TIMEFRAME_SWITCH_THRESHOLDS];
    if (!threshold) return null;

    // Check zoom out conditions
    if (spacing < threshold.zoomOut) {
      switch (timeframe) {
        case '5m': return '15m';
        case '15m': return '1h';
        case '1h': return '4h';
        case '4h': return '12h';
        default: return null;
      }
    }

    // Check zoom in conditions
    if (spacing > threshold.zoomIn) {
      switch (timeframe) {
        case '15m': return '5m';
        case '1h': return '15m';
        case '4h': return '1h';
        case '12h': return '4h';
        default: return null;
      }
    }

    return null;
  }, []);

  // Reset cooldown when timeframe changes externally
  useEffect(() => {
    lastSwitchRef.current = Date.now();
  }, [currentTimeframe]);

  return {
    barSpacing,
    isShiftPressed,
    shouldSwitch: suggestedTimeframeRef.current !== null,
    suggestedTimeframe: suggestedTimeframeRef.current,
  };
}

