import { useEffect, useRef, useState, useCallback } from 'react';
import { IChartApi, Time } from 'lightweight-charts';

export interface VisibleRange {
  from: number;
  to: number;
}

export interface UseChartZoomOptions {
  onBarSpacingChange?: (barSpacing: number) => void;
  onVisibleRangeChange?: (range: VisibleRange | null) => void;
  barSpacingCheckInterval?: number;
}

export interface UseChartZoomReturn {
  isShiftPressed: boolean;
  lockedLeftEdge: number | null;
  visibleRange: VisibleRange | null;
  barSpacing: number;
  zoomIn: (factor?: number) => void;
  zoomOut: (factor?: number) => void;
  resetZoom: () => void;
  scrollToTime: (time: number, animate?: boolean) => void;
  setVisibleRange: (range: VisibleRange) => void;
  maintainLeftEdgeLock: () => void;
}

/**
 * Hook to manage chart zoom functionality including:
 * - Shift key handling for left edge locking
 * - Visible range tracking
 * - Bar spacing monitoring
 * - Zoom utilities
 */
export function useChartZoom(
  chart: IChartApi | null,
  options?: UseChartZoomOptions
): UseChartZoomReturn {
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const [lockedLeftEdge, setLockedLeftEdge] = useState<number | null>(null);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const [barSpacing, setBarSpacing] = useState(12);

  const barSpacingCheckInterval = options?.barSpacingCheckInterval || 100;
  const lastBarSpacingRef = useRef(12);

  // Handle keyboard events for shift key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !isShiftPressed) {
        setIsShiftPressed(true);
        
        // Lock the left edge when shift is pressed
        if (chart && visibleRange) {
          setLockedLeftEdge(visibleRange.from);
          console.log(
            '[useChartZoom] Left edge locked at:',
            new Date(visibleRange.from * 1000).toISOString()
          );
          
          // Disable rightBarStaysOnScroll for locked zooming
          chart.timeScale().applyOptions({
            rightBarStaysOnScroll: false,
          });
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && isShiftPressed) {
        setIsShiftPressed(false);
        setLockedLeftEdge(null);
        console.log('[useChartZoom] Left edge lock released');
        
        // Re-enable rightBarStaysOnScroll
        if (chart) {
          chart.timeScale().applyOptions({
            rightBarStaysOnScroll: true,
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Clean up on unmount or if shift was pressed when component unmounts
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      
      // Reset state if component unmounts while shift is pressed
      if (isShiftPressed && chart) {
        chart.timeScale().applyOptions({
          rightBarStaysOnScroll: true,
        });
      }
    };
  }, [chart, isShiftPressed, visibleRange]);

  // Track visible range changes
  useEffect(() => {
    if (!chart) return;

    const handleVisibleRangeChange = () => {
      const range = chart.timeScale().getVisibleRange();
      if (range) {
        const newRange = {
          from: range.from as number,
          to: range.to as number,
        };
        setVisibleRange(newRange);
        options?.onVisibleRangeChange?.(newRange);
      } else {
        setVisibleRange(null);
        options?.onVisibleRangeChange?.(null);
      }
    };

    // Initial range
    handleVisibleRangeChange();

    // Subscribe to changes
    chart.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
    };
  }, [chart, options]);

  // Monitor bar spacing
  useEffect(() => {
    if (!chart) return;

    const checkBarSpacing = () => {
      try {
        const currentBarSpacing = chart.timeScale().options().barSpacing;
        
        if (currentBarSpacing !== lastBarSpacingRef.current) {
          console.log(
            `[useChartZoom] Bar spacing changed: ${lastBarSpacingRef.current} → ${currentBarSpacing}`
          );
          lastBarSpacingRef.current = currentBarSpacing;
          setBarSpacing(currentBarSpacing);
          options?.onBarSpacingChange?.(currentBarSpacing);
        }
      } catch (e) {
        // Chart might be disposed
        console.error('[useChartZoom] Error checking bar spacing:', e);
      }
    };

    const intervalId = setInterval(checkBarSpacing, barSpacingCheckInterval);

    return () => clearInterval(intervalId);
  }, [chart, barSpacingCheckInterval, options]);

  // Zoom in
  const zoomIn = useCallback((factor = 1.2) => {
    if (!chart) return;
    
    const timeScale = chart.timeScale();
    const currentBarSpacing = timeScale.options().barSpacing;
    const newBarSpacing = Math.min(currentBarSpacing * factor, 50); // Max bar spacing
    
    timeScale.applyOptions({ barSpacing: newBarSpacing });
  }, [chart]);

  // Zoom out
  const zoomOut = useCallback((factor = 1.2) => {
    if (!chart) return;
    
    const timeScale = chart.timeScale();
    const currentBarSpacing = timeScale.options().barSpacing;
    const newBarSpacing = Math.max(currentBarSpacing / factor, 2); // Min bar spacing
    
    timeScale.applyOptions({ barSpacing: newBarSpacing });
  }, [chart]);

  // Reset zoom to fit all data
  const resetZoom = useCallback(() => {
    if (!chart) return;
    
    chart.timeScale().fitContent();
  }, [chart]);

  // Scroll to specific time
  const scrollToTime = useCallback((time: number, animate = true) => {
    if (!chart || !visibleRange) return;
    
    const duration = visibleRange.to - visibleRange.from;
    const newFrom = time - duration / 2;
    const newTo = time + duration / 2;
    
    chart.timeScale().setVisibleRange({
      from: newFrom as Time,
      to: newTo as Time,
    });
    
    if (animate) {
      chart.timeScale().scrollToRealTime();
    }
  }, [chart, visibleRange]);

  // Set visible range
  const setVisibleRangeCallback = useCallback((range: VisibleRange) => {
    if (!chart) return;
    
    chart.timeScale().setVisibleRange({
      from: range.from as Time,
      to: range.to as Time,
    });
  }, [chart]);

  // Maintain left edge lock during zoom
  const maintainLeftEdgeLock = useCallback(() => {
    if (!chart || !isShiftPressed || lockedLeftEdge === null || !visibleRange) return;
    
    const currentDuration = visibleRange.to - visibleRange.from;
    const newTo = lockedLeftEdge + currentDuration;
    
    chart.timeScale().setVisibleRange({
      from: lockedLeftEdge as Time,
      to: newTo as Time,
    });
  }, [chart, isShiftPressed, lockedLeftEdge, visibleRange]);

  return {
    isShiftPressed,
    lockedLeftEdge,
    visibleRange,
    barSpacing,
    zoomIn,
    zoomOut,
    resetZoom,
    scrollToTime,
    setVisibleRange: setVisibleRangeCallback,
    maintainLeftEdgeLock,
  };
}