# Keybinding Matrix — Universal Navigation Conventions

Standard bindings for web apps. Respect OS/browser reserved shortcuts; never steal Ctrl/Cmd+W, Ctrl/Cmd+T, or browser find without explicit user opt-in.

## Global shortcuts

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Page | Move focus forward |
| `Shift+Tab` | Page | Move focus backward |
| `Enter` | Button, link | Activate |
| `Space` | Button, checkbox, toggle | Activate / toggle |
| `Escape` | Modal, popover, dropdown, inline edit | Close / cancel; restore prior state |
| `/` | App (not in text input) | Focus primary search or command input |
| `Mod+K` | App | Open command palette (Mac: ⌘K, Win/Linux: Ctrl+K) |
| `?` | App (Shift+/ ) | Open keyboard shortcuts help |
| `Mod+Enter` | Form, composer | Submit / send when Enter would newline |

`Mod` = `metaKey` on Mac, `ctrlKey` elsewhere.

## Command palette (Mod+K)

- Opens centered or top-anchored searchable list.
- Typing filters actions and navigation targets.
- ArrowUp/ArrowDown move selection; Enter executes; Escape closes and restores focus.
- Trap focus while open; same rules as modal focus trap.

## Search focus (Slash)

- Only when focus is not inside `input`, `textarea`, or `contenteditable`.
- `preventDefault` on `/` and move focus to search field.
- Show subtle hint in search placeholder: "Search… (/)".

## Dropdowns and menus

| Key | Action |
|-----|--------|
| `Enter` / `Space` on trigger | Open menu |
| `ArrowDown` | Open menu + focus first item (or next item) |
| `ArrowUp` | Focus previous item |
| `Home` / `End` | First / last item |
| `Enter` | Select focused item |
| `Escape` | Close menu; focus trigger |
| Typeahead | Focus first item matching letter |

Use `role="menu"` + `menuitem` or `listbox` + `option` consistently.

## Dialogs and slide-overs

| Key | Action |
|-----|--------|
| `Escape` | Close (Cancel semantics unless dirty-state confirm) |
| `Tab` / `Shift+Tab` | Cycle focusable elements inside only |
| `Enter` | Activate focused control (Cancel if focused on open — see destructive-actions) |

## Data grids and lists

| Key | Context | Action |
|-----|---------|--------|
| `ArrowUp/Down` | Row focus | Move between rows |
| `ArrowLeft/Right` | Cell focus | Move between cells (editable grids) |
| `Enter` | Row | Open detail / primary action |
| `Space` | Row with selection | Toggle row selection |
| `Mod+A` | List with selection | Select all (when not in text field) |
| `Home` / `End` | List | First / last item |

Implement roving tabindex: one row/cell at `tabindex="0"`, others `-1`.

## Tabs

| Key | Action |
|-----|--------|
| `ArrowLeft/Right` | Previous / next tab (horizontal) |
| `ArrowUp/Down` | Previous / next tab (vertical) |
| `Home` / `End` | First / last tab |
| `Enter` / `Space` | Activate tab (if not auto-activating) |

Selected tab: `tabindex="0"`, `aria-selected="true"`.

## Inline edit

| Key | Action |
|-----|--------|
| `Enter` | Commit change |
| `Escape` | Cancel; revert value |
| `Tab` | Commit and move to next field (optional; document if used) |

## Tooltip and shortcut display

Show shortcuts in tooltips as platform-aware text: `⌘K` on Mac, `Ctrl+K` on others. Detect via `navigator.platform` or `userAgentData` at runtime.

For **icon buttons**, the tooltip is mandatory (not `title`). Prefer the project’s **Kbd** component inside the tooltip; if none exists, append the platform-aware shortcut as label text. Full contract: `icon-buttons` skill and its [icon-button-contract](../../icon-buttons/reference/icon-button-contract.md).

## Testing checklist

- [ ] Full task completable without mouse
- [ ] Focus always visible during keyboard navigation
- [ ] No keyboard trap outside intentional modal trap
- [ ] Slash and Mod+K do not fire while typing in inputs
- [ ] Escape behavior consistent across overlays
