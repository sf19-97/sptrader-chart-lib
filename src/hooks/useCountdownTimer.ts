import { useEffect, useRef, useState, useCallback } from 'react';

export interface UseCountdownTimerOptions {
  onNewCandleBoundary?: (time: number) => void;
  updateInterval?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export interface UseCountdownTimerReturn {
  countdown: string;
  countdownColor: string;
  secondsRemaining: number;
  isNearBoundary: boolean;
  isPastBoundary: boolean;
}

/**
 * Hook to manage countdown timer to next candle boundary
 * 
 * @param timeframe - Current chart timeframe
 * @param options - Configuration options
 * @returns Countdown state and utilities
 */
export function useCountdownTimer(
  timeframe: string,
  options?: UseCountdownTimerOptions
): UseCountdownTimerReturn {
  const {
    onNewCandleBoundary,
    updateInterval = 1000,
    warningThreshold = 30,
    criticalThreshold = 10,
  } = options || {};

  const [countdown, setCountdown] = useState<string>('00:00');
  const [countdownColor, setCountdownColor] = useState<string>('#999');
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const hasTriggeredRef = useRef<boolean>(false);

  // Calculate seconds to next candle boundary
  const calculateSecondsToNextCandle = useCallback((timeframe: string): number => {
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours();

    switch (timeframe) {
      case '5m':
        return (5 - (minutes % 5)) * 60 - seconds;
      case '15m':
        return (15 - (minutes % 15)) * 60 - seconds;
      case '1h':
        return (60 - minutes) * 60 - seconds;
      case '4h':
        return (4 - (hours % 4)) * 3600 + (60 - minutes) * 60 - seconds;
      case '12h':
        return (12 - (hours % 12)) * 3600 + (60 - minutes) * 60 - seconds;
      default:
        return (60 - minutes) * 60 - seconds; // Default to 1h
    }
  }, []);

  // Format seconds to MM:SS
  const formatCountdown = useCallback((totalSeconds: number): string => {
    const displaySeconds = Math.max(0, totalSeconds);
    const minutes = Math.floor(displaySeconds / 60);
    const seconds = displaySeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, []);

  // Get color based on time remaining
  const getCountdownColor = useCallback((seconds: number): string => {
    if (seconds <= criticalThreshold) {
      return '#ffae00'; // Yellow warning
    } else if (seconds <= warningThreshold) {
      return '#ccc'; // Brighter gray
    } else {
      return '#999'; // Dimmed gray
    }
  }, [criticalThreshold, warningThreshold]);

  // Update countdown
  const updateCountdown = useCallback(() => {
    const now = Date.now();
    const seconds = Math.floor(now / 1000) % 60;
    
    // Throttle updates based on proximity to boundary
    const nearBoundary = seconds >= 58 || seconds <= 2;
    const throttleMs = nearBoundary ? 100 : 950;
    
    if (now - lastUpdateRef.current < throttleMs) return;
    lastUpdateRef.current = now;

    const totalSeconds = calculateSecondsToNextCandle(timeframe);
    setSecondsRemaining(totalSeconds);

    // Update display
    setCountdown(formatCountdown(totalSeconds));
    setCountdownColor(getCountdownColor(totalSeconds));

    // Trigger boundary callback
    if (totalSeconds <= 0 && !hasTriggeredRef.current) {
      hasTriggeredRef.current = true;
      const candleTime = Math.floor(now / 1000);
      onNewCandleBoundary?.(candleTime);
    }

    // Reset trigger when safely past boundary
    if (totalSeconds > 5) {
      hasTriggeredRef.current = false;
    }
  }, [timeframe, calculateSecondsToNextCandle, formatCountdown, getCountdownColor, onNewCandleBoundary]);

  // Start/stop countdown based on visibility
  useEffect(() => {
    const startCountdown = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      // Initial update
      updateCountdown();

      // Start interval
      intervalRef.current = setInterval(updateCountdown, updateInterval);
    };

    const stopCountdown = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    // Handle visibility changes to save resources
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopCountdown();
      } else {
        startCountdown();
      }
    };

    // Start if page is visible
    if (!document.hidden) {
      startCountdown();
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopCountdown();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [timeframe, updateCountdown, updateInterval]);

  return {
    countdown,
    countdownColor,
    secondsRemaining,
    isNearBoundary: secondsRemaining <= 2 && secondsRemaining > 0,
    isPastBoundary: secondsRemaining <= 0,
  };
}

/**
 * Calculate the time of the next candle boundary
 */
export function getNextCandleTime(timeframe: string): number {
  const now = Math.floor(Date.now() / 1000);
  
  const periods: Record<string, number> = {
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '12h': 43200,
  };
  
  const period = periods[timeframe] || 3600;
  return Math.ceil(now / period) * period;
}

/**
 * Calculate the current candle's start time
 */
export function getCurrentCandleTime(timeframe: string): number {
  const now = Math.floor(Date.now() / 1000);
  
  const periods: Record<string, number> = {
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '12h': 43200,
  };
  
  const period = periods[timeframe] || 3600;
  return Math.floor(now / period) * period;
}