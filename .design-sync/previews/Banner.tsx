import { Banner } from '@finny/web';

const stack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 };

/** The four kinds, with the copy Finny actually shows. */
export const AllKinds = () => (
  <div style={stack}>
    <Banner kind="info">Simulated 1 incoming invoice — extraction runs in a few seconds.</Banner>
    <Banner kind="success">Finny is LIVE.</Banner>
    <Banner kind="warn">
      Possible duplicate: same vendor and reference as an invoice received 12 Jun 2026. Check before sending.
    </Banner>
    <Banner kind="error">Extraction failed: PDF could not be parsed (bad XRef entry).</Banner>
  </div>
);

/** Warning banner for document triage, as on the invoice review screen. */
export const DocTriage = () => (
  <div style={stack}>
    <Banner kind="warn">
      The AI classified this document as a <strong>statement</strong>, not an invoice. If that is right,
      discard it below.
    </Banner>
  </div>
);
