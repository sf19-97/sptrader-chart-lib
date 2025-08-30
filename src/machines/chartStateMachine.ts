import { createMachine, assign, interpret } from 'xstate';
import { useEffect, useMemo, useCallback } from 'react';

// Types
export interface ChartContext {
  symbol: string;
  timeframe: string;
  barSpacing: number;
  opacity: number;
  isShiftPressed: boolean;
  lockedLeftEdge: number | null;
  visibleRange: { from: number; to: number } | null;
  lastTransition: number;
  error: string | null;
}

export type ChartEvent =
  | { type: 'INITIALIZE'; symbol: string; timeframe: string }
  | { type: 'UPDATE_BAR_SPACING'; barSpacing: number }
  | { type: 'REQUEST_TIMEFRAME_CHANGE'; timeframe: string }
  | { type: 'SHIFT_PRESSED' }
  | { type: 'SHIFT_RELEASED' }
  | { type: 'SET_VISIBLE_RANGE'; range: { from: number; to: number } | null }
  | { type: 'DATA_LOADED' }
  | { type: 'DATA_ERROR'; error: string }
  | { type: 'SYMBOL_CHANGED'; symbol: string }
  | { type: 'RESIZE' };

export type ChartState =
  | { value: 'idle'; context: ChartContext }
  | { value: 'loading'; context: ChartContext }
  | { value: 'ready'; context: ChartContext }
  | { value: { ready: 'monitoring' | 'checkingTimeframe' }; context: ChartContext }
  | { value: 'transitioning'; context: ChartContext }
  | { value: 'error'; context: ChartContext };

// Timeframe switching thresholds (from MarketDataChart)
const SWITCH_TO_5M_BAR_SPACING = 35;
const SWITCH_FROM_5M_BAR_SPACING = 7;
const SWITCH_TO_15M_BAR_SPACING = 32;
const SWITCH_TO_1H_BAR_SPACING = 8;
const SWITCH_TO_4H_BAR_SPACING = 8;
const SWITCH_FROM_4H_BAR_SPACING = 32;
const SWITCH_TO_12H_BAR_SPACING = 4;
const SWITCH_FROM_12H_BAR_SPACING = 24;

const TRANSITION_COOLDOWN = 700; // ms

// Helper to determine if timeframe switch is needed
function shouldSwitchTimeframe(timeframe: string, barSpacing: number): string | null {
  // 12h → 4h (zooming in)
  if (timeframe === '12h' && barSpacing > SWITCH_FROM_12H_BAR_SPACING) {
    return '4h';
  }
  // 4h → 12h (zooming out)
  if (timeframe === '4h' && barSpacing < SWITCH_TO_12H_BAR_SPACING) {
    return '12h';
  }
  // 4h → 1h (zooming in)
  if (timeframe === '4h' && barSpacing > SWITCH_FROM_4H_BAR_SPACING) {
    return '1h';
  }
  // 1h → 4h (zooming out)
  if (timeframe === '1h' && barSpacing < SWITCH_TO_4H_BAR_SPACING) {
    return '4h';
  }
  // 1h → 15m (zooming in)
  if (timeframe === '1h' && barSpacing > SWITCH_TO_15M_BAR_SPACING) {
    return '15m';
  }
  // 15m → 1h (zooming out)
  if (timeframe === '15m' && barSpacing < SWITCH_TO_1H_BAR_SPACING) {
    return '1h';
  }
  // 15m → 5m (zooming in)
  if (timeframe === '15m' && barSpacing > SWITCH_TO_5M_BAR_SPACING) {
    return '5m';
  }
  // 5m → 15m (zooming out)
  if (timeframe === '5m' && barSpacing < SWITCH_FROM_5M_BAR_SPACING) {
    return '15m';
  }

  return null;
}

// The state machine
export const chartMachine = createMachine<ChartContext, ChartEvent, ChartState>({
  id: 'chart',
  initial: 'idle',
  context: {
    symbol: '',
    timeframe: '1h',
    barSpacing: 12,
    opacity: 1,
    isShiftPressed: false,
    lockedLeftEdge: null,
    visibleRange: null,
    lastTransition: 0,
    error: null,
  },
  states: {
    idle: {
      on: {
        INITIALIZE: {
          target: 'loading',
          actions: assign({
            symbol: (_, event) => event.symbol,
            timeframe: (_, event) => event.timeframe,
          }),
        },
      },
    },
    loading: {
      entry: assign({ opacity: 0.5 }),
      on: {
        DATA_LOADED: {
          target: 'ready',
          actions: assign({ error: null }),
        },
        DATA_ERROR: {
          target: 'error',
          actions: assign({ error: (_, event) => event.error }),
        },
      },
    },
    ready: {
      entry: assign({ opacity: 1 }),
      type: 'parallel',
      states: {
        monitoring: {
          initial: 'active',
          states: {
            active: {
              on: {
                UPDATE_BAR_SPACING: {
                  target: 'checkingTimeframe',
                  actions: assign({ barSpacing: (_, event) => event.barSpacing }),
                },
              },
            },
            checkingTimeframe: {
              always: [
                {
                  target: '#chart.transitioning',
                  cond: (context) => {
                    const now = Date.now();
                    if (now - context.lastTransition < TRANSITION_COOLDOWN) {
                      return false;
                    }
                    const newTimeframe = shouldSwitchTimeframe(context.timeframe, context.barSpacing);
                    return newTimeframe !== null;
                  },
                  actions: assign({
                    timeframe: (context) => shouldSwitchTimeframe(context.timeframe, context.barSpacing)!,
                    lastTransition: () => Date.now(),
                  }),
                },
                {
                  target: 'active',
                },
              ],
            },
          },
        },
        zoom: {
          initial: 'normal',
          states: {
            normal: {
              on: {
                SHIFT_PRESSED: {
                  target: 'locked',
                  actions: assign({
                    isShiftPressed: true,
                    lockedLeftEdge: (context) => context.visibleRange?.from || null,
                  }),
                },
              },
            },
            locked: {
              on: {
                SHIFT_RELEASED: {
                  target: 'normal',
                  actions: assign({
                    isShiftPressed: false,
                    lockedLeftEdge: null,
                  }),
                },
              },
            },
          },
        },
      },
      on: {
        REQUEST_TIMEFRAME_CHANGE: {
          target: 'transitioning',
          cond: (context, event) => {
            const now = Date.now();
            return (
              now - context.lastTransition >= TRANSITION_COOLDOWN &&
              event.timeframe !== context.timeframe
            );
          },
          actions: assign({
            timeframe: (_, event) => event.timeframe,
            lastTransition: () => Date.now(),
          }),
        },
        SYMBOL_CHANGED: {
          target: 'loading',
          actions: assign({ symbol: (_, event) => event.symbol }),
        },
        SET_VISIBLE_RANGE: {
          actions: assign({ visibleRange: (_, event) => event.range }),
        },
        RESIZE: {
          // Handle resize without state change
          actions: () => console.log('[ChartStateMachine] Window resized'),
        },
      },
    },
    transitioning: {
      entry: assign({ opacity: 0.2 }),
      after: {
        250: 'loading', // Wait for fade out animation
      },
    },
    error: {
      entry: assign({ opacity: 0.5 }),
      on: {
        INITIALIZE: {
          target: 'loading',
          actions: assign({
            symbol: (_, event) => event.symbol,
            timeframe: (_, event) => event.timeframe,
            error: null,
          }),
        },
      },
    },
  },
});

// React hook for using the state machine
export function useChartMachine() {
  const service = useMemo(() => interpret(chartMachine).start(), []);

  useEffect(() => {
    return () => service.stop();
  }, [service]);

  const initialize = useCallback(
    (symbol: string, timeframe: string) => {
      service.send({ type: 'INITIALIZE', symbol, timeframe });
    },
    [service]
  );

  const updateBarSpacing = useCallback(
    (barSpacing: number) => {
      service.send({ type: 'UPDATE_BAR_SPACING', barSpacing });
    },
    [service]
  );

  const requestTimeframeChange = useCallback(
    (timeframe: string) => {
      service.send({ type: 'REQUEST_TIMEFRAME_CHANGE', timeframe });
    },
    [service]
  );

  const setShiftPressed = useCallback(
    (pressed: boolean) => {
      service.send({ type: pressed ? 'SHIFT_PRESSED' : 'SHIFT_RELEASED' });
    },
    [service]
  );

  const setVisibleRange = useCallback(
    (range: { from: number; to: number } | null) => {
      service.send({ type: 'SET_VISIBLE_RANGE', range });
    },
    [service]
  );

  const notifyDataLoaded = useCallback(() => {
    service.send({ type: 'DATA_LOADED' });
  }, [service]);

  const notifyDataError = useCallback(
    (error: string) => {
      service.send({ type: 'DATA_ERROR', error });
    },
    [service]
  );

  const notifySymbolChanged = useCallback(
    (symbol: string) => {
      service.send({ type: 'SYMBOL_CHANGED', symbol });
    },
    [service]
  );

  const notifyResize = useCallback(() => {
    service.send({ type: 'RESIZE' });
  }, [service]);

  return {
    service,
    initialize,
    updateBarSpacing,
    requestTimeframeChange,
    setShiftPressed,
    setVisibleRange,
    notifyDataLoaded,
    notifyDataError,
    notifySymbolChanged,
    notifyResize,
  };
}