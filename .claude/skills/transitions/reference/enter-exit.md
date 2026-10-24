# Enter and exit patterns

Companion to `transitions`. Maps surface types to motion without layout jump.

## Surface → motion

| Surface (`surfaces` skill) | Enter | Exit | Notes |
| --- | --- | --- | --- |
| Inline edit | None or 100ms opacity | Instant / 100ms | Reserved height; no expand animation |
| Popover / menu | 150–200ms opacity + optional scale 0.98→1 | 100–150ms opacity | Transform-origin toward trigger |
| Slide-over / drawer | 200ms `translateX` (+ opacity) | 150ms reverse | Fixed position; do not animate width |
| Modal dialog | 150–200ms opacity (+ slight translateY 4–8px) | 150ms | Prefer for destructive confirm only |
| Full page / route | Prefer instant or view-transition opacity | Instant | Do not fake a drawer for ≥10s tasks |

## Layout reservation

- **Drawer:** `position: fixed` (or sticky overlay root). Main content may dim but must not reflow width unless a persistent sidebar pattern is intentional and reserved.
- **Inline:** reserve final height before swap (min-height on row).
- **Popover:** absolute/fixed to trigger; never insert a block that pushes page content.

## Stagger rules

```
delay(i) = min(i * 30ms, 200ms)
```

- Use for first paint of a short list (≤10 items) when it aids scanning.
- Skip for filter/search updates, keyboard navigation highlight, and virtualized lists.
- Prefer opacity-only stagger; avoid per-item translate that causes paint thrash.

## Focus and dismiss

1. Open: move focus into overlay after paint (or immediately if reduced motion).
2. Esc / Cancel: start close immediately — do not await exit animation to handle the key.
3. After close: restore focus to trigger (see `keyboard`).
4. Exit animation may finish in the background after focus has left.

## Anti-patterns

| Bad | Why | Fix |
| --- | --- | --- |
| Animate `height: 0` → `auto` | Layout thrash, jank | Transform + reserved space |
| 80ms × N row stagger | Feels slow | Cap total ≤200ms or remove |
| Block Esc until exit ends | Traps keyboard users | Handle Esc on keydown; animate optionally |
| Page-wide parallax on route | Decorative, motion-sick | Instant or opacity only |
