# Motion accessibility

Companion to `reduced-motion`. Patterns for `prefers-reduced-motion` and non-motion meaning.

## Detection

```css
@media (prefers-reduced-motion: reduce) {
  /* instant or opacity-only */
}

@media (prefers-reduced-motion: no-preference) {
  /* full motion tokens from `motion` */
}
```

JS (when needed):

```javascript
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

Listen for `change` if the user toggles OS settings while the app is open.

## What to strip under reduce

| Remove / replace | Fallback |
| --- | --- |
| `translate` / `scale` enter | Instant show or opacity ≤150ms |
| Parallax / scroll-linked motion | Static layout |
| Bounce / elastic | None |
| Autoplay Lottie / decorative video | Static poster frame |
| Skeleton shimmer | Static muted blocks |
| Staggered list cascades | Instant list render |

## Meaning must not depend on motion

| State | Motion cue (optional) | Required non-motion cue |
| --- | --- | --- |
| Saved | Brief opacity flash | Text "Saved", toast, or check icon |
| Error | Shake (avoid under reduce) | Inline error text + `aria-invalid` |
| Loading | Spinner | `aria-busy`, visible "Saving…" |
| New item | Highlight fade | Badge "New" or focus move |

## Scoped override pattern (preferred)

```css
.slide-over {
  transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out);
}

@media (prefers-reduced-motion: reduce) {
  .slide-over {
    transition: opacity 100ms ease;
    transform: none;
  }
}
```

## Checklist for reviews

- [ ] Media query present for every motion rule introduced
- [ ] No vestibular triggers under reduce (large slides, zoom, parallax)
- [ ] Screen reader / visible text still explains the state
- [ ] Focus order unchanged when animations are disabled
