import React from 'react';
import { Box, Text } from '@mantine/core';
import { useCountdownTimer } from '../hooks/useCountdownTimer';

interface CountdownTimerProps {
  timeframe: string;
  onNewCandleBoundary?: (time: number) => void;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  offset?: { x: number; y: number };
}

/**
 * Displays a countdown timer to the next candle boundary
 * Positioned as an overlay on the chart
 */
export const CountdownTimer: React.FC<CountdownTimerProps> = ({
  timeframe,
  onNewCandleBoundary,
  position = 'top-right',
  offset = { x: 10, y: 10 },
}) => {
  const { countdown, countdownColor } = useCountdownTimer(timeframe, {
    onNewCandleBoundary,
  });


  // Calculate position styles
  const positionStyles = React.useMemo(() => {
    const styles: React.CSSProperties = {
      position: 'absolute',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',  // More visible background
      padding: '4px 8px',
      borderRadius: 4,
      fontSize: '12px',
      fontFamily: 'monospace',
      zIndex: 10,
    };

    switch (position) {
      case 'top-left':
        styles.top = offset.y;
        styles.left = offset.x;
        break;
      case 'top-right':
        styles.top = offset.y;
        styles.right = offset.x;
        break;
      case 'bottom-left':
        styles.bottom = offset.y;
        styles.left = offset.x;
        break;
      case 'bottom-right':
        styles.bottom = offset.y;
        styles.right = offset.x;
        break;
    }

    return styles;
  }, [position, offset.x, offset.y]);

  return (
    <Box style={positionStyles}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ color: '#666', fontSize: '11px' }}>Next:</span>
        <span style={{ 
          color: countdownColor, 
          fontSize: '12px',
          fontWeight: countdownColor === '#ffae00' ? 500 : 400,
          transition: 'color 0.3s ease'
        }}>
          {countdown}
        </span>
      </div>
    </Box>
  );
};

/**
 * Countdown timer with additional information
 * Shows timeframe and boundary status
 */
export const DetailedCountdownTimer: React.FC<CountdownTimerProps & { showTimeframe?: boolean }> = ({
  timeframe,
  onNewCandleBoundary,
  position = 'top-right',
  offset = { x: 10, y: 10 },
  showTimeframe = false,
}) => {
  const { 
    countdown, 
    countdownColor, 
    isNearBoundary,
    isPastBoundary,
  } = useCountdownTimer(timeframe, {
    onNewCandleBoundary,
    warningThreshold: 30,
    criticalThreshold: 10,
  });

  const positionStyles = React.useMemo(() => {
    const styles: React.CSSProperties = {
      position: 'absolute',
      backgroundColor: 'rgba(28, 30, 36, 0.9)',
      padding: '8px 12px',
      borderRadius: 4,
      fontSize: '12px',
      fontFamily: 'monospace',
      zIndex: 10,
      minWidth: showTimeframe ? '80px' : '60px',
    };

    switch (position) {
      case 'top-left':
        styles.top = offset.y;
        styles.left = offset.x;
        break;
      case 'top-right':
        styles.top = offset.y;
        styles.right = offset.x;
        break;
      case 'bottom-left':
        styles.bottom = offset.y;
        styles.left = offset.x;
        break;
      case 'bottom-right':
        styles.bottom = offset.y;
        styles.right = offset.x;
        break;
    }

    // Add border glow when near boundary
    if (isNearBoundary) {
      styles.boxShadow = '0 0 10px rgba(255, 174, 0, 0.5)';
    }

    return styles;
  }, [position, offset.x, offset.y, showTimeframe, isNearBoundary]);

  return (
    <Box style={positionStyles}>
      {showTimeframe && (
        <Text size="xs" color="dimmed" style={{ marginBottom: 4 }}>
          {timeframe.toUpperCase()}
        </Text>
      )}
      <Text 
        size="sm" 
        color={countdownColor} 
        fw={isNearBoundary ? 600 : 400}
        style={{ lineHeight: 1 }}
      >
        {countdown}
      </Text>
      {isPastBoundary && (
        <Text size="xs" color="yellow" style={{ marginTop: 4 }}>
          New candle!
        </Text>
      )}
    </Box>
  );
};