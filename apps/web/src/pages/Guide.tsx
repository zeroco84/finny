import { useEffect, useState, type ReactNode } from 'react';
import type { ConnectorStatus } from '@finny/shared';
import { api } from '../api';
import { useMeta } from '../meta';
import { pct } from '../format';

const CHAPTERS: { id: string; label: string }[] = [
  { id: 'loop', label: 'The daily loop' },
  { id: 'queue', label: 'The queue' },
  { id: 'review', label: 'Reviewing an invoice' },
  { id: 'teaching', label: 'Teaching Finny' },
  { id: 'modes', label: 'Shadow vs live' },
  { id: 'approvals', label: 'Teams approvals' },
  { id: 'sage', label: 'Posting to Sage' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'dashboard', label: 'The dashboard' },
  { id: 'settings', label: 'Settings' },
  { id: 'faq', label: 'Troubleshooting' },
];

function Chapter({ n, id, title, children }: { n: number; id: string; title: string; children: ReactNode }) {
  return (
    <section id={id}>
      <p className="chapter-kicker">Part {String(n).padStart(2, '0')}</p>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Term({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="term-row">
      <span className="term-label">{label}</span>
      <span className="term-body">{children}</span>
    </div>
  );
}

function Callout({ tone = 'brand', children }: { tone?: 'brand' | 'amber'; children: ReactNode }) {
  return <div className={`callout callout-${tone}`}>{children}</div>;
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="faq-item">
      <p className="faq-q">{q}</p>
      <p className="faq-a">{children}</p>
    </div>
  );
}

function Lead() {
  return <span className="chip guide-lead-chip">AP Lead</span>;
}

export default function GuidePage() {
  const { settings, overview, user } = useMeta();
  const threshold = pct(settings.confidence_threshold);
  const [active, setActive] = useState('loop');
  const [connector, setConnector] = useState<ConnectorStatus | null>(null);
  const oneTouchSage = connector?.sage_provider === 'hyperaccounts';

  useEffect(() => {
    void api.status().then(setConnector).catch(() => undefined);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -75% 0px' },
    );
    document.querySelectorAll('.guide-body section[id]').forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="page page-wide guide">
      <div className="guide-layout">
        <aside className="guide-nav">
          <p className="guide-nav-title">AP team guide</p>
          {CHAPTERS.map((c, i) => (
            <a key={c.id} href={`#${c.id}`} className={active === c.id ? 'guide-nav-active' : ''}>
              <span className="guide-nav-n">{String(i + 1).padStart(2, '0')}</span> {c.label}
            </a>
          ))}
        </aside>

        <div className="guide-body">
          <header className="guide-header">
            <h1>How Finny works</h1>
            <p className="guide-intro">
              Invoices arrive, Finny reads them, you check its work once, and everything downstream
              happens by itself. You bring the judgement; it does the typing.
            </p>
            <div className="pipeline">
              <div className="pipe-node">
                <strong>Arrives</strong>
                <span>shared mailbox or upload</span>
              </div>
              <span className="pipe-arrow">→</span>
              <div className="pipe-node">
                <strong>Finny reads it</strong>
                <span>fields, entity, project, routing</span>
              </div>
              <span className="pipe-arrow">→</span>
              <div className="pipe-node pipe-node-you">
                <strong>You review</strong>
                <span>the only human step</span>
              </div>
              <span className="pipe-arrow">→</span>
              <div className="pipe-node">
                <strong>Out the door</strong>
                <span>Sage batch · Teams approval</span>
              </div>
            </div>
            {settings.mode === 'shadow' && (
              <Callout tone="amber">
                Finny is currently in <strong>shadow mode</strong> — keep doing today's process as
                normal. Reviews here build the accuracy report; nothing is sent to Sage or Teams.
              </Callout>
            )}
          </header>

          <Chapter n={1} id="loop" title="The daily loop">
            <ol className="guide-steps">
              <li><strong>Open the Queue.</strong> New mailbox invoices appear on their own within minutes.</li>
              <li><strong>Work Needs review, top-down.</strong> Click anywhere on a row to open it.</li>
              <li><strong>Check the amber and red fields</strong> against the document on the left. Green means Finny is confident.</li>
              <li><strong>Fill what's blank</strong> — entity, project, category, approver — and press{' '}
                <strong>{settings.mode === 'live' ? 'Confirm & Send' : 'Log & complete'}</strong>.</li>
              <li><strong>Glance at Alerts before you finish.</strong> Anything that failed is listed there — never silent.</li>
            </ol>
            <Callout>
              That's the whole job: one review, one click. No re-keying into Excel, no manual Teams
              uploads, no keeping the posting number in your head.
            </Callout>
          </Chapter>

          <Chapter n={2} id="queue" title="The queue">
            <p>The tabs follow the invoice's life:</p>
            <Term label={<span className="chip status-needs_review">Needs review</span>}>
              Extracted, waiting for a human. Your work lives here.
            </Term>
            <Term label={<span className="chip status-extraction_failed">Failed</span>}>
              Finny couldn't read the file. Open it to retry, type the fields yourself, or discard it.
            </Term>
            <Term label={<span className="chip status-awaiting_approval">Approvals</span>}>
              Confirmed and sitting with a manager in Teams.
            </Term>
            <Term label={<span className="chip status-approved">Completed</span>}>
              Approved, rejected, shadow-logged, or discarded.
            </Term>

            <h3>Reading a row</h3>
            <Term label={<><span className="conf conf-ok">92%</span> <span className="conf conf-low">64%</span> <span className="conf conf-missing">not found</span></>}>
              The <strong>Fields</strong> column shows the weakest must-have field (vendor, ref, gross).
              Green is at or above the {threshold} threshold; amber is below it; red means Finny left it
              blank rather than guess.
            </Term>
            <Term label={<span className="flag flag-dup">DUP</span>}>
              Same vendor + invoice reference seen before — check before sending.
            </Term>
            <Term label={<span className="flag flag-doc">statement</span>}>
              The AI thinks this isn't an invoice (statement, remittance…). Usually a discard.
            </Term>
            <Term label="Under the vendor">
              The billed-to entity and project code, once known.
            </Term>
            <p className="muted">
              Anything that arrived outside the mailbox can be dragged in with <strong>Upload invoice</strong>.
            </p>
          </Chapter>

          <Chapter n={3} id="review" title="Reviewing an invoice">
            <p>
              Document on the left, Finny's reading on the right. Trust green, verify amber, fill red.
              Change a field and a small <span className="ai-ghost">AI read: …</span> note keeps the
              original visible.
            </p>
            <Term label="Billed to (entity)">
              Which of our companies the invoice is addressed to — it decides whose books this posts
              into, so it's required.
            </Term>
            <Term label="Project">
              Set it when the invoice belongs to a job or site; it drives the Dept column in Sage.
              Overheads are fine as “— none —”.
            </Term>
            <Term label="Category & approver">
              Where the cost sits and who signs it off. The green rationale box explains the proposal —
              e.g. <em>“Learned rule: matched 14/15 times”</em>. Your choice here is what teaches Finny.
            </Term>
            <Term label="Sage supplier A/C">
              The supplier's account code in Sage. Finny suggests one and reuses the vendor's last-used
              code — keep it consistent with Sage.
            </Term>
            <Term label="Duplicate banner">
              Open the linked invoice first; send a flagged one only if it's genuinely different.
            </Term>
            <Term label="Discard">
              For non-invoices (statements, spam) — give a reason. It's recorded in Completed, not deleted.
            </Term>
            <Callout>
              Confirm is blocked until vendor, invoice ref, gross, category, approver, entity and
              supplier A/C are set — the message names whatever is missing.
            </Callout>
          </Chapter>

          <Chapter n={4} id="teaching" title="Teaching Finny">
            <p>
              Confirm a vendor's category and approver and Finny proposes a rule —{' '}
              <em>Vendor → Category → Approver</em>. Once active, that vendor's next invoice arrives
              pre-routed, with the rule's track record shown in the rationale box.
            </p>
            <Term label="Pending rules">
              Category corrections {settings.rule_apply.category === 'auto' ? 'apply immediately' : 'wait for approval'};
              approver changes {settings.rule_apply.approver === 'review'
                ? <>wait in <strong>Rules → Pending</strong> for the <Lead /> — one person's slip never silently retrains the system</>
                : 'apply immediately'}.
            </Term>
            <Term label="No black box">
              The Rules page shows every rule with its hit-rate (applied · confirmed · corrected); the{' '}
              <Lead /> can edit or retire any of them.
            </Term>
            <Term label="Extraction hints">
              Per-vendor notes fed to the AI for awkward layouts — e.g. “the PO is printed as ‘Order
              Code’ in the footer” (<Lead />).
            </Term>
            <Callout>You should never have to fix the same vendor twice. If you are, a stale rule needs retiring.</Callout>
          </Chapter>

          <Chapter n={5} id="modes" title="Shadow vs live">
            <Term label="Shadow">
              The trust-building phase. Keep doing today's process; each review you log is compared with
              the AI's proposal and nothing leaves Finny. The Dashboard turns this into the accuracy report.
            </Term>
            <Term label="Live">
              The real thing: Confirm &amp; Send fills the Sage export pool and creates the Teams approval.
            </Term>
            <p className="muted">
              The <Lead /> flips the mode in Settings. The bar for going live is evidence, not a date:
              85%+ field accuracy on the Dashboard over a real shadow period.
            </p>
          </Chapter>

          <Chapter n={6} id="approvals" title="Teams approvals">
            <p>
              Managers don't use Finny and nothing changes for them: on confirm they get a normal{' '}
              <strong>Teams Approvals</strong> card with the amount, category, PO and a secure link to view
              the invoice (valid 14 days, no account needed). Their decision flows back on its own —
              the invoice moves to Approved or Rejected with who and when in its history.
            </p>
            <Term label="Rejected">
              Final in Finny; the manager's note is in the history. Query the supplier — a corrected
              invoice arrives as a new document.
            </Term>
            <Term label="Couldn't send">
              If the approval can't be created, the invoice page shows a banner with{' '}
              <strong>Retry approval</strong> and an alert fires.
            </Term>
          </Chapter>

          <Chapter n={7} id="sage" title="Posting to Sage">
            <ol className="guide-steps">
              <li><strong>Open Sage.</strong> Every confirmed invoice not yet batched is pre-ticked in the pool.</li>
              {oneTouchSage ? (
                <>
                  <li><strong>Press Send to Sage.</strong> Finny posts each invoice straight into the right
                    entity's Sage company via HyperAccounts, with the invoice document linked on every
                    transaction. A CSV audit copy is kept alongside.</li>
                  <li><strong>Refs are automatic.</strong> Each line gets the next Inv-number in the running
                    sequence; the Sage transaction number lands on the invoice's history.</li>
                  <li><strong>Finny reads Sage before it writes.</strong> If someone has been posting by hand,
                    the Inv-sequence jumps past their refs automatically, and if the same supplier invoice is
                    already in Sage (same account, invoice number and amount) Finny links to that transaction
                    instead of posting it again — you get an alert asking you to double-check, never a
                    duplicate in the ledger.</li>
                  <li><strong>Check the badge.</strong> A batch shows <em>posted to Sage</em> when every invoice
                    is in; anything that failed keeps a <strong>Send to Sage</strong> retry button and raises an
                    alert — retries never post the same invoice twice.</li>
                </>
              ) : (
                <>
                  <li><strong>Generate.</strong> Finny writes one CSV per legal entity, in the posting-sheet
                    layout (A/C · Date · Ref · Ex Ref · N/C · Dept · Details · Net · T/C · Vat · Gross).</li>
                  <li><strong>Refs are automatic.</strong> Each line gets the next Inv-number in the running
                    sequence, stamped on the invoice's history.</li>
                  <li><strong>Post &amp; mark.</strong> Download each file, post it in the matching Sage company,
                    then press <strong>Mark imported</strong>.</li>
                </>
              )}
            </ol>
            <p className="muted">
              A mistake found after posting is fixed in Sage as today, and the
              mappings (nominals, tax codes, depts, next Ref) live in Settings (<Lead />).
            </p>
          </Chapter>

          <Chapter n={8} id="alerts" title="Alerts">
            <p>
              Finny's core promise: <strong>nothing fails silently</strong>. Unreadable files, invoices
              unreviewed past the {settings.review_sla_hours}-hour SLA, Sage export problems, Teams
              failures and mailbox outages each raise an alert immediately
              {settings.alert_recipients.length > 0 ? <> and email <code>{settings.alert_recipients.join(', ')}</code></> : ''} —
              each one says what failed, which invoice, and the next step.
            </p>
            <Term label="Acknowledge">“I'm on it.” The alert stays visible.</Term>
            <Term label="Resolve">Dealt with. Alerts never close themselves — the list is a to-do list, not a status light.</Term>
          </Chapter>

          <Chapter n={9} id="dashboard" title="The dashboard">
            <Term label="Field accuracy">
              How often the AI's reading matched what a human entered, per field. The red line is the 85%
              go-live gate.
            </Term>
            <Term label="Correction rate">
              Should fall week on week as rules stick. Flat or rising means the learning isn't landing —
              worth a look at the Rules page.
            </Term>
            <Term label="By vendor">
              Who's reliable, who needs corrections, and which vendors have a learned rule.
            </Term>
          </Chapter>

          <Chapter n={10} id="settings" title="Settings">
            <p>
              Everything configurable lives here, managed by the <Lead />: shadow/live mode, the
              confidence threshold and review SLA, alert recipients, rule apply-modes, legal entities,
              projects with their Sage dept numbers, categories → nominal codes, VAT → tax codes, the
              fallback dept and the next posting Ref number, and the approving-manager list.
              {user.role !== 'lead' && ' Settings are read-only for processors — ask the AP Lead.'}
            </p>
            <Callout tone="amber">
              Before the first real import: match the nominal codes, tax codes, depts and the Ref sequence
              to the live Sage configuration.
            </Callout>
          </Chapter>

          <Chapter n={11} id="faq" title="Troubleshooting">
            <Faq q="An invoice I'm expecting hasn't appeared">
              Check <strong>Alerts</strong> and the <strong>Failed</strong> tab first, then Settings →
              Connectors for the mailbox's last poll. Worst case: download it from the mailbox and use
              Upload invoice.
            </Faq>
            <Faq q="Confirm is rejected">
              The error names the missing field — most often the billed-to entity or approver on older
              invoices.
            </Faq>
            <Faq q="Finny keeps routing a vendor wrong">
              An old rule is probably active — the <Lead /> can edit or retire it on the Rules page, and
              your next correct review proposes the replacement.
            </Faq>
            <Faq q="It went to the wrong manager">
              Have the manager reject with a note, fix the rule so it can't recur, and re-upload the
              document. The duplicate flag on the new copy is expected — confirm through it.
            </Faq>
            <Faq q="I discarded something by mistake">
              Discarded invoices stay in <strong>Completed</strong> with their full history — re-upload
              the document to process it fresh.
            </Faq>
          </Chapter>

          {overview?.simulator_enabled && (
            <section id="demo">
              <p className="chapter-kicker">Demo installation</p>
              <h2>Rehearsing safely</h2>
              <p className="muted">
                This copy runs on simulated connectors: <strong>Simulate incoming ▾</strong> fabricates
                invoices (including a corrupt one to see the alert flow), the invoice page includes an
                approvals simulator so you can play the manager, and alert emails are shown in the UI
                instead of being sent. Nothing touches the real mailbox, Sage, or Teams.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
