# Destructive Actions — Confirmation Modal Spec

Every irreversible or hard-to-reverse operation (delete, revoke, purge, disconnect, reset) requires this dialog pattern. Applies across stacks; implement with native `<dialog>`, focus-managed div, or platform equivalent.

## Layout structure

```
┌─────────────────────────────────────────┐
│  Delete workspace "Analytics"?          │  ← Title: verb + quoted entity name
├─────────────────────────────────────────┤
│  This permanently removes 12 projects,  │  ← Body: impact in plain language
│  3 integrations, and all member access.   │     (counts, data loss scope)
│  This cannot be undone.                 │
├─────────────────────────────────────────┤
│              [ Cancel ]  [ Delete workspace ] │
│                 ↑ focus    ↑ destructive color  │
└─────────────────────────────────────────┘
```

| Element | Rule |
|---------|------|
| Title | `{Verb} {entity type} "{exact name}"?` — never "Are you sure?" |
| Body | 1–3 sentences: what is removed, scope/ count, reversibility |
| Cancel | Secondary/neutral styling; **receives focus on open** |
| Confirm | `{Verb} {entity type}` in destructive color (e.g. crimson `#DC2626` light, `#F87171` dark) |
| Backdrop | Dimmed; click outside = Cancel (same as Escape) |

## Copy templates

| Action | Title example | Confirm button |
|--------|---------------|----------------|
| Delete | Delete project "Homepage Redesign"? | Delete project |
| Remove member | Remove Sarah Chen from workspace? | Remove member |
| Revoke token | Revoke API key "Production"? | Revoke key |
| Reset | Reset all filters to defaults? | Reset filters |
| Disconnect | Disconnect GitHub account? | Disconnect |

Type the entity name exactly as shown in the UI (matching case and punctuation).

## Focus trapping

On open:

1. Save `document.activeElement` as `previousFocus`.
2. Move focus to Cancel button (not Confirm).
3. Trap Tab/Shift+Tab within dialog focusables only.
4. Block interaction with content behind (`aria-modal="true"`, inert backdrop or `pointer-events` on scrim).

On close (Cancel, Escape, or after successful Confirm):

1. Release focus trap.
2. Return focus to `previousFocus` if still in DOM; else first focusable in main content.
3. Announce result to screen readers via `aria-live="polite"` region if action completed.

```javascript
const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

function trapFocus(container, event) {
  const nodes = [...container.querySelectorAll(FOCUSABLE)];
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.key === 'Tab') {
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
```

## Keyboard behavior

| Key | Behavior |
|-----|----------|
| Escape | Close dialog; no destructive action |
| Enter | Activates **focused** button — therefore Cancel must be focused on open |
| Tab / Shift+Tab | Cycle within dialog only |

Optional: require typing entity name for high-severity deletes (e.g. production database). Add a text field; Confirm stays disabled until exact match — still keep Cancel as initial focus target before user tabs to the field.

## High-severity tier (optional extension)

When data loss is catastrophic (account deletion, production purge):

- Add confirmation input: `Type "Analytics" to confirm`
- Confirm button disabled until input matches entity name exactly
- Still use destructive verb on button; still no generic "OK"

## Anti-patterns

| ❌ Avoid | ✅ Use instead |
|----------|----------------|
| "Are you sure?" | "Delete file 'report.pdf'?" |
| OK / Yes | Delete file |
| Confirm focused on open | Cancel focused on open |
| Toast-only undo for delete | Dialog first; optional undo toast after for soft deletes only |
| Destructive action on backdrop click | Backdrop click = Cancel |

## Accessibility checklist

- [ ] `role="alertdialog"` or `role="dialog"` with `aria-labelledby` (title) and `aria-describedby` (body)
- [ ] Focus trapped; Escape dismisses
- [ ] Cancel receives initial focus
- [ ] Confirm button includes destructive state in accessible name (not color alone)
- [ ] Focus restored to trigger on close
