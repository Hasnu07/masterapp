# Icon Button Contract

Companion to `icon-buttons`. When to collapse a label to a square icon, how tooltips must look, and framework-agnostic markup.

## When to use icon buttons

| Prefer icon button | Keep visible label |
|---|---|
| Toolbar / chrome with a standard mark (export, filter, columns, more, close) | Page primary CTA (Create job, Save changes) |
| View toggles (board vs list, grid vs table) | Destructive actions (Delete, Remove) — confirm still via `surfaces` |
| Compact grouped controls in one cluster | Ambiguous icon without domain convention |
| Recurring secondary chrome next to search | Form submit / wizard Continue |

Collapsing is a heuristic. Once you collapse, the hard rules in `SKILL.md` apply.

## Tooltip anatomy

```text
[ Export CSV ]           no shortcut
[ Export CSV  ⌘E ]       shortcut — project Kbd, or plain text if no Kbd primitive
```

Rules:

1. Label text = the verb-first string the labeled button would have used (`Export CSV`, `Board`, `List`).
2. Shortcut (if any) sits after the label, visually secondary.
3. Use the project’s **Kbd** component when one exists. Otherwise append platform-aware text (`⌘E` on Mac, `Ctrl+E` elsewhere).
4. Show on pointer hover **and** keyboard focus (`:focus-visible` / focus-within of the trigger).
5. `title="..."` fails — too slow, no kbd slot.

Accessible name stays on the control (`aria-label` matching the label portion). Do not treat the tooltip as the only name.

## Markup sketch

```html
<!-- Icon button + tooltip with shortcut -->
<button
  type="button"
  class="icon-btn"
  aria-label="Export CSV"
  aria-describedby="tip-export"
>
  <!-- monochrome export icon from project icon library -->
</button>
<div id="tip-export" role="tooltip" hidden>
  <span>Export CSV</span>
  <kbd>⌘E</kbd>
</div>

<!-- View toggle: square icons, no shortcut -->
<div role="group" aria-label="View">
  <button type="button" class="icon-btn" aria-pressed="true" aria-label="Board" aria-describedby="tip-board">
    <!-- board / columns icon -->
  </button>
  <div id="tip-board" role="tooltip" hidden>Board</div>

  <button type="button" class="icon-btn" aria-pressed="false" aria-label="List" aria-describedby="tip-list">
    <!-- list icon -->
  </button>
  <div id="tip-list" role="tooltip" hidden>List</div>
</div>
```

```css
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 2.75rem;   /* 44px — use 3rem (48px) when profile is AAA */
  height: 2.75rem;
  padding: 0;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 0.375rem;
  background: var(--surface, #fff);
}

.icon-btn[aria-pressed="true"] {
  background: var(--surface-muted, #f3f4f6);
}
```

Prefer the design-system tooltip + Kbd primitives when the project has them. This sketch is the contract shape, not a required component API.

## Audit flags

Fail if any of these are true for an icon-only control:

- No tooltip on hover, or tooltip missing on keyboard focus
- Uses only `title="..."`
- Missing `aria-label` / accessible name
- Tooltip label is truncated or non-verb (`CSV`, `OK`) when a verb-first label exists
- Action has a documented shortcut but tooltip omits kbd / shortcut text
- Control is not square, or hit area is below the profile floor (glyph size ≠ hit size)

## Related skills

- `verbs` — label wording inside the tooltip
- `keyboard` — shortcut bindings and platform display
- `viewports` — hit-target floor
- `labels` — `aria-label` on icon-only controls
- `page-patterns` — toolbar placement for Export and view toggles
