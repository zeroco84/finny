# design-sync notes — Finny

- Finny is an app, not a DS package: `@finny/web` has no build/dist. Synth-entry mode with
  `srcDir: "src/components"` is **load-bearing** — without it the scan sweeps all of `src/`,
  and `src/main.tsx` runs `createRoot(...)` at module scope, which mounts the whole app into
  every preview card's `#root` (symptoms: React `removeChild` NotFoundError in cards, and
  `[BUNDLE_EXPORT] 6/6 not a component` because the smoke harness has no `#root` so the IIFE
  throws before assigning `window.FinnyWeb`).
- The 6 kit components live in one file: `apps/web/src/components/ui.tsx` (pinned in
  `componentSrcMap`). New shared components added there are picked up automatically; components
  added elsewhere under `src/components/` also get scanned.
- Converter deps in `.ds-sync/` include `playwright@1.59.0` pinned to the machine's cached
  chromium build 1217 (`~/Library/Caches/ms-playwright`). On a new machine, match the playwright
  version to whatever chromium build is cached (browsers.json revision) or let it download.
- Brand font is **Nunito Sans** (variable, OFL — Google Fonts substitute for Avenir Next; user
  decision 2026-07-02, finance team is on Windows). Files live in `apps/web/src/fonts/` and ship
  to the bundle via `cfg.extraFonts`. The font CSS is imported from `main.tsx`, NOT `@import`ed
  from `styles.css` — a styles.css `@import` gets embedded verbatim into `_ds_bundle.css` and
  dangles there (`[CSS_IMPORT_MISSING]`).
- `cardMode: "column"` overrides on BarRow, EmptyState, TrendLine — their stories are ~520px
  panels that overflow multi-column grid cells.

## Known render warns

- None — the render check and validate are fully clean as of 2026-07-02.

## Re-sync risks

- Preview content (vendor names, copy) is inlined in `.design-sync/previews/*.tsx` — if the app's
  status set in `ui.tsx`/`format.ts` gains or renames statuses (`STATUS_LABELS`), the StatusChip
  preview sweep goes stale silently; re-check it against `STATUS_LABELS` when statuses change.
- The conventions header enumerates class families from `apps/web/src/styles.css` — renaming or
  removing classes/tokens there makes the header lie. The header-validation pass on re-sync
  catches names that vanish; run it whenever styles.css changes shape.
- Toolchain assumption: Node ≥ 22.5 (repo uses `node:sqlite` elsewhere; converter ran on v25.8.2).
- No Storybook and no package build exist; if a real component-library build is ever added
  (dist + .d.ts), drop `srcDir` and let the converter use the shipped entry for stronger types.
