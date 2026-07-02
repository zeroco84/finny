import { BarRow } from '@finny/web';

const panel: React.CSSProperties = { width: 520, background: '#fff', border: '1px solid #e3dfd5', borderRadius: 10, padding: 16 };

/** Field-accuracy rows against the 85% go-live target, as on the dashboard. */
export const AccuracyPanel = () => (
  <div style={panel}>
    <BarRow label="Vendor" value={0.97} samples={24} target={0.85} />
    <BarRow label="Invoice ref" value={0.94} samples={24} target={0.85} />
    <BarRow label="PO number" value={0.71} samples={12} target={0.85} />
    <BarRow label="VAT rate" value={0.88} samples={24} target={0.85} />
  </div>
);

/** Below-target bars render amber; no samples renders an em-dash. */
export const EdgeCases = () => (
  <div style={panel}>
    <BarRow label="Approver" value={0.67} samples={24} target={0.85} />
    <BarRow label="Net" value={0} samples={0} target={0.85} />
    <BarRow label="Category" value={1} samples={9} />
  </div>
);
