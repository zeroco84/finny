import { EmptyState } from '@finny/web';

/** Queue empty state with the guidance hint. */
export const WithHint = () => (
  <div style={{ width: 560, border: '1px solid #e3dfd5', borderRadius: 10, background: '#fff' }}>
    <EmptyState
      title="Nothing here"
      hint='Use "Simulate incoming" to generate invoices, drop files into data/inbox/, or upload one.'
    />
  </div>
);

/** Title-only variant. */
export const TitleOnly = () => (
  <div style={{ width: 380, border: '1px solid #e3dfd5', borderRadius: 10, background: '#fff' }}>
    <EmptyState title="No open alerts" />
  </div>
);
