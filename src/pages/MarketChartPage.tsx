import { useState } from 'react';
import { Box } from '@mantine/core';
import MarketDataChart from '../components/MarketDataChart';
import { useTradingStore } from '../stores/useTradingStore';

export const MarketChartPage = () => {
  const { selectedPair } = useTradingStore();
  const [isChartFullscreen, setIsChartFullscreen] = useState(false);

  return (
    <Box style={{ height: '100vh', width: '100%', background: '#0a0a0a', position: 'relative' }}>
      <MarketDataChart
        symbol={selectedPair}
        isFullscreen={isChartFullscreen}
        onToggleFullscreen={() => setIsChartFullscreen(!isChartFullscreen)}
      />
    </Box>
  );
};
