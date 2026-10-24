# Product page catalog

Build only the pattern you named. Width-cap and center **main page content** on every pattern — not the app shell or sidebar. Heading, short description (or status + metadata on Detail), then body.

Actions live in the page header — not in the tab row.

**Tabs:** 1–5 sections → one horizontal tab row under the header. 6+ sections → a narrow sticky section nav beside the content. Never wrap or overflow tab labels.

**Narrow** lines below are required once `viewports` says the viewport is narrow. Do not invent extra breakpoints per pattern.

---

## 1 — List / Index

**Use when:** people search, filter, sort, or batch-act on many records.

```
Heading                    [Secondary]  [+ Create]  [⋯]
One sentence describing this list
────────────────────────────────────────────────────
[Search ………………]  [Filters]  [Columns]  [Export]
Status: Active ×   Location: Sydney ×   Clear all
Data table (sticky header, default sort on)
Pagination (always, even on one page)
```

**Must**

- Search is always present. `/` focuses it. Search is recognizable at a glance: visible Search label **or** a search icon + visible name. `aria-label` alone is allowed only on the catalog **Narrow** line (375). At 1280 (medium/wide), aria-label-only is a fail.
- One Filters control. All dimensions live in that panel. Active values appear as chips under the toolbar. Never a stack of filter dropdowns in the toolbar.
- Create stays in the header, not the toolbar.
- Export sits in the toolbar, not the header. Export and view toggles (board/list) may be square icon buttons; follow `icon-buttons` (tooltip + shortcut kbd).
- The table/list sits in a visible **frame** (L1 surface + hairlines). Empty states stay *inside* that frame.
- Pagination always renders. Disabled pagination buttons keep readable labels (no empty outline circles).
- Default sort is on when the table first appears.
- Row click → Detail. Clickable rows have a resting affordance (link-colored primary cell, chevron, or a row hit target that reads as a row). `cursor-pointer` alone is not enough. First-use empty uses `empty-states` inside the table frame.

**Must not**

- Sidebar filter rails
- KPI tiles above a list “to make it feel like a dashboard”
- Card grids as the default index (use a table unless the domain is visual-first media)
- A filter with no matching visible column
- Spreadsheet text on blank L0 canvas with no table frame
- Search that is only an empty bar + `aria-label` (or kbd hint) on a wide page

**Narrow:** Toolbar wraps. Table may scroll inside its region (sticky first column optional). Never shrink cells below 12px. On Narrow / 375 only, Search may use `aria-label` without a visible label.

---

## 2 — Detail / Record

**Use when:** the job is one named record.

```
Record name                [Secondary]  [Primary]  [⋯]
List › Record
Status badge · key metadata
────────────────────────────────────────────────────
Details | Documents | Activity | Notes
Tab body (owns its own loading / empty / error)
```

**Must**

- Status + metadata stand in for a description sentence.
- Each tab loads on its own.
- Edits use `surfaces` (usually a slide-over). Destructive actions use named confirm.

**Must not**

- One long scrolling dump of every field
- Cards wrapping each tab section
- Horizontal tabs once there are 6+ sections

**Narrow:** Tab labels do not wrap. Use a scroll-snap row or a select if they would overflow. Metadata stacks.

---

## 3 — Form

**Use when:** the job is entering or editing data, including auth.

| Context | Layout |
| --- | --- |
| Auth | Centered card. Logo, title, fields, one primary action, escape link. No app sidebar. |
| Wizard | Step list + per-step validation. Sticky Cancel / Next. |
| Page | Narrow column (~640px). Labels above fields. Sticky Cancel / Save. |

**Must**

- Follow `forms` (blur-first validation, submit always clickable).
- Required marked; optional labelled `(optional)`.
- Warn on dirty navigate.
- Auth: one task per screen; “Back to login” (or equivalent) on every sub-flow.

**Must not**

- Full-bleed forms on wide screens
- Cards around every field group
- App chrome on auth
- A full page when `surfaces` required a slide-over

**Narrow:** Column is 100% of the content area. Sticky Cancel / Save stay on screen.

---

## 4 — Dashboard / Overview

**Use when:** people need a fixed glance, then leave to a module.

```
Heading
One sentence
────────────────────────────────────────────────────
KPI strip (max 5)
Primary chart
Supporting list (recent activity, upcoming)
```

**Must**

- Read-only. Actions link out; they do not edit here.
- At most five metric tiles.

**Must not**

- Date-range filters, drill-down, or a live ops console (that is Pattern 9)
- Six or more tiles
- Editable records on the dashboard

**Narrow:** KPI strip stacks to one or two columns. Chart is full width of the content area.

---

## 5 — Settings / Configuration

**Use when:** people change how the product works.

```
Settings
────────────────────────────────────────────────────
Section nav (sticky) | Section heading
                     | One sentence
                     | Label   [control]
                     | Help text
                     | [Save changes]
```

**Must**

- Instant switches save themselves. Grouped fields use Save.
- Danger zone last, separated, destructive styling.
- Settings nav is not the same thing as Detail’s 6+ section nav.

**Must not**

- Tabs as the only category switch
- One card per individual setting
- Record-editing fields that belong on Detail

**Narrow:** Section nav becomes a top select or a stacked list — not a side rail beside the fields.

---

## 6 — Kanban / Board

**Use when:** the job is moving items through named stages.

```
Heading                    [+ Create]  [⋯]
One sentence
────────────────────────────────────────────────────
[Search ………………]  [Filters]           [List | Board]
Stage (n)     Stage (n)     Stage (n)
[Card]        [Card]        [Card]
+ Add         + Add         + Add
```

**Must**

- Columns stay visible when filters hide cards.
- Each column shows a live count.
- Empty column still shows + Add.
- Keyboard path to change stage (⋯ → Move to…). Drag cannot be the only way.
- Card click → slide-over or Detail.

**Must not**

- Hide stages to “clean up” a filter
- Use a table when stage progression is the main job
- A board for data with no real lifecycle

**Narrow:** Columns snap-scroll horizontally. Stages stay visible. Do not hide columns to fit.

---

## 7 — Calendar

**Use when:** date and time organise the work.

```
Heading                    [+ Create]
One sentence
────────────────────────────────────────────────────
[<]  Month Year  [>]  [Today]        [Month | Week | Day]
[Search ………………]  [Filters]
Mon Tue Wed Thu Fri Sat Sun
date cells with event bars
```

**Must**

- Grid always renders. Empty period: message **on** the grid, not instead of it.
- Today jumps to the current period.
- Empty cell → create with that date filled. Event → preview, then Detail if needed.

**Must not**

- Replace the grid with a blank empty-state page
- Mix unrelated record types without a clear label or colour key

**Narrow:** Month grid stays. Cells may shrink; type stays ≥12px. Do not replace the grid with a list unless the user toggled a view.

---

## 8 — Split Pane

**Use when:** people triage many items and need detail without a route change.

```
Heading                    [Primary]  [⋯]
One sentence
────────────────────────────────────────────────────
[Search ………………]  [Filters]
┌──────── left (fixed) ───┐ ┌──── right (flex) ────┐
│ selected row            │ │ record detail        │
│ row                     │ │ (Pattern 2, compact) │
│ row                     │ │ Open full page →     │
└─────────────────────────┘ └──────────────────────┘
```

**Must**

- Left panel is a compact list (avatar, title, meta, time). No table headers or sort.
- Selection updates the right panel only.
- Arrow keys move selection; Enter moves focus right.
- Narrow viewports: list full width, tap opens a full Detail page.

**Must not**

- Navigate away on select
- Put a DataTable in the left pane
- Use this when each item needs a full tabbed Detail as the normal path

**Narrow:** List is full width. Tap opens a full Detail page (not a squeezed dual pane).

---

## 9 — Analytics / Reporting

**Use when:** people change range or filters and read the result. Pick **one** subtype.

| Subtype | People do |
| --- | --- |
| Analytical | Change range, drill, export |
| Operational | Watch live counts; act on alerts |
| Report runner | Set parameters → run → download |

```
Heading                    [Export]  [⋯]     ← Export in the header here only
One sentence
────────────────────────────────────────────────────
[Date range]  [Filters]
KPI strip (max 5)
Primary chart
Secondary charts
Detail table
```

**Must**

- Date range is first and always visible (Analytical / Operational).
- One filter change updates every chart.
- Charts load on their own (skeletons, not a page spinner).
- Drill adds a chip and scrolls to the table.
- Report runner keeps parameters and results on the same page.

**Must not**

- Use this for a no-filter overview (that is Pattern 4)
- Inline-edit numbers on the report
- Put Export in the header on any other pattern

**Narrow:** Filters stack. Charts are full width. Detail table scrolls inside its region.

---

## 10 — Inbox / Activity Feed

**Use when:** the stream is time-ordered attention or history. Pick **one** variant.

**A — Standalone inbox** (approvals, messages)

```
Heading                    [Mark all read]  [⋯]
One sentence
[All] [Pending] [Completed]
☐  Avatar  Title          [Approve] [Decline]   2 hours ago
```

- Unread uses weight **and** a leading accent — not colour alone.
- Rows are not a table (no headers, no sort).
- Pagination on queues that need a stable order. No infinite scroll on approvals.

**B — Activity on a Detail tab**

```
[Add note]
Jane updated Status: Draft → Issued    2 hours ago
Record created                         12 Mar 2026
Load more
```

- Newest first. “Load more”, not pagination.
- Plain language, not API traces.

**Must not**

- DataTable chrome on a feed
- Mix A and B in one component

**Narrow:** Approve / Decline stay visible or live in the row ⋯. Do not hide them behind hover.

---

## Map leftover names

| They asked for… | You build… |
| --- | --- |
| Data table, record index | 1 List |
| Record with tabs | 2 Detail |
| Drawer / wizard / auth card | 3 Form |
| KPI home, no drill | 4 Dashboard |
| App configuration | 5 Settings |
| Pipeline, stages | 6 Board |
| Schedule, bookings | 7 Calendar |
| Mail, chat, master-detail | 8 Split Pane |
| Report, live ops, export | 9 Analytics |
| Approvals, notifications, audit | 10 Inbox |
| List + Board + Calendar of one set | View mode on one page |
| Canvas, graph, AI sidebar, tour as layout | Stop and ask |
