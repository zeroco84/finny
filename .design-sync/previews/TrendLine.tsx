import { TrendLine } from '@finny/web';

const panel: React.CSSProperties = { width: 520, background: '#fff', border: '1px solid #e3dfd5', borderRadius: 10, padding: 16 };

/** Routing correction rate falling week over week — the "rules are sticking" story. */
export const DecliningTrend = () => (
  <div style={panel}>
    <TrendLine
      points={[
        { week: '2026-W23', value: 0.42, samples: 5 },
        { week: '2026-W24', value: 0.28, samples: 6 },
        { week: '2026-W25', value: 0.18, samples: 5 },
        { week: '2026-W26', value: 0.09, samples: 8 },
        { week: '2026-W27', value: 0.11, samples: 6 },
      ]}
    />
  </div>
);

/** No data yet — renders the built-in empty state. */
export const NoData = () => (
  <div style={panel}>
    <TrendLine points={[]} />
  </div>
);
