import { StatusChip } from '@finny/web';

const row: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' };

/** Every invoice lifecycle status as it appears in the queue. */
export const Lifecycle = () => (
  <div style={row}>
    <StatusChip status="received" />
    <StatusChip status="extracting" />
    <StatusChip status="needs_review" />
    <StatusChip status="confirmed" />
    <StatusChip status="awaiting_approval" />
    <StatusChip status="approved" />
  </div>
);

/** Failure and terminal states. */
export const FailureStates = () => (
  <div style={row}>
    <StatusChip status="extraction_failed" />
    <StatusChip status="rejected" />
    <StatusChip status="discarded" />
    <StatusChip status="shadow_complete" />
  </div>
);

/** Shadow-mode reviews carry a suffix so live and shadow work stay distinct. */
export const ShadowVariant = () => (
  <div style={row}>
    <StatusChip status="needs_review" shadow />
    <StatusChip status="approved" shadow />
  </div>
);
