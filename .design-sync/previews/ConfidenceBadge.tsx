import { ConfidenceBadge } from '@finny/web';

const row: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'center' };
const label: React.CSSProperties = { fontSize: 13, color: '#5c6a61', width: 170 };

/** Green at/above the review threshold, amber below, red when the field wasn't found. */
export const Levels = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={row}><span style={label}>High confidence (96%)</span><ConfidenceBadge value={0.96} threshold={0.75} /></div>
    <div style={row}><span style={label}>Exactly at threshold (75%)</span><ConfidenceBadge value={0.75} threshold={0.75} /></div>
    <div style={row}><span style={label}>Low confidence (62%)</span><ConfidenceBadge value={0.62} threshold={0.75} /></div>
    <div style={row}><span style={label}>Field not found</span><ConfidenceBadge value={0} threshold={0.75} /></div>
  </div>
);

/** As used beside a field label in the invoice review form. */
export const InFieldLabel = () => (
  <span style={{ fontSize: 12, fontWeight: 700, color: '#5c6a61', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', gap: 8, alignItems: 'center' }}>
    Invoice ref <ConfidenceBadge value={0.91} threshold={0.75} />
  </span>
);
