# Elevation Tokens — Surface Hierarchy

Surfaces stack from canvas (L0) to overlay (L3). Depth is communicated by border contrast first, then optional soft shadow.

## Surface levels

| Level | Role | Typical elements | Background rule | Border | Shadow (light) |
|-------|------|------------------|-----------------|--------|----------------|
| **L0** | Canvas | Page background, main app shell | Dominant neutral — **~60%** of visible area | None | None |
| **L1** | Structural | Cards, sidebars, **lists, tables, boards**, inset panels | One step above L0 — **~30%** combined | `1px` at 6–10% fg alpha | Optional: `0 1px 2px rgba(0,0,0,0.04)` |
| **L2** | Floating | Dropdowns, popovers, sticky subheaders | One step above L1 | `1px` at 8–12% fg alpha | `0 4px 12px rgba(0,0,0,0.06)` max |
| **L3** | Overlay | Modals, command palette, slide-overs | Highest surface; scrim behind | `1px` at 10–14% fg alpha | `0 8px 24px rgba(0,0,0,0.08)` ceiling |

**Rule:** Shadow alpha on L1–L3 must stay **< 0.08** in light mode. If shadow reads as a "sticker," reduce alpha or remove shadow and rely on border.

**List / table / board:** Always L1. Require a 1px subtle border, **or** a one-step background shift **and** hairline row/column dividers. Table or list text sitting on L0 with no border and no hairlines is a **fail**.

**Paper / “borders rare” profiles:** Rare decorative card chrome is fine. Lists still need hairlines and a quiet L1. Do not treat “borders rare” as no table frame.

## 60-30-10 color budget

| Bucket | Target area | Allowed usage |
|--------|-------------|---------------|
| **60% — Dominant** | L0 canvas, large empty regions | Neutrals only |
| **30% — Structural** | L1 surfaces, chrome, nav backgrounds | Neutral steps; no accent fill |
| **10% — Accent** | Primary buttons, active states, key links, focus rings | Single accent hue family |

Measure on a representative **screenshot**: sample major regions from the image (full-width sidebar ≈ 20–30% structural). Do not score from token counts or “accent is on the CTA.” Fail if structural area is ~0%.

## Z-index stack

| z-index | Layer | Notes |
|---------|-------|-------|
| `0` | Default document flow | L0/L1 content |
| `10` | Sticky local headers | Within page context |
| `100` | Dropdowns, tooltips | L2; trap overflow |
| `200` | Slide-overs, drawers | L2–L3; pair with scrim |
| `300` | Modals, command palette | L3; focus trap required |
| `400` | Toasts / global alerts | Above modals sparingly |

Avoid arbitrary large values (`99999`). Gaps leave room for insertion.

## Light mode token example

```css
:root {
  --surface-l0: #fafafa;
  --surface-l1: #ffffff;
  --surface-l2: #ffffff;
  --surface-l3: #ffffff;
  --foreground: #171717;
  --border-l1: color-mix(in srgb, var(--foreground) 8%, transparent);
  --border-l2: color-mix(in srgb, var(--foreground) 10%, transparent);
  --shadow-l1: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-l2: 0 4px 12px rgba(0, 0, 0, 0.06);
  --shadow-l3: 0 8px 24px rgba(0, 0, 0, 0.07);
  --accent: #2563eb;
}
```

## Dark mode adjustments

| Property | Adjustment |
|----------|------------|
| L0 → L1 step | +4% to +8% lightness (or mix toward white 4–8%) |
| Borders | Slightly higher alpha (10–14%) — low borders vanish on dark canvas |
| Shadow | Prefer **none** or very low alpha; use **inset top highlight** |
| Edge lighting | `inset 0 1px 0 rgba(255,255,255,0.04–0.08)` on L1+ |
| Scrim | `rgba(0,0,0,0.5–0.7)` behind L3 — not accent-colored |

**Banned:** Hard drop-shadow (`rgba(0,0,0,0.3+)`, blur < 8px, offset > 4px), neon outer glow, multiple stacked shadow layers with combined alpha > 0.08.

## Elevation decision tree

```
Does it sit on the page canvas?
  yes → L1 + border
  no, floats but page still visible?
  yes → L2 + border + soft shadow (optional)
  no, blocks primary workflow?
  yes → L3 + scrim + border + max soft shadow
```

## Verification checklist

1. Inspect each elevated element — border defined before shadow?
2. Compute shadow color alpha in DevTools — under 0.08 (light)?
3. From a screenshot, estimate 60/30/10 — fail if structural area is ~0%; accent near 10% of viewport?
4. List / table / board — L1 frame or bg-shift + hairlines (not bare L0 text)?
5. Dark mode — inset highlight present, no sticker shadow?
