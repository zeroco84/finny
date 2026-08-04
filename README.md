# Finny — Finance Invoice Notification & Navigation for You

[![CI](https://github.com/zeroco84/finny/actions/workflows/ci.yml/badge.svg)](https://github.com/zeroco84/finny/actions/workflows/ci.yml)

An accounts-payable intake tool: invoices arrive in a shared mailbox, AI extracts and routes them,
a human confirms once, and Finny produces the Sage 50 import batch and the Teams approval request.
Every correction teaches an inspectable rule; every failure alerts a named human immediately.

Built to the *Finny v1* product spec (July 2026). Runs fully offline out of the box with mock
providers; each external integration (Graph mail, Claude extraction, Teams Approvals, Teams alerts) is a
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
   human-readable alert (with next step) is raised immediately — posted to your Teams channel if an
   alert webhook is configured, stored and shown in the UI either way.
7. **Dashboard.** Field-level AI-vs-human accuracy against the 85% go-live gate, routing accuracy,
   the weekly correction-rate trend, and rule stability — the evidence the Lead uses before
   flipping Settings → Mode to live.

You can also ingest real invoices with zero setup: drop PDFs (or PNG/JPG/GIF/WebP photos —
with Claude extraction these are read by vision exactly like PDFs; images over 5MB are parked
with an actionable alert — or XLSX/XLS/ODS workbooks, DOCX/ODT documents and CSV/TSV/TXT files, which are converted
to text before extraction) into `apps/server/data/inbox/`
(the watched folder standing in for the mailbox) or use **Upload invoice** on the queue.

---

## How it maps to the spec

| Spec item | Where it lives | Local default → production |
|---|---|---|
| Mailbox ingestion (Graph) | `apps/server/src/services/ingestion/` | `mock` (watched inbox folder + simulator) → `MAIL_PROVIDER=graph` |
| Extraction & classification | `apps/server/src/services/extraction/` | `mock` (deterministic PDF text parser) → `ANTHROPIC_API_KEY` for Claude |
| Confidence per field / no fabrication | `pipeline.ts`, prompt in `anthropicExtractor.ts` | same in both providers; missing fields are blank + flagged |
| Review queue app | `apps/web/` | dev sign-in → `AUTH_PROVIDER=entra` for Entra ID SSO (M365 accounts) |
| Shadow vs live mode | Settings → Mode (Lead only); enforced server-side in `review.ts` | shadow by default on a fresh DB |
| Corrections as structured feedback | `corrections` table, written by `review.ts` | — |
| Learned rules layer | `rules.ts` + Rules page | structured table injected into the prompt as JSON context — not an unbounded prompt string |
| Lead approval of rule changes | `rule_apply` setting (per type: category auto / approver review by default) | configurable in Settings |
| Sage 50 batch export | `sage.ts` + Sage page | CSV matching the AP posting sheet, one file per entity |
| Teams Approvals | `approvals/approvals.ts` | `mock` (simulator) → `APPROVALS_PROVIDER=power_automate` (flow + callback) |
| Immediate alerting (5 failure types) | `alerts.ts` — distinct templates with next steps | logged + in-UI → Teams webhook (`ALERT_WEBHOOK_URL`) when configured |
| Event notifications (self-service) | `notifications.ts` + Notifications page | each user subscribes their own Teams chat to invoices matching amount / date / supplier / project criteria |
| Audit trail | `audit_events` table, timeline on every invoice | — |
| Duplicate detection (P1) | `findDuplicate` + warning banners | same vendor + invoice ref |
| Non-invoice handling | doc-type classification in extraction; statements/remittances auto-file to Completed (audited, reopenable) — "other" still goes to review | same in both providers |
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
apps/web      React 19 + Vite — queue, review, rules, alerts, Sage, dashboards (accuracy + volume), settings
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
| `ANTHROPIC_API_KEY` | switches extraction to Claude — key + model are also settable in-app (Settings → AI extraction, AP Lead; stored value wins). `EXTRACTION_MODEL` default `claude-opus-4-8` |
| `MAIL_PROVIDER=graph` + `GRAPH_*` | polls the real shared mailbox |
| `APPROVALS_PROVIDER=power_automate` + `APPROVALS_FLOW_URL` + `APPROVALS_CALLBACK_TOKEN` | raises real Teams Approvals via a Power Automate flow (`graph` is delegated-only and always 401s — see below) |
| `ALERT_WEBHOOK_URL` | failure alerts post to a Teams channel as a card (otherwise logged + shown in UI) |
| `PORT`, `DATA_DIR`, `APP_URL` | plumbing; `APP_URL` is used in alert-email links |

### Wiring up Microsoft Graph (mailbox)

1. Entra ID → App registration → **application** permission `Mail.ReadWrite` (admin consent) —
   ReadWrite because Finny marks processed messages read; if you'd rather grant read-only, use
   `Mail.Read` and set `GRAPH_MARK_READ=false`.
2. Application permissions cover **every mailbox in the tenant** until scoped: restrict the app
   to the AP mailbox with an
   [application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
   (Exchange Online PowerShell: mail-enabled security group containing the mailbox +
   `New-ApplicationAccessPolicy -AccessRight RestrictAccess`, then
   `Test-ApplicationAccessPolicy` to prove Granted/Denied).
3. Set `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `MAIL_PROVIDER=graph`.
4. The poller reads new mail with attachments (PDF, images, spreadsheets, text), dedupes by message id, keeps a
   watermark, and optionally marks mail read (`GRAPH_MARK_READ`). **First run starts from "now"**
   — it does NOT ingest the mailbox's historical backlog unless you ask for it with
   `GRAPH_BACKFILL_DAYS` (e.g. `7` to pull the last week). Auth failures raise the
   `mailbox_auth_failure` alert immediately — check Settings → Connectors for the last error.

### Wiring up Teams Approvals (`APPROVALS_PROVIDER=power_automate`)

> **Do not use `APPROVALS_PROVIDER=graph`.** The Graph Approvals API
> (`/beta/solutions/approval/approvalItems`) supports **delegated permissions only** — Microsoft's
> permissions table reads *"Application: Not supported"* — so Finny's client-credentials token can
> never carry `ApprovalSolution.ReadWrite` and every create returns `401 … required scope(s) or
> role(s) not present`. **No permission grant in Entra fixes this.** It is also beta-only and absent
> from Graph v1.0. The `graph` value is kept solely so existing deployments fail loudly instead of
> silently changing behaviour.

Approvals are raised through an HTTP-triggered **Power Automate** flow running *Start and wait for
an approval*. The flow's connection runs as a service account, so there are no per-user tokens to
store or refresh.

```
Finny ──POST──▶ flow (Start and wait for an approval) ──▶ manager decides in Teams
  ▲                                                              │
  └────── POST /api/integrations/approvals/callback ◀────────────┘
```

**1. Build the flow** in Power Automate. Create it as an **Instant cloud flow** — an inbound
HTTP call reads like an "automated" event, but Microsoft files *When an HTTP request is received*
under Instant (triggered on demand, alongside manual buttons and Power Apps); Automated is for
connector-polled events like mail arriving. The category only filters the initial trigger list, so
if your designer doesn't offer it there, start blank and add the trigger directly.

| Step | Action | Notes |
| --- | --- | --- |
| Trigger | *When an HTTP request is received* | Method `POST`, **Who can trigger the flow: `Anyone`** (Finny calls server-to-server with no user token; any other setting returns 401). Copy the generated URL into `APPROVALS_FLOW_URL` — it only exists after you save once. |
| 0 | *Condition* → **terminate unless the secret matches** | `triggerBody()?['sharedSecret']` **is equal to** your `APPROVALS_FLOW_SECRET`. Put a **Terminate** (status `Cancelled`) in the *False* branch and everything else in *True*. See the security note below — without this, the URL alone is enough to raise approvals as Finny. |
| 1 | *Start and wait for an approval* | Type **Approve/Reject – First to respond**. Title `@{triggerBody()?['title']}`, Assigned to `@{triggerBody()?['approverEmail']}`, Details `@{triggerBody()?['description']}`. Under **Advanced parameters → Show all**: **Item link** = `@{triggerBody()?['documentUrl']}`, **Item link description** = `View invoice document`. |
| 2 | *HTTP* | `POST` to the callback URL **hardcoded as a literal** — never `@{triggerBody()?['callbackUrl']}`. Header `Authorization: Bearer <APPROVALS_CALLBACK_TOKEN>`, body below. Reading the URI from the payload lets anyone who can trigger the flow redirect that token to a server of their choosing. |

```json
{
  "requestId": "@{triggerBody()?['requestId']}",
  "decision": "@{if(equals(outputs('Start_and_wait_for_an_approval')?['body/outcome'],'Approve'),'approved','rejected')}",
  "decidedBy": "@{outputs('Start_and_wait_for_an_approval')?['body/responses'][0]['responder']['displayName']}",
  "note": "@{outputs('Start_and_wait_for_an_approval')?['body/responses'][0]['comments']}"
}
```

**2. Set the environment variables:**

| Variable | Value |
| --- | --- |
| `APPROVALS_PROVIDER` | `power_automate` |
| `APPROVALS_FLOW_URL` | the flow's HTTP trigger URL (contains a `sig=` signature — treated as a secret: never logged, never returned to a client, only posted to an allowlisted Microsoft host) |
| `APPROVALS_CALLBACK_TOKEN` | a long random string, also set as the `Authorization: Bearer` header in the flow's HTTP step |
| `APPROVALS_FLOW_SECRET` | a long random string, also hardcoded in the flow's step-0 Condition — see the security note below |
| `APPROVALS_CALLBACK_BASE_URL` | only when `APP_URL` is behind a CDN/WAF — see below |

> ⚠️ **If `APP_URL` is behind Cloudflare (or any WAF), exempt the callback path.** The flow's
> POST is machine-to-machine, so bot protection answers it with a **managed challenge** — HTTP 403
> and a "Just a moment…" HTML page — and the decision never reaches Finny: the invoice strands in
> `awaiting_approval` while Teams shows the approval complete. Managed challenges are
> reputation-scored, so *some* callbacks get through and others don't; the symptom is intermittent
> rather than a clean failure, and nothing is logged in Finny because no request arrives.
>
> The fix is a WAF rule scoped to that one path. In Cloudflare, **Security → WAF → Custom rules**,
> action **Skip**:
>
> ```
> (http.host eq "<your-domain>" and http.request.uri.path eq "/api/integrations/approvals/callback"
>  and http.request.method eq "POST")
> ```
>
> Skip Super Bot Fight Mode, Browser Integrity Check, Security Level and Managed Rules — check
> **Security → Events** filtered to that path to see which one is actually challenging you. On
> Cloudflare's *Free* plan, plain Bot Fight Mode is zone-wide and is **not** reliably skippable by a
> custom rule; it has to be turned off or the plan upgraded. Verify with a deliberately bad token:
> `403` means still challenged, `401 {"error":"Invalid or missing bearer token"}` means the request
> is reaching Finny.
>
> Narrowing the rule to that exact path and method leaves the rest of the zone protected, and the
> endpoint's real authentication is unchanged — a bearer token, timing-safe compared, failing shut
> when unset. Approver *document* links stay on `APP_URL` and keep full protection: a human opening
> one can pass a challenge.
>
> `APPROVALS_CALLBACK_BASE_URL` is the fallback where the WAF can't be changed — point it at the
> origin so the callback skips the edge entirely. Prefer the WAF rule: an origin URL is not a
> stable contract (a recreated Render service gets a new one), whereas the custom domain is.
>
> **Other machine endpoints on the same domain need the same treatment** — notably
> `/api/integrations/blockdocs/invoices`, which is also bearer-token, machine-to-machine, and will
> be challenged the same way. Its symptom is silent gaps in the cost dashboard rather than an error.

Settings → **Connectors** shows the flow host and flags either variable being unset.

> ⚠️ **The trigger URL is a credential, and on its own it is not enough.** `Who can trigger the
> flow` must be `Anyone` for Finny to call it server-to-server, so the signature in the URL is the
> only thing gating it — and a signature embedded in a URL leaks easily, into environment
> variables, flow exports, screenshots and chat logs. Anyone holding it can raise Teams Approvals
> that are **genuinely from Finny**, with an attacker-chosen title, assignee and document link:
> a phishing card arriving through the one channel AP staff are trained to trust, bypassing mail
> filtering entirely because it is not mail.
>
> Two cheap mitigations, both assumed by the steps above:
>
> 1. **Gate the flow on `APPROVALS_FLOW_SECRET`** (step 0). Finny sends it in every request; the
>    flow terminates when it does not match. A leaked URL alone then achieves nothing.
> 2. **Hardcode the callback URI** in the HTTP step. Reading it from `triggerBody()?['callbackUrl']`
>    makes an attacker-controlled value the destination for a request carrying
>    `APPROVALS_CALLBACK_TOKEN` — so anyone who can trigger the flow can have that token posted to
>    a server of their choosing, and then approve any invoice in Finny directly. Finny still sends
>    `callbackUrl` so existing flows keep working, but it must be ignored.
>
> Rotate both secrets if the trigger URL is ever pasted somewhere it should not have been.

**Tenant prerequisites.** Approvals are stored in Microsoft Dataverse. In the **default**
environment it is provisioned automatically; in any **other** environment the person who runs the
first approval flow needs an **administrator role in that environment**, and provisioning takes a
few minutes on that first run. The Approvals connector itself is *standard*, so any licence granting
Power Automate access covers it — but confirm the licence tier of the **Request** connector (the
HTTP trigger) with whoever owns Power Automate licensing before org-wide rollout, since a premium
requirement there would apply to the flow's owner.

**Notes.** Finny correlates on its own `requestId`, echoed back on the callback — nothing depends on
parsing an upstream identifier. The trigger answers `202` with no body, and any `2xx` counts as
accepted. The callback is idempotent: a retried or late callback for an already-decided request
returns `200 {"applied": false}` and changes nothing, so a decision can never be flipped. Without
`APPROVALS_CALLBACK_TOKEN` the endpoint fails **shut** (`503`), never open.

Approving managers are not Finny users, so each approval carries a **signed, expiring link**
(14 days, HMAC-bound to the invoice — `services/attachmentLinks.ts`) that shows them the invoice
document with no account; rotating `SESSION_SECRET` invalidates outstanding links.

Because decisions arrive by callback there is no approvals poller in this mode. If a flow run is
deleted or its HTTP step fails, the request stays `pending` — worth a watchdog before org-wide
rollout.

### Event notifications (self-service)

Separate from the single operational-alert webhook, any signed-in user can subscribe **their own**
Teams chat or channel to invoices they care about, on the **Notifications** page. A subscription
watches one event category — **amount** at/over a threshold, an **invoice/due date** condition
(post-dated, back-dated beyond _N_ days, or due within _N_ days), a **supplier** name, or a
**project** name (both fuzzy-matched) — and posts an Adaptive Card when a matching invoice arrives
(the moment extraction finishes and it enters the review queue). Supplier/project matching is
typo-tolerant (`looseMatch` in `domain/util.ts`); the due-date rule is backed by a real extracted
`due_date` field. The target webhook URL is validated against the same Microsoft-host allowlist as
the alert webhook, stored server-side, and never returned to the client (only its host is shown).
Delivery is at-most-once per invoice per subscription (`webhook_deliveries`). Lives in
`services/notifications.ts`; `services/teamsWebhook.ts` is the shared card/post plumbing.

### Wiring up Entra ID sign-in

With `AUTH_PROVIDER=entra`, the login page becomes a single **Sign in with Microsoft 365**
button: a server-side OpenID Connect authorization-code flow (with PKCE) against the tenant's
v2.0 endpoint, ending in the same signed session cookie dev sign-in uses — the rest of the app
is auth-provider-agnostic, and dev login is disabled. Setup:

1. Reuse the mailbox app registration (or create one): **Authentication → Add platform → Web**,
   redirect URI `https://<your-domain>/api/auth/entra/callback`.
2. **API permissions**: delegated `openid`, `profile`, `email` (no admin consent needed).
3. Set `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` (they fall back to the
   `GRAPH_*` values, so if the mailbox is wired, just add the redirect URI) and
   `AUTH_PROVIDER=entra`. The server refuses to boot if any are missing — dev login never
   silently takes over on a live deploy. **Custom domain on Render:** also set
   `APP_URL=https://<your-domain>` — otherwise Finny derives the callback (and every other
   absolute link) from `RENDER_EXTERNAL_URL`, which stays on `.onrender.com` and Entra rejects
   it with `AADSTS50011` (redirect URI mismatch).
4. `FINNY_LEAD_EMAILS=amy@example.com,rory@example.com` — these are **pinned** AP Leads (they
   can't be demoted in-app, so put your own address here to guarantee access). Everyone else
   starts as a processor; if you leave this blank, the first person to sign in is promoted to
   Lead automatically so a fresh deploy always has an admin.
5. **Who can sign in:** the tenant-specific endpoint already limits sign-in to your tenant. To
   limit it to the finance team, open the app under *Enterprise applications*, set
   **Assignment required = Yes**, and assign the team (or their group). That's access control
   handled in Entra, where IT can audit it.
6. **Managing privilege levels in-app:** point Finny at that same group with
   `FINNY_TEAM_GROUP_ID=<group object id>` and grant the app registration the **application**
   permission `GroupMember.Read.All` (admin consent). **Settings → Team & privileges** then lists
   the group's members with a per-person AP Lead / AP Processor switch — "Sync from Microsoft
   365" re-pulls the roster. Roles resolve live from this directory on every request, so a change
   takes effect on the member's next click (no re-login). Without a group id the card shows a
   sample team so the flow is still visible.
7. **Syncing approving managers:** set `FINNY_APPROVERS_GROUP_ID=<group object id>` (the same
   `GroupMember.Read.All` permission covers it) and **Settings → Approving managers → "Sync from
   Microsoft 365"** pulls that group's members into the approver list — capturing each manager's
   Entra id as their **Teams user id**, which the `graph` approvals provider uses to raise the
   approval. Newcomers are added, names/ids refreshed, and anyone who has left the group is
   deactivated; managers you add by hand are never touched. It can be the same group as the
   sign-in team or a separate approvers group.

Cookies are marked `Secure` automatically when `APP_URL` is https. Sign-out clears Finny's
session but not the Microsoft session — the next sign-in is usually silent SSO.

**Custom domain behind a CDN (Cloudflare):** Finny is a dynamic, authenticated app — do **not**
cache it at the edge. The server sends `Cache-Control: no-store` on every `/api/*` response, but
a Cloudflare **"Cache Everything"** rule ignores origin headers and will serve a stale `/api/me`
(so a signed-out user still looks signed in) and a stale team list. Add a **Cache Rule → Bypass
cache** for the app's hostname (or at least for `/api/*`), then Purge Everything once.

### One-touch "Send to Sage" (HyperAccounts API)

With `SAGE_PROVIDER=hyperaccounts`, generating a batch **posts each invoice straight into Sage 50**
through the on-prem HyperAccounts REST API (Hyperext) — `POST /api/purchaseInvoice` per invoice,
with the nominal/tax-code/department mappings from Settings, the sequential posting ref as the
transaction reference, and a long-lived tokenized link to the invoice document on every
transaction (the API requires one; Sage keeps it). The CSV is still written as the audit copy.

- **Per-entity servers:** each legal entity is its own Sage company dataset, so configure
  `SAGE_ENTITY_SERVERS` (JSON map of entity → `{url, key}`) with `SAGE_API_URL`/`SAGE_API_KEY`
  as the fallback for everything else. An entity with no server keeps the manual CSV flow.
- **Finny reads Sage before it writes** (all via `POST /api/search/auditHeaders`):
  1. *Sequence sync* — before assigning refs, it looks up the highest existing `Inv…` PI
     reference across the relevant Sage companies and fast-forwards its counter past anything
     posted by hand, so refs can't collide. The jump is audited and raises a
     `sage_sequence_adjusted` warning (parallel manual posting is worth knowing about).
  2. *Duplicate detection* — before posting each invoice, it searches for the same supplier
     account + the supplier's invoice number in the Details + the same gross. A hit means someone
     already keyed it manually: Finny **links the invoice to that transaction instead of posting
     again** and raises a `sage_duplicate_detected` warning asking the team to verify.
  3. *Ref-collision guard* — crash recovery only adopts a transaction on Finny's own ref when the
     supplier account and gross also match; if a manual post merely took the ref, Finny reassigns
     a fresh safe one (audited as `posting_ref_reassigned`) and posts under that.
- **Idempotent retries:** invoices with a stored Sage transaction number are never re-sent, and
  anything posted by a previous crashed attempt is adopted instead of posted twice. Failures
  alert and leave a per-batch "Send to Sage" retry that sends only what's missing.
  (The CSV audit copy keeps the refs as first generated; the invoice history is authoritative
  when a ref was reassigned.)
- **The coding list IS Sage's chart of accounts:** the AP Lead picks a company in Settings and
  pulls its **active nominal codes** (`GET /api/nominal`, inactive codes filtered out); the union
  across pulled entities becomes the coding list used everywhere — extraction, learned rules, the
  review dropdown, and the export's N/C column — so nobody maintains a hand-typed copy. Re-pull
  any time to pick up chart changes; codes retired in Sage drop out. Until a server is
  configured, the seeded editable list applies (which is how the offline demo works).
- **Settings validate against the live Sage company:** the "Check against Sage" panel pulls tax
  codes, departments, and projects (`GET /api/taxCode`, `/api/department`,
  `POST /api/searchProject`) alongside the nominals and checks every mapping — tax codes get
  their live rates compared, and active Sage projects Finny doesn't know are offered as
  one-click imports. Read-only, lead-only, and available as soon as a server is configured —
  even before `SAGE_PROVIDER` flips to one-touch mode.
- **Confirm with Hyperext before go-live:** the API-key **header name** (docs say "API Key,
  collection-level" without naming it — `SAGE_API_KEY_HEADER` defaults to `x-api-key`), and that
  the tokenized document links (served by Finny at `APP_URL`) are reachable from wherever Sage
  users click them.

### Sage 50 posting format — matches the AP team's sheet

The export mirrors the team's "Invoices to be posted" workbook column-for-column:
`A/C, Date, Ref, Ex Ref, N/C, Dept, Details, Net, T/C, Vat, Gross` — one file per legal entity.
`Ref` is Finny's own sequential posting reference (the sheet's `Inv27xxx` series; starting number
configurable in Settings, stamped onto each invoice at export), `Ex Ref` carries the PO, `Dept`
comes from the invoice's project (each project holds its Sage department number), the supplier's
invoice number is composed into `Details` (`Inv4590 - Vendor (CODE/PO 8749)`), and zero-VAT lines
post with the 0% tax code (T9 by default). Nominal codes (pulled from Sage per entity, or
hand-maintained until connected), tax codes, fallback
dept, and the next Ref number are all editable in Settings — validate one small batch against the
live Sage install before relying on it. Supplier account refs are suggested from the vendor name
and editable per invoice; Finny reuses the last-used ref per vendor.

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
- **Multi-entity billing:** extraction reads which legal entity the invoice is addressed to
  (matched against the list in Settings — required at confirm), and generating an export
  **splits batches per entity** since each entity is its own Sage company dataset. Projects are
  read from the document when referenced, assignable at review when not, and drive the Sage
  Dept column via each project's department number.
- **Rejected invoices are terminal** in v1; the audit trail records who rejected and why.
- **The audit trail is append-only and retained indefinitely.** Every user and system action —
  sign-ins, reviews, rule changes, settings edits, Sage posts, data exports — writes an
  `audit_events` row; database triggers reject any UPDATE or DELETE, so the trail is a
  guarantee, not a convention. AP Leads get a filterable global view (Audit in the nav) and a
  CSV export for auditors; exporting the trail is itself logged.
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

### BlockDocs cost-dashboard export

`GET /api/integrations/blockdocs/invoices` is a machine-to-machine pull endpoint returning
**approved, project-tagged** invoices for BlockDocs' budget-vs-invoiced dashboard. Auth is a
static bearer token (`FINNY_BLOCKDOCS_TOKEN`; unset = 503, wrong = 401), with optional
`?project_code=` and `?since=` (ISO timestamp, inclusive, against the approval time) filters.
The response carries `approved_at` — deliberately **not** a payment date: Finny stops at
approval and hands off to Sage, so BlockDocs must not treat "approved" as "paid". Invoices
without a project are excluded by design (the dashboard matches on `project_code`).

## Deploying a shareable demo (Render)

The repo ships a [render.yaml](render.yaml) blueprint: Render dashboard → **New → Blueprint** →
select this repo → Deploy. You get a single web service (API + web app on one URL) with a 1 GB
persistent disk. Set `SEED_DEMO=true` to seed the demo dataset on first boot (a populated
queue, learned rules, dashboard history) — leave it unset for a **real, empty** deployment.
Everything runs on mock providers until you add keys. Pushes to `main` auto-deploy.

Notes: the blueprint boots with dev sign-in, so anyone with the URL can log in — fine for a
`SEED_DEMO=true` sandbox; for the team-facing deploy set `AUTH_PROVIDER=entra` (see "Wiring up
Entra ID sign-in") so access is M365 accounts only. Under Entra the team/approvers directories
run against real Microsoft 365 (never the sample people), and the first person to sign in with
no lead configured is made AP Lead — set `FINNY_LEAD_EMAILS` to pin that deterministically. To
run free-tier instead, set `plan: free` and remove the `disk` block — the service then sleeps
when idle (and, with `SEED_DEMO=true`, re-seeds fresh demo data on wake).

## Commands

```bash
npm run dev          # server (tsx watch) + web (vite) together
npm run demo         # seed demo history (add -- --force to wipe & re-seed)
npm test             # server unit/integration tests (vitest)
npm run typecheck    # both apps
npm run build        # typecheck + production web build (server then serves it)
```
