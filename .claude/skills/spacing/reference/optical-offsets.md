# Optical Offsets — Alignment Formulas

Use these formulas when CSS default alignment looks visually wrong. All offsets are applied via `transform: translateY()` on the icon wrapper, not by breaking the spacing grid.

## Cap-height alignment (icon + label)

Given:

| Symbol | Meaning |
|--------|---------|
| `fs` | Font size of adjacent text (px) |
| `lh` | Line height of text (px or unitless × fs) |
| `capRatio` | Cap-height ÷ em size for the typeface (default **0.70** for UI sans; measure in DevTools if brand font differs) |
| `iconSize` | Icon width/height (px) |

**Cap-height center from line box top:**

```
capCenter = (lh - fs * capRatio) / 2 + (fs * capRatio) / 2
          = lh / 2 - fs * capRatio / 2 + fs * capRatio / 2
          = lh / 2   /* simplified when icon sits on cap centerline */
```

**Practical offset (icon centered to cap-height, not line box):**

```
iconOffsetY = (lh - iconSize) / 2 - (lh - fs * capRatio) / 2
            = (fs * capRatio - iconSize) / 2
```

Example: `fs = 14`, `lh = 20`, `capRatio = 0.70`, `iconSize = 16`:

```
iconOffsetY = (14 * 0.70 - 16) / 2 = (9.8 - 16) / 2 ≈ -3.1px → translateY(-3px)
```

Round to nearest 0.5px. Document the typeface if `capRatio` differs from 0.70.

## Chevron / caret centering in controls

Chevrons in buttons and selects should align to the **cap-height center** of the label, not the button's vertical midpoint when padding is asymmetric.

```
chevronOffsetY = iconOffsetY   /* same formula as above */
```

If the control is icon-only (no label), center to the control's content box using flex `align-items: center` — no cap-height offset needed.

## SVG stroke vs fill icons

| Icon type | Adjustment |
|-----------|------------|
| Filled 16×16 | Use formulas as-is |
| 24×24 stroke (2px) | Subtract 1px from visual weight: add `translateY(+0.5px)` if stroke sits low |
| Circular badges | Center geometrically; cap-height rule applies only to inline text pairs |

## Baseline lock for mixed sizes

When a 12px meta label sits beside a 16px title in one row:

```css
.mixed-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
```

Do not use `align-items: center` for text of different sizes in the same hierarchy row.

## Quick verification

1. Screenshot the row at 2× zoom.
2. Draw a horizontal line through the top of lowercase "x" in the label.
3. Icon visual center should fall between cap-height and x-height, not above ascenders or below the line box.

## Common typeface cap ratios

| Typeface | capRatio (approx.) |
|----------|-------------------|
| Inter | 0.72 |
| SF Pro / system-ui | 0.70 |
| Roboto | 0.73 |
| IBM Plex Sans | 0.71 |

When unknown, use **0.70** and refine after visual check.
