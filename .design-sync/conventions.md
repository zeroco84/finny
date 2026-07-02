# Finny UI Kit — build conventions

Finny is Meadowvale's accounts-payable tool: a light, calm finance UI (warm off-white background,
deep pine-green brand, amber accents). Everything below exists in the shipped `styles.css` /
`_ds_bundle.css` — read those files before inventing anything.

## Setup

No provider or theme wrapper is needed — components are context-free React functions on
`window.FinnyWeb`. Global styles (background, body font, headings) come from `styles.css`; it must
be loaded for anything to look right. The body font is **Nunito Sans** (shipped in `fonts/`,
already wired through `styles.css`) falling back to `'Segoe UI', system-ui` — never import other
webfonts.

## Styling idiom: CSS utility/component classes + design tokens

Style your own layout glue with these real class families (from `styles.css`) — do not invent new
class names and do not use Tailwind/inline-style systems:

| Family | Classes |
|---|---|
| Page scaffold | `page`, `page-wide`, `page-head`, `page-actions`, `page-loading`, `crumb` |
| Cards & stats | `card`, `stat-row`, `stat`, `stat-value`, `stat-label`, `dash-grid` |
| Tables | `table`, `table-compact`, `table-click`, `num` (right-aligned numerics), `row-link`, `row-actions` |
| Buttons | `btn` + modifiers `btn-primary`, `btn-ghost`, `btn-danger-ghost`, `btn-small` |
| Forms | `field`, `field-label`, `field-grid`, `field-wide`, `field-tight`, `form-error`, `ai-ghost`, `radio-row` |
| Tabs & nav | `tabs`, `tab`, `tab-active`, `topbar`, `nav-badge`, `nav-badge-alert`, `wordmark` |
| Status & flags | `chip` + `status-<status>` (e.g. `status-approved`, `status-needs_review`), `conf conf-ok|conf-low|conf-missing`, `flag flag-dup|flag-doc` |
| Messaging | `banner banner-info|banner-warn|banner-error|banner-success`, `empty-state`, `mode-strip` |
| Detail layout | `detail-grid`, `attachment-pane`, `rationale`, `timeline`, `timeline-time` |
| Misc | `muted`, `small`, `dropdown`, `dropdown-menu`, `alert-card`, `pending-card`, `export-bar`, `login-card` |

Colour/spacing decisions go through the tokens defined on `:root` in `styles.css` — use
`var(--…)`, never hard-coded hex: `--bg`, `--surface`, `--ink`, `--ink-soft`, `--line`, `--brand`,
`--brand-strong`, `--brand-soft`, `--accent`, `--accent-soft`, `--danger`, `--danger-soft`, `--ok`,
`--ok-soft`, `--warn`, `--warn-soft`, `--radius`, `--shadow`.

## Components

Import the six kit components rather than rebuilding their look: `StatusChip` (invoice lifecycle
pill — pass the raw status string like `"needs_review"`), `ConfidenceBadge` (AI field confidence
vs threshold), `Banner` (info/warn/error/success), `EmptyState`, `BarRow` (accuracy bar with
optional target line), `TrendLine` (weekly SVG line chart). Each component's `.d.ts` is the exact
prop contract and its `.prompt.md` shows verified compositions.

## Idiomatic example

```jsx
import { StatusChip, ConfidenceBadge } from '@finny/web';

<div className="page">
  <div className="page-head">
    <h1>Invoice queue</h1>
    <div className="page-actions"><button className="btn btn-primary">Upload invoice</button></div>
  </div>
  <div className="card">
    <table className="table table-click">
      <thead><tr><th>Vendor</th><th className="num">Gross</th><th>Fields</th><th>Status</th></tr></thead>
      <tbody>
        <tr>
          <td><strong>Hegarty Steel Ltd</strong> <span className="muted">HS-1234</span></td>
          <td className="num">€1,230.00</td>
          <td><ConfidenceBadge value={0.91} threshold={0.75} /></td>
          <td><StatusChip status="needs_review" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
```
