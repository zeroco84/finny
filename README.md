# Finny — Finance Invoice Notification & Navigation for You

Meadowvale's AP intake tool: invoices arrive in the shared mailbox, AI extracts and routes them,
a human confirms once, and Finny produces the Sage 50 import batch and the Teams approval request.
Every correction teaches an inspectable rule; every failure alerts a named human immediately.

Built to the *Finny v1* product spec (July 2026). Runs fully offline out of the box with mock
providers; each external integration (Graph mail, Claude extraction, Teams Approvals, SMTP) is a
config switch away.

---

## Quickstart

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite` — no native builds).

```bash
npm install
npm run demo     # seeds ~4 weeks of realistic history through the real pipeline
npm run dev      # API on :4787 + web app on :5173
```

Open **http://localhost:5173** and sign in as anyone (dev sign-in) — e.g. `ap.lead@example.com`
as *AP Lead*, or `amy@example.com` as *AP Processor*. Roles matter: only the Lead can approve
rule changes, edit settings, and flip shadow/live mode.

The demo leaves you with: a review queue with fresh arrivals, 7 learned routing rules, a
populated accuracy dashboard (the shadow-period report), a generated Sage batch, decided
approvals, and one open unreadable-attachment alert. Re-seed anytime with `npm run demo -- --force`.

### A five-minute tour (the acceptance criteria, live)

1. **Queue → "Simulate incoming ▾" → Normal invoice.** Within seconds the extraction worker
   populates fields with per-field confidence; vendors with a learned rule arrive pre-routed with
   a rationale like *"Learned rule: Hegarty Steel Ltd → Materials → J. Brennan (matched 14/15
   times previously)"*.
2. **Open it, change the approving manager, Confirm & Send.** The diff is captured as a
   structured correction and a **rule proposal** appears under *Rules → Pending approval*
   (approver changes default to requiring AP Lead sign-off; configurable in Settings).
3. **As the Lead, approve the proposal.** Simulate another invoice from the same vendor — it now
   routes to the corrected manager automatically. That's the spec's "no re-litigating the same
   mistake twice".
4. **Approvals.** Confirmed invoices show a Teams approval card; with the mock provider you can
   act as the manager from the invoice page. Decisions flow back into the status + audit trail.
5. **Sage.** The Sage page batches confirmed invoices into a `FINNY_SAGE_*.csv` (audit-trail PI
   import format) and tracks generated → imported.
6. **Alerts.** Simulate a *Corrupt attachment*: the invoice lands in Failed and a distinct,
   human-readable alert (with next step) is raised immediately — emailed if SMTP is configured,
   stored and shown in the UI either way.
7. **Dashboard.** Field-level AI-vs-human accuracy against the 85% go-live gate, routing accuracy,
   the weekly correction-rate trend, and rule stability — the evidence the Lead uses before
   flipping Settings → Mode to live.

You can also ingest real invoices with zero setup: drop PDFs into `apps/server/data/inbox/`
(the watched folder standing in for the mailbox) or use **Upload invoice** on the queue.

---

## How it maps to the spec

| Spec item | Where it lives | Local default → production |
|---|---|---|
| Mailbox ingestion (Graph) | `apps/server/src/services/ingestion/` | `mock` (watched inbox folder + simulator) → `MAIL_PROVIDER=graph` |
| Extraction & classification | `apps/server/src/services/extraction/` | `mock` (deterministic PDF text parser) → `ANTHROPIC_API_KEY` for Claude |
| Confidence per field / no fabrication | `pipeline.ts`, prompt in `anthropicExtractor.ts` | same in both providers; missing fields are blank + flagged |
| Review queue app | `apps/web/` | dev sign-in → Entra ID SSO (seam in `apps/server/src/api/auth.ts`) |
| Shadow vs live mode | Settings → Mode (Lead only); enforced server-side in `review.ts` | shadow by default on a fresh DB |
| Corrections as structured feedback | `corrections` table, written by `review.ts` | — |
| Learned rules layer | `rules.ts` + Rules page | structured table injected into the prompt as JSON context — not an unbounded prompt string |
| Lead approval of rule changes | `rule_apply` setting (per type: category auto / approver review by default) | configurable in Settings |
| Sage 50 batch export | `sage.ts` + Sage page | CSV, audit-trail PI import format |
| Teams Approvals | `approvals/approvals.ts` | `mock` (simulator) → `APPROVALS_PROVIDER=graph` (beta endpoint) |
| Immediate alerting (5 failure types) | `alerts.ts` — distinct templates with next steps | logged + in-UI → SMTP email when configured |
| Audit trail | `audit_events` table, timeline on every invoice | — |
| Duplicate detection (P1) | `findDuplicate` + warning banners | same vendor + invoice ref |
| Accuracy dashboard (P1) | `metrics.ts` + Dashboard page | AI-vs-human comparisons from every completed review |
| Configurable thresholds (P1) | Settings (confidence %, SLA hours) | — |

**P1 items not in this build:** bulk confirm, PO matching (needs a PO system to match against),
and the trusted-vendor fast lane — all fit naturally on the current schema when wanted.

## Architecture

```
apps/server   Express 5 + node:sqlite (WAL) — API, background workers, connectors
  src/services/ingestion    mock inbox watcher · Graph mailbox poller (watermark + dedupe)
  src/services/extraction   provider interface · Claude extractor · offline mock extractor
  src/services/routing.ts   learned rules take precedence over the model's suggestion
  src/services/rules.ts     correction → proposal → Lead approval → active rule (+stats)
  src/services/review.ts    the single confirm/shadow/discard action
  src/services/sage.ts      Sage 50 CSV batches
  src/services/approvals    mock simulator · Graph Teams Approvals scaffold + poller
  src/services/alerts.ts    templates per failure type, immediate email or logged
  src/workers.ts            mail poll · extraction queue · SLA watchdog · approvals poll
apps/web      React 19 + Vite — queue, review, rules, alerts, Sage, dashboard, settings
packages/shared  one set of domain types used by both
```

Data lives in `apps/server/data/` (SQLite DB, original attachments, inbox drop-folder, Sage
export files). The audit trail, original attachments and export files are all kept independent of
Sage, per the spec.

**Stack note vs the spec:** the spec sketches React/Vite + Supabase + a Render worker. This
build keeps that shape — the web app is exactly that, and the server is the Render-deployable
worker+API — but stores data in SQLite via a thin data layer instead of Supabase so a checkout
runs with zero accounts. Swapping to Supabase Postgres means porting `db/schema.ts` and the small
query layer in `db/db.ts`; nothing else touches the database directly. For a single-service
deploy, `npm run build` then `npm run start` serves the built web app from the API process.

## Configuration

Copy `.env.example` → `.env` (all optional — empty means fully mocked). Highlights:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | switches extraction to Claude (`EXTRACTION_MODEL`, default `claude-opus-4-8`) |
| `MAIL_PROVIDER=graph` + `GRAPH_*` | polls the real shared mailbox |
| `APPROVALS_PROVIDER=graph` | creates real Teams Approvals via Graph |
| `SMTP_*` | alert emails actually send (otherwise logged + shown in UI) |
| `PORT`, `DATA_DIR`, `APP_URL` | plumbing; `APP_URL` is used in alert-email links |

### Wiring up Microsoft Graph (mailbox)

1. Entra ID → App registration → **application** permission `Mail.Read` (admin consent).
   Scope it to `apadmin@example.com` only with an [application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access).
2. Set `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `MAIL_PROVIDER=graph`.
3. The poller reads new mail with attachments (PDF/PNG/JPG), dedupes by message id, keeps a
   watermark, and optionally marks mail read (`GRAPH_MARK_READ`). Auth failures raise the
   `mailbox_auth_failure` alert immediately — check Settings → Connectors for the last error.

### Wiring up Teams Approvals

`approvals/approvals.ts` targets the Graph **beta** Approvals endpoint
(`/beta/solutions/approval/approvalItems`) and polls for decisions. Approving managers are not
Finny users, so each approval card carries a **signed, expiring link** (14 days, HMAC-bound to the
invoice — `services/attachmentLinks.ts`) that shows them the invoice document with no account;
rotating `SESSION_SECRET` invalidates outstanding links. Before go-live, verify the
beta contract and required permission (`ApprovalSolution.ReadWrite`) against current Graph docs —
Microsoft has moved this API before. If the tenant can't grant it, the pragmatic fallback used
elsewhere is a Power Automate flow triggered by email/webhook; the provider seam
(`createApprovalRequest` / `recordApprovalDecision`) is the only place that would change.

### Wiring up Entra ID SSO

Dev sign-in is a signed session cookie issued by `/api/auth/dev-login`. For production, replace
`readSession` in `apps/server/src/api/auth.ts` with Entra JWT validation (issuer + audience +
JWKS) and map an AD group to the `lead` role; the whole app consumes only `req.user`
(`{email, name, role}`), and the web app's login page gets replaced by the MSAL redirect.

### Sage 50 import format — validate before first real use

The export is the classic Sage 50 (UK/IE) **audit-trail transactions** CSV, type `PI`, one row
per invoice: supplier account ref, nominal code (from the category map in Settings), department,
date `dd/mm/yyyy`, reference, details, net, tax code (from the VAT-rate map), tax amount.
Run one small batch through **File → Import** on the live Sage install and adjust the nominal /
tax-code maps in Settings to match its configuration. Supplier account refs are suggested from
the vendor name and editable per invoice; Finny reuses the last-used ref per vendor.

## Design decisions worth knowing

- **Rules beat the model.** Routing is resolved from the rules table first; the LLM only fills
  the cold-start gap. That makes learning deterministic, auditable, and identical in mock and
  Claude modes — and it's why the acceptance test ("correct once → routed right next time")
  holds regardless of model behaviour.
- **Every completed review writes AI-vs-human comparisons** (not just shadow-mode ones), so the
  dashboard keeps measuring accuracy after go-live.
- **Rule apply defaults:** category corrections auto-apply; approver corrections need Lead
  approval (the spec's materiality question) — both configurable per type in Settings.
- **Sage export pool = confirmed invoices**, regardless of approval state (matches the spec's
  parallel fan-out); the picker shows approval status so the team can hold anything back.
- **Rejected invoices are terminal** in v1; the audit trail records who rejected and why.
- **Alerts don't auto-resolve** — a retried-and-fixed invoice leaves its alert open until a human
  resolves it, on the principle that the alert list is a to-do list, not a status mirror.
- **Money is integer cents**, dates are ISO strings, timestamps UTC.

## Phase plan (from the spec)

- **Phase 1 — shadow (now):** fresh installs start in shadow mode; reviewers do today's process
  in Finny while it logs comparisons and learns rules. Gate: 85%+ field accuracy on the Dashboard.
- **Phase 2 — live, human-confirmed (built):** the Lead flips the mode; Confirm & Send starts
  producing Sage batches and Teams approvals. This is v1's steady state — there is deliberately
  no zero-touch path (Sage 50 has no undo).
- **Phase 3 (partially built):** dashboard and duplicate detection are in; bulk confirm, PO
  matching and the trusted-vendor fast lane are the natural next increments.

## Commands

```bash
npm run dev          # server (tsx watch) + web (vite) together
npm run demo         # seed demo history (add -- --force to wipe & re-seed)
npm test             # server unit/integration tests (vitest)
npm run typecheck    # both apps
npm run build        # typecheck + production web build (server then serves it)
```
