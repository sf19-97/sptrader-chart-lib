// Main component
export { default as MarketDataChart } from './components/MarketDataChart';
export { CountdownTimer, DetailedCountdownTimer } from './components/CountdownTimer';

// Hooks
export { useChartSetup } from './hooks/useChartSetup';
export type { ChartTheme, UseChartSetupOptions, UseChartSetupReturn } from './hooks/useChartSetup';

export { useChartZoom } from './hooks/useChartZoom';
export type { VisibleRange, UseChartZoomOptions, UseChartZoomReturn } from './hooks/useChartZoom';

export { useChartData } from './hooks/useChartData';
export { useAutoTimeframeSwitch, getBarSpacingForTimeframeSwitch } from './hooks/useAutoTimeframeSwitch';
export { useCountdownTimer, getNextCandleTime, getCurrentCandleTime } from './hooks/useCountdownTimer';
export type { UseCountdownTimerOptions, UseCountdownTimerReturn } from './hooks/useCountdownTimer';

export { usePlaceholderCandle, calculateCandleTime } from './hooks/usePlaceholderCandle';
export type { UsePlaceholderCandleOptions, UsePlaceholderCandleReturn } from './hooks/usePlaceholderCandle';

// Services
export { ChartDataCoordinator, chartDataCoordinator } from './services/ChartDataCoordinator';
export type { SymbolMetadata } from './services/ChartDataCoordinator';

// Stores
export { useChartStore } from './stores/useChartStore';

// Utilities
export * from './utils/chartHelpers';

// Types
export * from './types';

// Pages
export { MarketChartPage } from './pages';