# @sptrader/chart-lib

Beautiful financial charts with smooth transitions and auto-timeframe switching. Extracted from SPtraderB's working chart implementation.

## Features

- 📊 Smooth candlestick charts powered by TradingView Lightweight Charts
- 🔄 Automatic timeframe switching based on zoom level
- 🎯 Fractal zoom with shift-key left edge locking
- ⚡ Real-time data updates with placeholder candles
- 💾 Built-in caching with request deduplication
- 🎨 Dark theme optimized for trading

## Installation

```bash
npm install @sptrader/chart-lib
```

## Quick Start

```tsx
import { MarketDataChart } from '@sptrader/chart-lib';

function App() {
  return (
    <MarketDataChart
      symbol="EURUSD"
      timeframe="1h"
      onTimeframeChange={(tf) => console.log('Timeframe changed to:', tf)}
    />
  );
}
```

## Components

### MarketDataChart
The main chart component with all features integrated.

### CountdownTimer
Shows countdown to next candle boundary.

## Hooks

- `useChartSetup` - Initialize chart with theme
- `useChartZoom` - Handle zoom and shift-key locking
- `useChartData` - Fetch and cache chart data
- `useAutoTimeframeSwitch` - Auto-switch timeframes based on zoom
- `usePlaceholderCandle` - Create temporary candles at boundaries
- `useCountdownTimer` - Countdown to next candle

## Data Provider

You'll need to implement a data provider that matches the expected interface. The library uses Tauri's invoke API by default, but this can be replaced with any data source.

## License

MIT