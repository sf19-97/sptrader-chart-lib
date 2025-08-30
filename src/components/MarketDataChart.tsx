/**
 * MARKET DATA CHART
 * Generic chart component for all market data (forex, bitcoin, crypto, etc.)
 * Based on the proven Bitcoin pattern with cascade aggregates
 *
 * Features:
 * - Fractal zoom with automatic timeframe switching
 * - Real-time data updates
 * - Works with any asset using the cascade pattern
 */

import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickSeries } from 'lightweight-charts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useChartStore } from '../stores/useChartStore';
import { Box } from '@mantine/core';
import { chartDataCoordinator, type SymbolMetadata } from '../services/ChartDataCoordinator';
import { CountdownTimer } from './CountdownTimer';
import { usePlaceholderCandle, calculateCandleTime } from '../hooks/usePlaceholderCandle';
import { getDaysToShowForTimeframe, setVisibleRangeByDays } from '../utils/chartHelpers';

interface ChartData {
  time: number; // Unix timestamp
  open: number;
  high: number;
  low: number;
  close: number;
}

interface MarketDataChartProps {
  symbol?: string;
  timeframe?: string;
  onTimeframeChange?: (timeframe: string) => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}


interface MarketTick {
  timestamp: string;
  symbol: string;
  bid: number;
  ask: number;
  last?: number;
}

interface StreamStatus {
  connected: boolean;
  message: string;
}

const MarketDataChart: React.FC<MarketDataChartProps> = ({
  symbol,
  timeframe,
  onTimeframeChange,
  isFullscreen = false,
  onToggleFullscreen,
}) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const [currentTimeframe, setCurrentTimeframe] = useState(timeframe || '1h');
  const currentTimeframeRef = useRef(timeframe || '1h');
  const symbolRef = useRef(symbol || 'EURUSD');
  const [isLoading, setIsLoading] = useState(false);
  const isTransitioningRef = useRef(false);
  const [chartOpacity, setChartOpacity] = useState(1);

  // Real-time streaming state
  const [streamStatus, setStreamStatus] = useState<StreamStatus>({
    connected: false,
    message: 'Not connected',
  });
  const [lastTick, setLastTick] = useState<MarketTick | null>(null);


  // Zustand store
  const {
    setCurrentTimeframe: setStoreTimeframe,
  } = useChartStore();

  // Placeholder candle management
  const {
    createPlaceholder,
    updateWithRealData,
    hasPlaceholder,
    getPlaceholderTime,
    resetTrigger,
  } = usePlaceholderCandle(seriesRef.current);

  // Transition cooldown tracking
  const lastTransitionRef = useRef<number>(0);
  const TRANSITION_COOLDOWN = 700; // Increased to match longer animation

  // Left edge locking
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  const lockedLeftEdgeRef = useRef<number | null>(null);

  // Interval tracking
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);


  // Track if initial load has been done
  const initialLoadDoneRef = useRef(false);

  // CRITICAL: Use bar spacing thresholds, not pixel widths
  const SWITCH_TO_5M_BAR_SPACING = 35; // When 15m bars are spread this wide, switch to 5m
  const SWITCH_TO_15M_BAR_SPACING = 32; // When 1h bars are spread this wide, switch to 15m
  const SWITCH_FROM_5M_BAR_SPACING = 7; // When 5m bars are squeezed this tight, switch to 15m
  const SWITCH_TO_1H_BAR_SPACING = 8; // When 15m bars are squeezed this tight, switch to 1h
  const SWITCH_TO_4H_BAR_SPACING = 8; // When 1h bars are squeezed this tight, switch to 4h
  const SWITCH_FROM_4H_BAR_SPACING = 32; // When 4h bars are spread this wide, switch to 1h
  const SWITCH_TO_12H_BAR_SPACING = 4; // When 4h bars are squeezed this tight, switch to 12h
  const SWITCH_FROM_12H_BAR_SPACING = 24; // When 12h bars are spread this wide, switch to 4h (3x factor)

  // Format prices
  const formatPrice = (price: number): string => {
    if (price >= 1000) {
      return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    }
    return `$${price.toFixed(2)}`;
  };

  // Get timeframe duration in seconds
  const getTimeframeSeconds = (timeframe: string): number => {
    switch (timeframe) {
      case '5m':
        return 5 * 60;
      case '15m':
        return 15 * 60;
      case '1h':
        return 60 * 60;
      case '4h':
        return 4 * 60 * 60;
      case '12h':
        return 12 * 60 * 60;
      default:
        return 60 * 60; // Default to 1h
    }
  };



  const fetchChartData = async (
    sym: string,
    tf: string,
    from?: number,
    to?: number
  ): Promise<{ data: ChartData[]; metadata: SymbolMetadata | null }> => {
    try {
      // Use coordinator for all data fetches
      const data = await chartDataCoordinator.fetchChartData(sym, tf, {
        range: from && to ? { from, to } : undefined
      });

      // Don't update dateRangeRef here - it should only be set during initial load

      // Get metadata separately if needed
      const metadata = await chartDataCoordinator.getSymbolMetadata(sym);

      return {
        data,
        metadata
      };
    } catch (error) {
      console.error(`Error fetching market chart data for ${sym} ${tf}:`, error);
      return { data: [], metadata: null };
    }
  };

  // Rest of the component logic remains the same as AdaptiveChart
  // Using generic market data fetching and formatting...

  const switchTimeframe = async (newTimeframe: string) => {
    if (newTimeframe === currentTimeframeRef.current || isTransitioningRef.current) return;

    console.log(
      '[ResolutionTracker] Timeframe transition:',
      currentTimeframeRef.current,
      '→',
      newTimeframe
    );

    // Check cooldown
    const now = Date.now();
    if (now - lastTransitionRef.current < TRANSITION_COOLDOWN) {
      console.log('[COOLDOWN] Too fast! Wait a bit...');
      return;
    }

    lastTransitionRef.current = now;
    isTransitioningRef.current = true;

    // Store current view before switching
    const timeScale = chartRef.current!.timeScale();
    const visibleRange = timeScale.getVisibleRange();
    const currentBarSpacing = timeScale.options().barSpacing;
    const previousTimeframe = currentTimeframeRef.current;

    console.log(
      `[ResolutionTracker] Executing transition: ${previousTimeframe} → ${newTimeframe} at bar spacing ${currentBarSpacing}`
    );

    // Update state
    currentTimeframeRef.current = newTimeframe;
    setCurrentTimeframe(newTimeframe);
    setStoreTimeframe(newTimeframe);
    if (onTimeframeChange) {
      onTimeframeChange(newTimeframe);
    }

    // Start fade out
    setChartOpacity(0.2);

    // Wait for fade out
    await new Promise((resolve) => setTimeout(resolve, 250));

    try {
      // Let coordinator use its default range for this timeframe
      console.log(`[switchTimeframe] Starting fetch for ${symbolRef.current} ${newTimeframe}`);
      
      // Add timeout to prevent hanging - increase to 30s for slow backend
      const fetchPromise = fetchChartData(symbolRef.current!, newTimeframe);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Fetch timeout after 30s')), 30000)
      );
      
      const { data } = await Promise.race([fetchPromise, timeoutPromise]) as { data: ChartData[] };
      
      console.log(`[switchTimeframe] Fetch completed, got ${data.length} candles`);

      if (data.length === 0) {
        console.error(`[SWITCH] No data available for ${newTimeframe} - aborting transition`);
        // Revert the transition
        currentTimeframeRef.current = previousTimeframe;
        setCurrentTimeframe(previousTimeframe);
        setStoreTimeframe(previousTimeframe);
        // Fade back in
        setChartOpacity(1);
        isTransitioningRef.current = false;
        return;
      }

      if (data.length > 0 && seriesRef.current && chartRef.current) {
        // Calculate new bar spacing
        let newBarSpacing = currentBarSpacing;

        if (newTimeframe === '5m' && previousTimeframe === '15m') {
          newBarSpacing = Math.max(3, currentBarSpacing / 3);
        } else if (newTimeframe === '15m' && previousTimeframe === '5m') {
          newBarSpacing = Math.min(50, currentBarSpacing * 3);
        } else if (newTimeframe === '15m' && previousTimeframe === '1h') {
          newBarSpacing = Math.max(3, currentBarSpacing / 4);
        } else if (newTimeframe === '1h' && previousTimeframe === '15m') {
          newBarSpacing = Math.min(50, currentBarSpacing * 4);
        } else if (newTimeframe === '1h' && previousTimeframe === '4h') {
          newBarSpacing = Math.max(3, currentBarSpacing / 4);
        } else if (newTimeframe === '4h' && previousTimeframe === '1h') {
          newBarSpacing = Math.min(50, currentBarSpacing * 4);
        } else if (newTimeframe === '4h' && previousTimeframe === '12h') {
          newBarSpacing = Math.max(3, currentBarSpacing / 3);
        } else if (newTimeframe === '12h' && previousTimeframe === '4h') {
          newBarSpacing = Math.min(50, currentBarSpacing * 3);
        }

        // Apply bar spacing before setting data
        chartRef.current.timeScale().applyOptions({
          barSpacing: newBarSpacing,
        });

        // Wait for next animation frame to ensure display surface is ready
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        
        // Update data - use setData directly for timeframe switches
        console.log(`[switchTimeframe] Setting ${data.length} candles on series`);
        seriesRef.current.setData(data as any);
        console.log(`[switchTimeframe] Data set complete`);

        // Maintain view range
        if (visibleRange) {
          if (isShiftPressed && lockedLeftEdgeRef.current !== null) {
            // Keep left edge locked
            const currentDuration = (visibleRange.to as number) - (visibleRange.from as number);
            const ratio =
              newTimeframe === previousTimeframe
                ? 1
                : newTimeframe === '5m' && previousTimeframe === '15m'
                      ? 3
                      : newTimeframe === '15m' && previousTimeframe === '5m'
                        ? 0.33
                        : newTimeframe === '15m' && previousTimeframe === '1h'
                          ? 4
                          : newTimeframe === '1h' && previousTimeframe === '15m'
                            ? 0.25
                            : newTimeframe === '1h' && previousTimeframe === '4h'
                              ? 4
                              : newTimeframe === '4h' && previousTimeframe === '1h'
                                ? 0.25
                                : newTimeframe === '4h' && previousTimeframe === '12h'
                                  ? 3
                                  : newTimeframe === '12h' && previousTimeframe === '4h'
                                    ? 0.33
                                    : 1;

            const newDuration = currentDuration / ratio;
            const newTo = lockedLeftEdgeRef.current + newDuration;

            chartRef.current.timeScale().setVisibleRange({
              from: lockedLeftEdgeRef.current as any,
              to: newTo as any,
            });
          } else {
            // Normal behavior
            chartRef.current.timeScale().setVisibleRange({
              from: visibleRange.from as any,
              to: visibleRange.to as any,
            });
          }
        }
      }

      // Fade back in
      setChartOpacity(1);
      console.log(`[switchTimeframe] Transition complete to ${newTimeframe}`);
    } catch (error) {
      console.error('[switchTimeframe] Failed to switch timeframe:', error);
      // Revert everything on error
      currentTimeframeRef.current = previousTimeframe;
      setCurrentTimeframe(previousTimeframe);
      setStoreTimeframe(previousTimeframe);
      setChartOpacity(1);
    } finally {
      console.log(`[switchTimeframe] Setting isTransitioningRef to false`);
      isTransitioningRef.current = false;
    }
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    console.log('[MarketDataChart] Creating chart');

    // Declare variables that need to be accessible in cleanup
    let crosshairUnsubscribe: any;

    // Create chart - matching AdaptiveChart exactly
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#0a0a0a' },
        textColor: '#ffffff',
      },
      grid: {
        vertLines: { color: '#1a2a3a' },
        horzLines: { color: '#1a2a3a' },
      },
      crosshair: {
        mode: 0, // Normal mode - shows both crosshair lines
        vertLine: {
          color: '#758696',
          width: 1,
          style: 3, // Dashed
          labelBackgroundColor: '#2B2B43',
        },
        horzLine: {
          color: '#758696',
          width: 1,
          style: 3, // Dashed
          labelBackgroundColor: '#2B2B43',
        },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        barSpacing: 12, // Default bar spacing
        minBarSpacing: 2, // Prevent excessive zoom out
        rightOffset: 5, // Small margin on the right
        rightBarStaysOnScroll: true, // Keep the latest bar in view when scrolling
        tickMarkFormatter: (time: number, tickMarkType: number, locale: string) => {
          // Convert UTC timestamp to local time for axis labels
          const date = new Date(time * 1000);

          // Format based on the tick mark type
          if (tickMarkType === 0) {
            // Year
            return date.getFullYear().toString();
          } else if (tickMarkType === 1) {
            // Month
            const months = [
              'Jan',
              'Feb',
              'Mar',
              'Apr',
              'May',
              'Jun',
              'Jul',
              'Aug',
              'Sep',
              'Oct',
              'Nov',
              'Dec',
            ];
            return months[date.getMonth()];
          } else if (tickMarkType === 2) {
            // DayOfMonth
            return date.getDate().toString();
          } else if (tickMarkType === 3) {
            // Time
            const hours = date.getHours();
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12; // Convert 0 to 12
            return `${displayHours}:${minutes} ${ampm}`;
          } else if (tickMarkType === 4) {
            // TimeWithSeconds
            const hours = date.getHours();
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const displayHours = hours % 12 || 12; // Convert 0 to 12
            return `${displayHours}:${minutes}:${seconds} ${ampm}`;
          }

          // Default fallback
          return date.toLocaleString();
        },
      },
      localization: {
        timeFormatter: (timestamp: number) => {
          // Convert UTC timestamp to local time (12-hour format)
          const date = new Date(timestamp * 1000);
          const hours = date.getHours();
          const minutes = date.getMinutes().toString().padStart(2, '0');
          const ampm = hours >= 12 ? 'PM' : 'AM';
          const displayHours = hours % 12 || 12; // Convert 0 to 12
          return `${displayHours}:${minutes} ${ampm}`;
        },
      },
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00ff88',
      downColor: '#ff4976',
      borderVisible: false,
      wickUpColor: '#00ff88',
      wickDownColor: '#ff4976',
      priceFormat: {
        type: 'custom',
        formatter: formatPrice,
      },
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    // Create crosshair tooltip
    const toolTip = document.createElement('div');
    toolTip.style.cssText = `
      position: absolute;
      display: none;
      padding: 8px;
      box-sizing: border-box;
      font-size: 12px;
      text-align: left;
      z-index: 1000;
      top: 12px;
      left: 12px;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.8);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    chartContainerRef.current.appendChild(toolTip);

    // Subscribe to crosshair move
    const unsubscribe = chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.has(candlestickSeries)) {
        toolTip.style.display = 'none';
        return;
      }

      const data = param.seriesData.get(candlestickSeries) as any;
      const timestamp =
        typeof param.time === 'string'
          ? parseInt(param.time) * 1000
          : (param.time as number) * 1000;
      const date = new Date(timestamp);

      // Format date and time
      const dateStr = date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      const timeStr = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      toolTip.style.display = 'block';
      toolTip.innerHTML = `
        <div style="color: #999; margin-bottom: 4px">${dateStr} ${timeStr}</div>
        <div style="color: #fff">O: ${formatPrice(data.open)}</div>
        <div style="color: #fff">H: ${formatPrice(data.high)}</div>
        <div style="color: #fff">L: ${formatPrice(data.low)}</div>
        <div style="color: ${data.close >= data.open ? '#00ff88' : '#ff4976'}">C: ${formatPrice(data.close)}</div>
      `;
    });

    // Store the unsubscribe function
    crosshairUnsubscribe = unsubscribe;

    // Handle resize
    const handleResize = () => {
      chart.applyOptions({
        width: chartContainerRef.current!.clientWidth,
        height: chartContainerRef.current!.clientHeight,
      });
    };

    // CRITICAL: Monitor BAR SPACING changes instead of pixel widths
    let lastBarSpacing = 13;

    // Define checkTimeframeSwitch inside useEffect to access current state/refs
    const checkTimeframeSwitch = (barSpacing: number) => {
      console.log(`[checkTimeframeSwitch] Called with barSpacing: ${barSpacing}`);
      console.log(`[checkTimeframeSwitch] isTransitioningRef.current: ${isTransitioningRef.current}`);
      console.log(`[checkTimeframeSwitch] currentTimeframeRef.current: ${currentTimeframeRef.current}`);
      
      if (isTransitioningRef.current) {
        console.log('[SWITCH] Skipping - transition in progress');
        return; // Silent skip during transitions
      }

      const currentTf = currentTimeframeRef.current;

      // Enforce minimum bar spacing for 12h to prevent excessive zoom out
      if (currentTf === '12h' && barSpacing < 3) {
        console.log('[ZOOM LIMIT] Enforcing minimum bar spacing for 12h');
        chartRef.current?.timeScale().applyOptions({
          barSpacing: 3,
        });
        return;
      }

      // 12h → 4h (zooming in)
      if (currentTf === '12h' && barSpacing > SWITCH_FROM_12H_BAR_SPACING) {
        console.log(
          `[SWITCH] 12h bar spacing ${barSpacing} > ${SWITCH_FROM_12H_BAR_SPACING} → switching to 4h`
        );
        switchTimeframe('4h');
      }
      // 4h → 12h (zooming out)
      else if (currentTf === '4h' && barSpacing < SWITCH_TO_12H_BAR_SPACING) {
        console.log(
          `[SWITCH] 4h bar spacing ${barSpacing} < ${SWITCH_TO_12H_BAR_SPACING} → switching to 12h`
        );
        switchTimeframe('12h');
      }
      // 4h → 1h (zooming in)
      else if (currentTf === '4h' && barSpacing > SWITCH_FROM_4H_BAR_SPACING) {
        console.log(
          `[SWITCH] 4h bar spacing ${barSpacing} > ${SWITCH_FROM_4H_BAR_SPACING} → switching to 1h`
        );
        switchTimeframe('1h');
      }
      // 1h → 4h (zooming out)
      else if (currentTf === '1h' && barSpacing < SWITCH_TO_4H_BAR_SPACING) {
        console.log(
          `[SWITCH] 1h bar spacing ${barSpacing} < ${SWITCH_TO_4H_BAR_SPACING} → switching to 4h`
        );
        switchTimeframe('4h');
      }
      // 1h → 15m (zooming in)
      else if (currentTf === '1h' && barSpacing > SWITCH_TO_15M_BAR_SPACING) {
        console.log(
          `[SWITCH] 1h bar spacing ${barSpacing} > ${SWITCH_TO_15M_BAR_SPACING} → switching to 15m`
        );
        switchTimeframe('15m');
      }
      // 15m → 1h (zooming out)
      else if (currentTf === '15m' && barSpacing < SWITCH_TO_1H_BAR_SPACING) {
        console.log(
          `[SWITCH] 15m bar spacing ${barSpacing} < ${SWITCH_TO_1H_BAR_SPACING} → switching to 1h`
        );
        switchTimeframe('1h');
      }
      // 15m → 5m (zooming in)
      else if (currentTf === '15m' && barSpacing > SWITCH_TO_5M_BAR_SPACING) {
        console.log(
          `[SWITCH] 15m bar spacing ${barSpacing} > ${SWITCH_TO_5M_BAR_SPACING} → switching to 5m`
        );
        switchTimeframe('5m');
      }
      // 5m → 15m (zooming out)
      else if (currentTf === '5m' && barSpacing < SWITCH_FROM_5M_BAR_SPACING) {
        console.log(
          `[SWITCH] 5m bar spacing ${barSpacing} < ${SWITCH_FROM_5M_BAR_SPACING} → switching to 15m`
        );
        switchTimeframe('15m');
      }
    };

    checkIntervalRef.current = setInterval(() => {
      if (!chartRef.current) {
        console.log('[ResolutionTracker] Chart not ready');
        return;
      }
      
      if (isTransitioningRef.current) {
        console.log('[ResolutionTracker] Skipping check - transition in progress');
        return;
      }

      try {
        const currentBarSpacing = chartRef.current.timeScale().options().barSpacing;

        if (currentBarSpacing !== lastBarSpacing) {
          console.log(
            `[ResolutionTracker] Current timeframe: ${currentTimeframeRef.current}, bar spacing: ${currentBarSpacing} (was: ${lastBarSpacing})`
          );
          console.log(`[ResolutionTracker] isTransitioningRef.current = ${isTransitioningRef.current}`);
          console.log(`[ResolutionTracker] About to call checkTimeframeSwitch`);
          lastBarSpacing = currentBarSpacing;
          checkTimeframeSwitch(currentBarSpacing);
        }
      } catch (e) {
        console.error('[ResolutionTracker] Error in interval:', e);
        // Chart might be disposed, clear interval
        if (checkIntervalRef.current) {
          clearInterval(checkIntervalRef.current);
          checkIntervalRef.current = null;
        }
      }
    }, 100); // Check every 100ms

    // Handle Shift key for left edge locking
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && !isShiftPressed) {
        setIsShiftPressed(true);
        const timeScale = chartRef.current?.timeScale();
        if (timeScale) {
          const visibleRange = timeScale.getVisibleRange();
          if (visibleRange) {
            lockedLeftEdgeRef.current = visibleRange.from as number;
            console.log(
              '[LOCK LEFT] Activated, locking left edge at:',
              new Date((visibleRange.from as number) * 1000).toISOString()
            );
            // Disable rightBarStaysOnScroll temporarily
            timeScale.applyOptions({
              rightBarStaysOnScroll: false,
            });
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftPressed(false);
        lockedLeftEdgeRef.current = null;
        console.log('[LOCK LEFT] Released, re-enabling right lock');
        // Re-enable rightBarStaysOnScroll
        chartRef.current?.timeScale().applyOptions({
          rightBarStaysOnScroll: true,
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
      // Unsubscribe from crosshair
      if (crosshairUnsubscribe && typeof crosshairUnsubscribe === 'function') {
        crosshairUnsubscribe();
      }
      // Remove tooltip
      if (toolTip && toolTip.parentNode) {
        toolTip.parentNode.removeChild(toolTip);
      }
      chart.remove();
    };
  }, []); // Only create chart once

  // Initial load effect
  useEffect(() => {
    if (initialLoadDoneRef.current) {
      console.log('[MarketDataChart] Initial load already done, skipping');
      return;
    }

    let mounted = true;
    const loadInitialData = async () => {
      if (
        !mounted ||
        initialLoadDoneRef.current ||
        !seriesRef.current ||
        !chartRef.current ||
        !symbol
      )
        return;

      console.log('[MarketDataChart] Initial load triggered');
      initialLoadDoneRef.current = true;

      setIsLoading(true);
      symbolRef.current = symbol;
      currentTimeframeRef.current = timeframe || '1h';

      try {
        // Use dynamic sliding window that includes current time
        const now = Math.floor(Date.now() / 1000);
        const to = now + 60 * 60; // 1 hour into the future for ongoing candles

        // Use appropriate window based on timeframe
        let from;
        if (currentTimeframeRef.current === '5m') {
          from = now - 30 * 24 * 60 * 60; // 30 days for 5m
        } else {
          from = now - 90 * 24 * 60 * 60; // 90 days for others
        }
        
        // Set this as the default range for this symbol/timeframe combination
        chartDataCoordinator.setDefaultRange(
          symbol || 'EURUSD',
          currentTimeframeRef.current,
          from,
          to
        );
        
        const { data } = await fetchChartData(
          symbol || 'EURUSD',
          currentTimeframeRef.current,
          from,
          to
        );
        if (data.length > 0) {
          // For initial load, set data directly since placeholder hook isn't ready yet
          if (seriesRef.current && !hasPlaceholder()) {
            seriesRef.current.setData(data as any);
          } else {
            updateWithRealData(data as any);
          }
          // Generate cache key using the same from/to values we used for fetching

          // Set appropriate default view based on timeframe
          if (chartRef.current && data.length > 0) {
            const daysToShow = getDaysToShowForTimeframe(currentTimeframeRef.current);
            setVisibleRangeByDays(chartRef.current, daysToShow);
            console.log(`[MarketDataChart] Set visible range to ${daysToShow} days for ${currentTimeframeRef.current}`);
          }
        }
      } catch (error) {
        console.error('Error loading market chart data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadInitialData();
    return () => {
      mounted = false;
    };
  }, []); // Only run once on mount

  // Handle external timeframe changes
  useEffect(() => {
    if (
      timeframe &&
      timeframe !== currentTimeframeRef.current &&
      !isTransitioningRef.current &&
      initialLoadDoneRef.current
    ) {
      console.log(`[EXTERNAL] Switching to ${timeframe} from external control`);
      switchTimeframe(timeframe);
    }
  }, [timeframe]);

  // Handle symbol prop changes
  useEffect(() => {
    if (!symbol) return;

    const prevSymbol = symbolRef.current;
    symbolRef.current = symbol;

    // Only reload if symbol actually changed AND initial load is done
    if (
      prevSymbol !== symbol &&
      chartRef.current &&
      initialLoadDoneRef.current &&
      prevSymbol !== undefined
    ) {
      console.log('[MarketDataChart] Symbol changed from', prevSymbol, 'to', symbol);

      // Clear existing chart data immediately
      if (seriesRef.current) {
        console.log('[MarketDataChart] Clearing chart data for symbol change');
        seriesRef.current.setData([]);
      }

      // Reset symbol-specific state
      setIsLoading(true);
      // Reset placeholder state via the hook
      if (resetTrigger) {
        resetTrigger();
      }

      // Reload data for new symbol using coordinator's default range
      fetchChartData(symbol, currentTimeframeRef.current)
        .then(({ data }) => {
          if (data.length > 0 && seriesRef.current) {
            // Direct setData for symbol change
            seriesRef.current.setData(data as any);
            // Cache will be handled by the coordinator
          }
        })
        .catch((error) => console.error('[MarketDataChart] Error loading new symbol:', error))
        .finally(() => setIsLoading(false));
    }
  }, [symbol]);

  // Real-time data streaming effect
  useEffect(() => {
    console.log('[MarketDataChart] Real-time streaming effect triggered');
    let mounted = true;
    let unlistenStatus: (() => void) | undefined;
    let unlistenCandle: (() => void) | undefined;

    const startStreaming = async () => {
      try {
        // Start the candle update monitor
        console.log('[MarketDataChart] Starting candle update monitor...');
        await invoke('start_candle_monitor');
        console.log('[MarketDataChart] Candle monitor started successfully');

        // Listen for candle update events specific to current timeframe
        const updateListener = async () => {
          // Clean up previous listener
          if (unlistenCandle) {
            unlistenCandle();
          }

          // Listen for updates to the current timeframe
          const eventName = `market-candles-updated-${currentTimeframeRef.current}`;
          console.log(`[MarketDataChart] Listening for ${eventName} events`);

          unlistenCandle = await listen<{ symbol: string; timeframe: string; timestamp: string }>(
            eventName,
            (event) => {
              if (!mounted) return;
              console.log('[MarketDataChart] Candle update received:', event.payload);

              // Just log the update - periodic refresh will handle data fetching
              if (event.payload.timeframe === currentTimeframeRef.current) {
                console.log('[MarketDataChart] Candle update notification received, periodic refresh will handle it');
              }
            }
          );
        };

        await updateListener();

        // Listen for connection status
        unlistenStatus = await listen<StreamStatus>('market-stream-status', (event) => {
          if (!mounted) return;
          console.log('[MarketDataChart] Stream status:', event.payload);
          setStreamStatus(event.payload);
        });
      } catch (error) {
        console.error('[MarketDataChart] Failed to start market stream:', error);
        if (mounted) {
          setStreamStatus({ connected: false, message: `Error: ${error}` });
        }
      }
    };

    startStreaming();

    // Cleanup
    return () => {
      mounted = false;
      if (unlistenStatus) unlistenStatus();
      if (unlistenCandle) unlistenCandle();

      // Stop the candle monitor when component unmounts
      console.log('[MarketDataChart] Stopping candle monitor on unmount');
      invoke('stop_candle_monitor').catch(console.error);
    };
  }, []); // Only run once on mount

  // Simple periodic refresh to catch aggregate updates
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // Calculate initial delay to sync with clock
    const now = new Date();
    const currentSecond = now.getSeconds();
    // Target times: 1 second after cascade runs (:01, :06, :11, etc)
    const targets = [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57];

    let nextTarget = targets.find((t) => t > currentSecond);
    if (!nextTarget) {
      nextTarget = targets[0] + 60; // Wrap to next minute
    }

    let delaySeconds = nextTarget - currentSecond;
    if (delaySeconds > 60) {
      delaySeconds -= 60;
    }

    console.log(
      `[MarketDataChart] Syncing periodic refresh - current: :${currentSecond}, next: :${nextTarget % 60}, delay: ${delaySeconds}s`
    );

    // Initial delay to sync with clock
    timeoutId = setTimeout(() => {
      // Now start the interval, properly aligned
      intervalId = setInterval(() => {
        // Only refresh if we have a chart and not loading or transitioning
        if (chartRef.current && !isLoading && !isTransitioningRef.current) {
          console.log('[MarketDataChart] Periodic refresh check at', new Date().toLocaleTimeString());

          // Use coordinator's default range for consistent cache keys
          // The coordinator handles normalization and cache management
          fetchChartData(symbolRef.current!, currentTimeframeRef.current)
            .then(({ data }) => {
              if (data.length > 0 && seriesRef.current) {
                const currentData = seriesRef.current.data();

                // The placeholder update is now handled by updateWithRealData
                // No need to manually check for placeholders

                // Merge new data with existing data
                if (currentData.length > 0 && data.length > 0) {
                  // Find the overlap point
                  const firstNewTime = data[0].time;
                  const existingIndex = currentData.findIndex(
                    (c) => (c.time as number) >= firstNewTime
                  );

                  let mergedData;
                  if (existingIndex >= 0) {
                    // Check if we have a placeholder that would be removed
                    const placeholderTime = getPlaceholderTime && getPlaceholderTime();
                    let preservedPlaceholder = null;

                    if (placeholderTime && placeholderTime > 0) {
                      // Check if the placeholder exists in current data but not in new data
                      const placeholderInCurrent = currentData.find(
                        (c: any) => c.time === placeholderTime
                      );
                      const placeholderInNew = data.find(
                        (c: ChartData) => c.time === placeholderTime
                      );

                      if (placeholderInCurrent && !placeholderInNew) {
                        // Preserve the placeholder
                        preservedPlaceholder = placeholderInCurrent;
                        console.log(
                          '[MarketDataChart] Preserving placeholder candle at',
                          new Date(placeholderTime * 1000).toLocaleTimeString()
                        );
                      }
                    }

                    // Keep old data before the overlap, use new data from overlap point
                    mergedData = [...currentData.slice(0, existingIndex), ...data];

                    // Add back the placeholder if it was removed
                    if (preservedPlaceholder) {
                      // Find the correct position to insert the placeholder
                      const insertIndex = mergedData.findIndex(
                        (c: any) => c.time > (preservedPlaceholder as any).time
                      );
                      if (insertIndex >= 0) {
                        mergedData.splice(insertIndex, 0, preservedPlaceholder);
                      } else {
                        mergedData.push(preservedPlaceholder);
                      }
                    }
                  } else {
                    // New data is all after existing data
                    mergedData = [...currentData, ...data];
                  }

                  console.log(
                    `[MarketDataChart] Merging data: ${currentData.length} existing + ${data.length} new = ${mergedData.length} total`
                  );
                  updateWithRealData(mergedData as any);

                  // Don't update cache for partial refreshes
                } else if (data.length > 0) {
                  // No existing data, just set new data
                  console.log('[MarketDataChart] Setting initial data');
                  updateWithRealData(data as any);
                }
              }
            })
            .catch((error) => console.error('[MarketDataChart] Periodic refresh error:', error));
        }
      }, 30000); // PERFORMANCE FIX: Changed from 5s to 30s
      // Was hammering the database with requests every 5 seconds
      // Combined with timestamp normalization, this dramatically reduces load
    }, delaySeconds * 1000);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, []); // No dependencies needed since we use refs


  // Regular mode
  return (
    <Box style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={chartContainerRef}
        style={{
          width: '100%',
          height: '100%',
          background: '#0a0a0a',
          position: 'relative',
          opacity: chartOpacity,
          transition: 'opacity 300ms ease-in-out',
        }}
      >
        {isLoading && (
          <div
            style={{
              position: 'absolute',
              top: '10px',
              right: '10px',
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              padding: '5px 10px',
              borderRadius: '4px',
              fontSize: '12px',
            }}
          >
            Loading...
          </div>
        )}

        <div
          style={{
            position: 'absolute',
            top: '10px',
            left: '10px',
            background: 'rgba(0,0,0,0.7)',
            color: '#00ff88',
            padding: '5px 10px',
            borderRadius: '4px',
            fontSize: '12px',
            fontFamily: 'monospace',
          }}
        >
          {currentTimeframe}
          {isShiftPressed && (
            <span style={{ marginLeft: '10px', color: '#ff9900' }}>[LOCK LEFT]</span>
          )}
        </div>

        {/* Countdown Timer */}
        <CountdownTimer
          timeframe={currentTimeframe}
          position="bottom-right"
          offset={{ x: 10, y: 10 }}
          onNewCandleBoundary={(time) => {
            const candleTime = calculateCandleTime(time, currentTimeframe);
            createPlaceholder(candleTime);
          }}
        />
      </div>
    </Box>
  );
};

export default MarketDataChart;
