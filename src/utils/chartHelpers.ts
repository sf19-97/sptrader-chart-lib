import { IChartApi, ISeriesApi, Time } from 'lightweight-charts';

/**
 * Calculate the appropriate bar spacing when switching timeframes
 * Maintains visual continuity during transitions
 */
export function calculateBarSpacingForTimeframeSwitch(
  currentBarSpacing: number,
  fromTimeframe: string,
  toTimeframe: string
): number {
  // Define multipliers for timeframe transitions
  const transitions: Record<string, number> = {
    '5m->15m': 3,
    '15m->5m': 1 / 3,
    '15m->1h': 4,
    '1h->15m': 1 / 4,
    '1h->4h': 4,
    '4h->1h': 1 / 4,
    '4h->12h': 3,
    '12h->4h': 1 / 3,
  };

  const key = `${fromTimeframe}->${toTimeframe}`;
  const multiplier = transitions[key] || 1;

  // Apply multiplier and clamp to reasonable bounds
  const newBarSpacing = currentBarSpacing * multiplier;
  return Math.max(3, Math.min(50, newBarSpacing));
}

/**
 * Calculate days to show based on timeframe
 * Used for initial chart view
 */
export function getDaysToShowForTimeframe(timeframe: string): number {
  switch (timeframe) {
    case '5m':
      return 2;
    case '15m':
      return 3;
    case '1h':
      return 7;
    case '4h':
      return 14;
    case '12h':
      return 30;
    default:
      return 7;
  }
}

/**
 * Set the visible range to show a specific number of days
 */
export function setVisibleRangeByDays(chart: IChartApi, days: number): void {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;
  
  chart.timeScale().setVisibleRange({
    from: from as Time,
    to: now as Time,
  });
}

/**
 * Get the current visible range duration in seconds
 */
export function getVisibleRangeDuration(chart: IChartApi): number {
  const range = chart.timeScale().getVisibleRange();
  if (!range) return 0;
  
  return (range.to as number) - (range.from as number);
}

/**
 * Check if a specific time is visible on the chart
 */
export function isTimeVisible(chart: IChartApi, time: number): boolean {
  const range = chart.timeScale().getVisibleRange();
  if (!range) return false;
  
  return time >= (range.from as number) && time <= (range.to as number);
}

/**
 * Scroll to a specific time, optionally centering it
 */
export function scrollToTime(chart: IChartApi, time: number, center = true): void {
  if (center) {
    const range = chart.timeScale().getVisibleRange();
    if (range) {
      const duration = (range.to as number) - (range.from as number);
      chart.timeScale().setVisibleRange({
        from: (time - duration / 2) as Time,
        to: (time + duration / 2) as Time,
      });
    }
  } else {
    chart.timeScale().scrollToPosition(0, false);
    chart.timeScale().scrollToRealTime();
  }
}

/**
 * Find the last real candle (non-placeholder) in series data
 */
export function findLastRealCandle(series: ISeriesApi<'Candlestick'>): any | null {
  const data = series.data();
  if (data.length === 0) return null;
  
  // Placeholders typically have all OHLC values the same
  for (let i = data.length - 1; i >= 0; i--) {
    const candle = data[i];
    if (candle.open !== candle.high || 
        candle.open !== candle.low || 
        candle.open !== candle.close) {
      return candle;
    }
  }
  
  return data[data.length - 1];
}

/**
 * Create a placeholder candle for the current time period
 */
export function createPlaceholderCandle(
  lastCandle: any,
  timeframe: string,
  currentTime: number
): any {
  // Calculate the start of the current candle period
  const periodSeconds = getTimeframePeriodSeconds(timeframe);
  const candleTime = Math.floor(currentTime / periodSeconds) * periodSeconds;
  
  return {
    time: candleTime,
    open: lastCandle.close,
    high: lastCandle.close,
    low: lastCandle.close,
    close: lastCandle.close,
  };
}

/**
 * Get the period duration in seconds for a timeframe
 */
export function getTimeframePeriodSeconds(timeframe: string): number {
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
      return 60 * 60; // Default to 1 hour
  }
}

/**
 * Format seconds into MM:SS format
 */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get countdown color based on time remaining
 */
export function getCountdownColor(secondsRemaining: number): string {
  if (secondsRemaining <= 3) return '#ff4444';
  if (secondsRemaining <= 10) return '#ff8844';
  if (secondsRemaining <= 30) return '#ffaa44';
  return '#999';
}