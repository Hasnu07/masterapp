# Type Scale Math

Modular scales keep heading sizes predictable. Pick one ratio per product and stay on it.

## Base assumption

- Root: `16px` (`1rem`)
- Body: `1rem`
- Secondary: `0.875rem` (14px) — one step down outside the modular scale (fixed tier)
- Meta: `0.75rem` (12px) — fixed floor; never go lower

## Ratio comparison

| Step | Major Second (1.125) | Minor Third (1.2) |
|------|---------------------|-------------------|
| −1 (fixed) | 0.875rem (14px) | 0.875rem (14px) |
| 0 body | 1rem (16px) | 1rem (16px) |
| 1 | 1.125rem (18px) | 1.2rem (19.2px) |
| 2 | 1.266rem (20.3px) | 1.44rem (23px) |
| 3 | 1.424rem (22.8px) | 1.728rem (27.6px) |
| 4 | 1.602rem (25.6px) | 2.074rem (33.2px) |
| 5 | 1.802rem (28.8px) | 2.488rem (39.8px) |
| 6 | 2.027rem (32.4px) | 2.986rem (47.8px) |

**Major Second (1.125):** Dense dashboards, data-heavy UI (Linear, Raycast).

**Minor Third (1.2):** Marketing-forward product UI with clearer heading jumps (Stripe-like clarity); also Notion editorial pages. Notion page titles may use the high end of H1 (step 4–5).

## Formula

```
size(step) = base × ratio^step
```

Where `base = 1rem` and `step` is an integer ≥ 0 for headings above body.

Round to 2 decimal places in rem; avoid rounding to odd px values that break the 4pt grid when converted.

## Recommended mapping

| Role | Major Second | Minor Third | Weight | Line-height |
|------|-------------|-------------|--------|-------------|
| Meta | 0.75rem | 0.75rem | 400 | 1.4 |
| Secondary | 0.875rem | 0.875rem | 400 | 1.5 |
| Body | 1rem | 1rem | 400 | 1.55 |
| H4 / subheading | step 1 | step 1 | 500 | 1.25 |
| H3 | step 2 | step 2 | 600 | 1.25 |
| H2 | step 3 | step 3 | 600 | 1.2 |
| H1 / display | step 4–5 | step 4–5 | 600 | 1.1–1.2 |

## Line-height in em/rem

Prefer **unitless** line-height so it scales with font-size:

| Category | Size range | line-height |
|----------|-----------|-------------|
| Display | ≥ 2rem | 1.1 – 1.15 |
| Heading | 1.25rem – 1.99rem | 1.2 – 1.25 |
| Body | 1rem | 1.5 – 1.6 |
| Secondary | 0.875rem | 1.5 – 1.55 |
| Meta | 0.75rem | 1.35 – 1.4 |

**Px equivalent check:** body 16px × 1.55 = 24.8px line box — aligns to 4pt grid (24px) with acceptable half-step tolerance.

## em-based local adjustments

Inside a heading, a `span.meta` at `0.75em` inherits the heading's font-size context:

```css
h2 .meta {
  font-size: 0.75em;
  font-weight: 400;
  line-height: 1.4;
}
```

Do not nest more than one em-scaled size level — flatten to rem tokens instead.

## Verification

1. List every unique `font-size` in the changed scope — must map to scale table or fixed tiers (12/14/16).
2. List every `font-weight` — only 400, 500, 600 allowed.
3. Confirm display/heading line-heights ≤ 1.25 and body ≥ 1.5.
