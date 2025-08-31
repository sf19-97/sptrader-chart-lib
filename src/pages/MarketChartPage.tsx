import { Box } from '@mantine/core';
import MarketDataChart from '../components/MarketDataChart';
import { useTradingStore } from '../stores/useTradingStore';

export const MarketChartPage = () => {
  const { selectedPair } = useTradingStore();

  return (
    <Box style={{ height: '100vh', width: '100%', background: '#0a0a0a', position: 'relative' }}>
      <MarketDataChart
        symbol={selectedPair}
      />
    </Box>
  );
};
