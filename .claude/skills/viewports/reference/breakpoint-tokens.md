# Viewport tokens

Three named widths. Do not add a fourth for one screen.

| Token | CSS variable | Width | Job |
| --- | --- | --- | --- |
| narrow | `--vp-narrow` | 375px | Phone. Chrome is a menu. Patterns use their catalog **Narrow** line. |
| medium | `--vp-medium` | 768px | Optional stack point (two-column → one). Not a third design. |
| wide | `--vp-wide` | 1280px | Desktop prove. Width-cap and center **main page content only** — never the app shell or chrome. |

## Queries

```css
/* narrow */
@media (max-width: 767.98px) { }

/* medium and up */
@media (min-width: 768px) { }

/* wide prove — resize the window; do not require a matching min-width query */
```

Use `max-width: 767.98px` for “is this narrow?” so 768px lands in medium.

## Measure overflow

At 375px and at 1280px:

```
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

A table, board, or compare-grid may set `overflow-x: auto` on **one** inner region. `overflow-x: auto` on `html` or `body` is a fail.

## Hit targets

| Profile | Minimum |
| --- | --- |
| WCAG 2.1 AA (default) | 44×44px |
| WCAG 2.1 AAA | 48×48px |
| Profile missing | 44×44px |

Read **Touch / focus** in `.ux-profile.md`. Padding on the control counts; the glyph does not have to be 44px.

## Chrome

| Width | Sidebar / app rail |
| --- | --- |
| narrow | Hidden. Same links in a menu button (or equivalent). |
| medium / wide | Persistent rail allowed. Full viewport width — do not sit chrome inside `--vp-wide`. |

Auth and marketing routes have no app sidebar at any width.

## Where `--vp-wide` goes

| Element | Max-width |
| --- | --- |
| `html`, `body`, `.app`, `.shell`, sidebar, header | None. `width: 100%`. |
| `main`, `.page` (the named page-pattern body) | `var(--vp-wide)`, then center. |
| A card, table, or KPI strip | No. Cap the page, not every widget. |

## Not this skill

| Concern | Owner |
| --- | --- |
| List table → inner scroll, board snap-scroll, settings nav → select | `page-patterns` catalog **Narrow** line |
| Drawer becomes full-height | `surfaces` |
| Type floor 12px, line length 65–75ch | `typography`, `spacing` |
| Notch / safe-area / native apps | Out of scope |
