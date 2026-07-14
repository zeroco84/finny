# Design — Finny

A locked design system for the Finny AP app. Every page reads its look from one
global stylesheet (`apps/web/src/styles.css`), so the system is applied by tokens
and shared component classes — pages inherit it, they don't re-theme.

Introduced by `hallmark redesign` (whole-app, "bubble" brief → Hum theme).

/ Hallmark · pre-emit critique: P5 H4 E5 S5 R4 V4 /

## Genre
playful

## Theme — Hum (playful register)
Cream paper, multi-accent, rounded-sans, big radii, chunky "push" buttons, soft
lifting shadows. Adapted from Hallmark's marketing-oriented Hum spec to a **dense
functional app**: the component DNA is carried over (palette, type, radii, button
physics, motion discipline); marketing-only moves (hero bands, streak counters,
mascot) are dropped.

- `--color-paper`    oklch(96.5% 0.014 95)   — cream, never pure white
- `--color-surface`  oklch(99% 0.006 95)     — card, warm near-white
- `--color-ink`      oklch(24% 0.014 260)    — near-black, never pure black
- `--color-ink-2`    oklch(48% 0.012 260)
- `--color-rule`     oklch(89% 0.015 95)
- `--color-pear`     oklch(87% 0.17 95)      — primary action (dark ink sits on it)
- `--color-cyan`     oklch(66% 0.16 235)     — links / info / in-progress
- `--color-coral`    oklch(64% 0.21 22)      — danger / the one pop
- `--color-mint`     oklch(72% 0.15 155)     — success
- `--color-amber`    oklch(72% 0.13 70)      — warnings / shadow-mode strip
- `--color-focus`    oklch(52% 0.15 245)     — cyan focus ring

Full token set (with -deep / -soft variants, spacing, motion) in `tokens.css`.

## Typography
- Display + body: **Plus Jakarta Sans**, weight 700 (headings) / 600 (emphasis) / 400 (body). Roman only — no italic headers.
- Mono: **JetBrains Mono**, weight 500 — uppercase labels (field labels, table
  headers, eyebrows) and big tabular counters (stat values).
- No serif anywhere. Tight display tracking (−0.02 to −0.03em); body neutral.
- Both self-hosted via `@fontsource` (imported in `apps/web/src/main.tsx`) — no
  runtime Google Fonts fetch, which keeps the internal tool offline-safe.

## Spacing
4-point named scale in `tokens.css`. The app's existing per-component spacing is
preserved; the redesign changed the visual layer, not the layout geometry.

## Shape
- Cards 20px · inputs 12px · buttons & chips & nav links = pill (999px). No square corners.
- Soft layered shadows (contact + ambient); shadows lift on hover for interactive elements.

## Motion
- Easings: `--ease-spring` (0.34,1.56,0.64,1), `--ease-snap` (0.22,1,0.36,1), `--ease-out`, `--ease-in-out`.
- Primary buttons are **push**: lift 2px on hover (colour edge grows), press DOWN
  3px on `:active` (edge shrinks) — the press is the feedback. No scale, no wobble.
- One character moment: the Finny mark breathes gently at rest.
- `prefers-reduced-motion`: transforms/animations collapse; the app stays delightful, not broken.

## Microinteractions stance
- Silent success; optimistic where the app already is. Table rows tint pear on hover.
- Focus-visible rings on all interactive elements (never animated), ≥3:1 contrast.

## CTA voice
- Primary: pear "push" pill, dark ink label.
- Secondary: soft cream pill, hairline border, subtle hover lift.
- Danger: coral outline ghost.

## What pages share
- The wordmark, the Plus Jakarta Sans + JetBrains Mono pairing, the pear/cyan/coral/mint
  accent roles, the pill CTA voice, the 20px card + soft shadow rhythm.

## Status-colour mapping (functional semantics)
- needs-review → amber · received/extracting → cyan · confirmed/awaiting → lavender ·
  approved/complete → mint · failed/rejected → coral · discarded → muted.
- Confidence: ok → mint · low → amber · missing → coral.
- Left-accent card stripes (an AI tell) were replaced with soft tinted card surfaces.

## Known follow-ups (out of scope for this pass)
- The top nav and wide data tables are desktop-first (pre-existing); a phone-width
  pass (collapsing nav + scroll-wrapped tables) is a separate, structural change.
- The `.design-sync` / `ds-bundle` UI-kit export still reflects the old green theme —
  resync it to publish the Hum tokens (see project memory: design-sync resync how-to).

## Exports
Portable token formats live in `tokens.css` (CSS custom properties). Mirror to
Tailwind `@theme` / DTCG / shadcn variables from there if another surface needs them.
