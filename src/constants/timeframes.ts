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

/**
 * Bar spacing thresholds for automatic timeframe switching
 * zoomOut: When bar spacing goes below this value, switch to longer timeframe
 * zoomIn: When bar spacing goes above this value, switch to shorter timeframe
 */
export const TIMEFRAME_SWITCH_THRESHOLDS = {
  '5m': { 
    zoomOut: 7,   // Switch to 15m when bar spacing < 7
    zoomIn: 35    // Switch from 15m when bar spacing > 35
  },
  '15m': { 
    zoomOut: 8,   // Switch to 1h when bar spacing < 8
    zoomIn: 32    // Switch from 1h when bar spacing > 32
  },
  '1h': { 
    zoomOut: 8,   // Switch to 4h when bar spacing < 8
    zoomIn: 32    // Switch from 4h when bar spacing > 32
  },
  '4h': { 
    zoomOut: 4,   // Switch to 12h when bar spacing < 4
    zoomIn: 32    // Switch from 1h when bar spacing > 32
  },
  '12h': { 
    zoomOut: 3,   // Can't zoom out further
    zoomIn: 24    // Switch from 4h when bar spacing > 24
  }
} as const;