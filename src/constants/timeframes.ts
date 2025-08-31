/**
 * Timeframe period durations in seconds
 */
export const TIMEFRAME_SECONDS = {
  '5m': 5 * 60,      // 300
  '15m': 15 * 60,    // 900
  '1h': 60 * 60,     // 3600
  '4h': 4 * 60 * 60, // 14400
  '12h': 12 * 60 * 60 // 43200
} as const;

/**
 * Valid timeframe keys
 */
export type Timeframe = keyof typeof TIMEFRAME_SECONDS;

/**
 * Default timeframe when none is specified
 */
export const DEFAULT_TIMEFRAME: Timeframe = '1h';

/**
 * Get the period duration in seconds for a timeframe
 */
export function getTimeframePeriodSeconds(timeframe: string): number {
  return TIMEFRAME_SECONDS[timeframe as Timeframe] || TIMEFRAME_SECONDS[DEFAULT_TIMEFRAME];
}