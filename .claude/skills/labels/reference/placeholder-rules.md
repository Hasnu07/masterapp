# Placeholder Rules

Accessible label bindings and where to put format hints.

## Label binding patterns

### Explicit label (preferred)

```html
<label for="company">Company name</label>
<input id="company" name="company" type="text" />
```

### Group label (radios/checkboxes)

```html
<fieldset>
  <legend>Notification frequency</legend>
  <label><input type="radio" name="freq" value="daily" /> Daily</label>
  <label><input type="radio" name="freq" value="weekly" /> Weekly</label>
</fieldset>
```

### Visible label + `aria-labelledby`

Use when visual label is not a `<label>` element but text is visible:

```html
<span id="search-label">Search</span>
<input type="search" aria-labelledby="search-label" />
```

### When `aria-label` is acceptable

Icon-only controls (no visible text) or spatially compact toolbars — still not placeholder-based:

```html
<button type="button" aria-label="Close dialog">×</button>
<input type="search" aria-label="Search projects" placeholder="Project name" />
```

Search still needs an accessible name; placeholder alone is insufficient.

Icon-only **buttons** also need a real tooltip (hover + focus) per the `icon-buttons` skill — `aria-label` alone is not enough, and `title` is not a tooltip.

## Placeholder: allowed vs forbidden

| Allowed (format example) | Forbidden (label substitute) |
|---|---|
| `acme-corp` | Company name |
| `MM/YY` | Expiry date |
| `name@domain.com` | Email address |
| `+1 (555) 000-0000` | Phone number |
| `sk- live_…` | API key |

Rule: if the placeholder text could serve as the field name when read aloud, it belongs in the label instead.

## Helper text placement

```
[Label]
[Input with optional format placeholder]
[Helper text — constraints, privacy, examples]
[Inline error — on failure only]
```

Example:

```
Password
[••••••••]
At least 8 characters with one number.
```

Helper text persists; placeholders vanish on input.

## Floating labels

Permitted only if:
1. Label text remains visible after focus (animates to shrink above field, not replaced by placeholder).
2. Programmatic name matches visible label text.
3. Placeholder, if any, is format-only and secondary.

## Accessibility checklist

- [ ] Visible label for every input, select, textarea
- [ ] `for`/`id` pair or valid `aria-labelledby` / `aria-label`
- [ ] Placeholder is format example only
- [ ] Helper text linked via `aria-describedby` when it adds requirements
- [ ] Error messages linked via `aria-describedby` or `aria-errormessage`
- [ ] Placeholder contrast meets profile a11y target (prefer helper text if not)

## Common fixes

| Problem | Fix |
|---|---|
| Placeholder "Email" only | Add label Email; placeholder `you@company.com` |
| Label inside input on focus loss | Switch to persistent top label pattern |
| Instructions in placeholder | Move to helper text below field |
| No label on search | Add visible Search or `aria-label="Search projects"` |
