import { Select } from '@mantine/core';
import { useTradingStore } from '../stores/useTradingStore';
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface AvailableSymbol {
  symbol: string;
  label: string;
  has_data: boolean;
  is_active: boolean;
  last_tick?: string;
  tick_count?: number;
  source?: string;
}

export const PairSelector = () => {
  const { selectedPair, setPair } = useTradingStore();
  const [isLoading, setIsLoading] = useState(true);
  const [symbols, setSymbols] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    const loadSymbols = async () => {
      try {
        setIsLoading(true);
        const available = await invoke<AvailableSymbol[]>('get_all_available_symbols');
        
        // Sort: active symbols first, then alphabetically
        const sorted = available.sort((a, b) => {
          if (a.is_active && !b.is_active) return -1;
          if (!a.is_active && b.is_active) return 1;
          return a.symbol.localeCompare(b.symbol);
        });
        
        // Format for Select component
        const items = sorted.map(s => ({
          value: s.symbol,
          label: s.is_active ? `${s.label} ●` : s.label,
        }));
        
        setSymbols(items);
      } catch (error) {
        console.error('[PairSelector] Failed to load symbols:', error);
        // Fallback to empty list
        setSymbols([]);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadSymbols();
    
    // Listen for pipeline changes
    const unlistenAdded = listen('asset-added', () => loadSymbols());
    const unlistenRemoved = listen('asset-removed', () => loadSymbols());
    
    return () => {
      unlistenAdded.then(fn => fn());
      unlistenRemoved.then(fn => fn());
    };
  }, []);

  const handlePairChange = (value: string | null) => {
    console.log('[PairSelector] onChange triggered with value:', value);
    if (value) {
      console.log('[PairSelector] Calling setPair with:', value);
      setPair(value);
    }
  };

  return (
    <Select
      value={selectedPair}
      onChange={handlePairChange}
      data={symbols}
      searchable
      placeholder={symbols.length === 0 ? "No symbols available" : "Select pair"}
      nothingFoundMessage="No matching symbols"
      disabled={isLoading}
      size="sm"
      styles={{
        input: {
          background: '#2a2a2a',
          border: '1px solid #444',
          fontSize: '14px',
          fontWeight: 600,
          color: 'white',
          height: '32px',
        },
        dropdown: {
          background: '#1a1a1a',
          border: '1px solid #444',
        },
      }}
    />
  );
};
