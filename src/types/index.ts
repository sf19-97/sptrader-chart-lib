export interface ChartData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface SymbolMetadata {
  data_from: number;
  data_to: number;
  total_ticks?: number;
}

export interface StreamStatus {
  connected: boolean;
  message: string;
}

export interface ViewState {
  timeframe: string;
  visibleFrom: number;
  visibleTo: number;
  barSpacing: number;
}

export interface ChartConfig {
  theme?: 'light' | 'dark';
  timeframes?: string[];
  defaultTimeframe?: string;
  cacheTTL?: number;
  autoTimeframeSwitch?: boolean;
  barSpacingThresholds?: Record<string, number>;
}

export interface DataProvider {
  fetchCandles: (
    symbol: string,
    timeframe: string,
    from: number,
    to: number
  ) => Promise<{
    data: ChartData[];
    metadata?: SymbolMetadata;
  }>;
  
  subscribeToUpdates?: (
    symbol: string,
    callback: (data: ChartData) => void
  ) => () => void;
}