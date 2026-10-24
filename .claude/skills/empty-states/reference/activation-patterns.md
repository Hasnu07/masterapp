# Activation Patterns

Templates for first-use empty states vs filtered-out zero results.

## First-use empty (nothing created yet)

User has access but has not added content. Goal: activation — first create or import.

### Structure

```
[Headline — what belongs here]
[One sentence — value of populating]
[Primary CTA — create or import]
[Optional secondary — docs, sample data]
```

### Examples

| Context | Headline | Body | Primary CTA |
|---|---|---|---|
| Projects | No projects yet | Create a project to organize tasks and track progress. | Create project |
| Team | No teammates yet | Invite people to collaborate on this workspace. | Invite teammate |
| Reports | No reports yet | Build a report to track metrics over time. | Create report |
| Imports | No contacts yet | Import a CSV or add contacts one at a time. | Import contacts |

Optional secondary: `Download sample CSV` · `See example project`

### Do not

- Show only "No data" or an empty table with no message
- Use Get started as the only button without a specific verb
- Block with cartoon illustrations from the banned list

## Filtered-out empty (content exists but hidden)

User applied search or filters that exclude all visible items. Goal: escape hatch + optional create.

### Structure

```
[Headline — no matches]
[One sentence — suggest broader search or reset]
[Clear all filters — required]
[Optional primary create if still relevant]
```

### Examples

| Context | Headline | Body | Actions |
|---|---|---|---|
| Search | No projects match "analytics" | Try different keywords or reset filters. | Clear all filters |
| Filters | No results with current filters | Widen date range or remove status filters. | Clear all filters |
| Search + filters | No projects match your filters | Try broader terms or reset filters. | Clear all filters · Create project |

**Clear all filters** must reset all active filter/search state in one click — not per-filter dismissal only.

## Permission / access empty (different skill territory)

When user cannot create due to role:

```
[Headline — nothing to show]
[One sentence — why, without blame]
[Contact admin or request access — if applicable]
```

Not a substitute for first-use; do not show Create if user lacks permission.

## Layout footprint

Empty state occupies the same region as populated content:

| Container | Empty placement |
|---|---|
| Table | Centered in tbody area or overlay row; preserve column headers |
| Card grid | Same grid cell area; min-height matches card row |
| Full page | Content column only; keep nav/chrome |

Avoid shrinking the content area to a tiny centered box.

## Copy checklist

- [ ] Headline names the missing content type
- [ ] Body explains value in one sentence
- [ ] Primary CTA is verb-first (create/import/invite)
- [ ] Filtered variant includes Clear all filters
- [ ] No dead-end without action
- [ ] Visual treatment respects `.ux-profile.md` bans

## Quick reference

| Signal | Pattern |
|---|---|
| `count === 0 && !hasFilters` | First-use empty |
| `count === 0 && hasFilters` | Filtered empty + clear |
| `count > 0` | Normal populated view |
