# Timing Benchmarks

Perceptual thresholds and skeleton behavior for loading UI.

## Duration bands

| Band | Range | UI response | Rationale |
|---|---|---|---|
| Instant | 0–100ms | No loader | Perceived as immediate; loader causes flicker |
| Short | 100ms–1000ms | Inline on trigger | User anchored to action; avoids page takeover |
| Long | >1000ms | Structural skeleton | Occupies wait time; prevents layout shock |
| Very long | >5000ms | Skeleton + progress hint | Consider staged loading or partial render |

## 100ms debounce rule

Do not mount loader DOM until 100ms after the request starts:

```
t=0     request starts
t<100   complete → user never sees loader ✓
t≥100   show inline spinner or skeleton branch
```

Implement with `setTimeout` / `requestAnimationFrame` gate; clear on completion.

## Inline loader (100ms–1s)

Apply to:
- Submit / Save buttons
- Row action icons
- Inline refresh controls

Pattern:
- Disable control (or `pointer-events: none`)
- `aria-busy="true"`
- Small spinner adjacent to label or replace icon slot
- Optional copy: Saving…, Uploading…

Avoid:
- Full-page overlay
- Blocking unrelated regions

## Skeleton loader (>1s)

Skeleton must mirror final layout:

| Final content | Skeleton stub |
|---|---|
| Avatar + 2 text lines | Circle + 2 rounded rects |
| Data table | Header row + N body rows of bars |
| Card grid | Same column count, card height, gap |
| Sidebar nav | Icon circles + label bars |

Shimmer rhythm (when motion allowed):
- Period: 1.2–1.8s
- Easing: ease-in-out
- Opacity delta: subtle (≈0.04–0.08 alpha shift)
- Direction: LTR gradient sweep or opacity pulse

```css
@keyframes shimmer {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
}
```

With `prefers-reduced-motion: reduce`: static muted blocks, no animation.

## Full-page spinner — banned for content load

Allowed only for:
- Initial app shell bootstrap with no layout yet (first paint, <3s max)
- Explicit blocking operations user initiated (Exporting 10k rows) with cancel option

Not allowed for:
- Route transitions with known layout
- Tab switches
- Filter / sort refetches

Replace with route-level skeleton.

## Measuring in development

- Throttle network (Slow 3G) and CPU (4× slowdown)
- Log `performance.now()` delta from action to paint
- Verify no loader flash on <100ms cached responses

## Checklist

- [ ] Debounce 100ms before loader mount
- [ ] Inline for sub-1s control-bound work
- [ ] Skeleton geometry matches shipped layout
- [ ] Reduced motion variant tested
- [ ] No centered giant spinner for content blocks
