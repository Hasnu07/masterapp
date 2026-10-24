# Choose a page pattern

Walk these questions in order. Stop at the first match. State the name in chat, then open [catalog.md](catalog.md) for that pattern only.

Do not write page markup until a name is stated.

## 0. Is this even a page?

| If the work is… | Do this |
| --- | --- |
| One field (rename, title) | Stop. `surfaces` → inline edit. |
| A short form that should keep the current page in view | Stop. `surfaces` → slide-over. |
| Sidebar, header, footer, or a menu | Chrome. Not a page pattern. On narrow, collapse per `viewports`. |
| A chart, KPI tile, dialog, uploader, or empty block | A component. It sits inside a page. |
| A signed-in or public **route** with its own URL | Continue. |

## 1. Is this a public marketing route?

Public site, no app sidebar, narrative or conversion job (home, about, pricing, contact, blog, portfolio).

→ Name the **route type** and compose sections from [marketing.md](marketing.md). Do not call this Pattern 4 or invent Pattern 11.

Auth screens (login, register, forgot, reset, verify, 2FA) are **not** marketing. They are **Pattern 3 — Form (auth)**.

## 2. What is the user’s one job?

Answer with the job, not the feature name.

| User’s job | Pattern |
| --- | --- |
| Scan, search, filter, or batch-manage many records | **1 — List / Index** |
| Inspect one named record, with sections | **2 — Detail / Record** |
| Create or edit data (including auth and wizards) | **3 — Form** |
| Glance at status. No date-range, no drill, no live ops console | **4 — Dashboard / Overview** |
| Change how the product behaves (prefs, members, billing, flags) | **5 — Settings / Configuration** |
| Move items through an ordered set of stages | **6 — Kanban / Board** |
| Time is the organiser (events, shifts, bookings) | **7 — Calendar** |
| Jump between many items and their detail without changing route | **8 — Split Pane** |
| Explore numbers: date range, filters, drill, export, or run a report | **9 — Analytics / Reporting** |
| Work a time-ordered attention queue, or show a record’s activity log | **10 — Inbox / Activity Feed** |

## 3. Resolve close calls

**List vs Board vs Calendar of the same records**  
One page. Default pattern is the primary job. Other views are a toolbar toggle, not extra routes.

**List + Detail vs Split Pane**  
Split Pane only when people flip through items constantly (inbox, approvals, mail). Otherwise List → navigate → Detail.

**Dashboard vs Analytics**  
Dashboard = fixed glance, max five metrics, links out.  
Analytics = the user changes range/filters and expects every chart to update.

**Settings vs Detail**  
Settings = the product or workspace. Detail = one domain record (a project, a person).

**Form vs Settings**  
A one-shot create/edit of a record is Form. Ongoing configuration with a section nav is Settings.

**Dashboard vs List**  
If the main task is the table, it is a List. Do not put a KPI strip on every list.

**Inbox vs List**  
Inbox rows have no column headers or sort controls. List is a queryable table.

## 4. Form subtype (only after Pattern 3)

Follow `surfaces` for duration. Then pick one subtype:

| Context | Subtype |
| --- | --- |
| Login, register, forgot, reset, verify, 2FA | **Form (auth)** — centered card, no app chrome |
| First-run setup, checkout, or stepped onboarding | **Form (wizard)** |
| Create/edit that earned a full route | **Form (page)** — narrow column, not full bleed |
| Create/edit that stayed on the current screen | Not this skill — slide-over via `surfaces` |

## 5. Still no match?

Stop and ask. Do not build an infinite canvas, node graph, AI chat page, or command-palette home unless the user explicitly accepts that it is outside this catalog.
