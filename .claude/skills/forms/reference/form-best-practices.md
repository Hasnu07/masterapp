# Form Best Practices — Field Reduction, Keyboard, Autocomplete

Companion to `forms`. Framework-agnostic patterns for high-completion forms.

## Field reduction matrix

| Instead of | Use | Inference source |
|------------|-----|------------------|
| First name + Last name | Full name (single field) | Split only if legal/compliance requires |
| City + State + ZIP | ZIP + read-only city/state | Postal API or locale lookup on blur |
| Country + Phone | Phone with country picker | Default country from locale/timezone |
| Card number + Brand | Card number only | BIN lookup for brand icon |
| Start date + End date (same day) | Single date range picker | One control, two values |
| Confirm email / Confirm password | Single field + show toggle | Duplicate fields increase abandonment |

Remove "optional" fields that can be collected later in progressive profiling.

## Validation lifecycle (detailed)

```
┌──────────┐  first blur   ┌─────────┐
│ pristine │──────────────►│ touched │
└──────────┘               └────┬────┘
                                │
                    valid ◄─────┼─────► invalid
                                │
              focus / keystroke clears invalid UI
                                │
                         re-validate on input (if touched)
```

| Event | Pristine | Touched invalid | Touched valid |
|-------|----------|---------------|---------------|
| input | no validate | clear error + validate | validate |
| blur | validate → touched | validate | validate |
| submit | touch all + validate | scroll to first fail | submit |

## Keyboard submit

| Key | Context | Action |
|-----|---------|--------|
| Enter | Single-line input | Submit form (if one logical submit) |
| Enter | Textarea | New line; Cmd/Ctrl+Enter submits if documented |
| Enter | Multi-field form | Submit from any field unless Shift held |
| Escape | Inline field edit | Cancel edit, restore previous value |

Use implicit submit (`<form>` + `<button type="submit">`) — do not rely on click handlers alone.

## Autocomplete attributes

Apply HTML `autocomplete` for faster, accurate fill:

| Field | autocomplete value |
|-------|---------------------|
| Full name | `name` |
| Email | `email` |
| Current password | `current-password` |
| New password | `new-password` |
| Street address | `street-address` |
| Postal code | `postal-code` |
| Credit card | `cc-number` |
| OTP / one-time code | `one-time-code` |
| Organization | `organization` |

Pair with appropriate `type`, `inputmode`, and `name` attributes for mobile keyboards.

## Input masking

- **Phone:** `inputmode="tel"`, accept typed formatting, normalize on blur — do not fight cursor during input.
- **Currency:** Store numeric value; display formatted on blur; allow bare digits while focused.
- **Date:** Prefer native `type="date"` or accessible date picker; placeholder shows format hint (`YYYY-MM-DD`), not label.
- **Credit card:** Group in one field or seamless 4-box only if auto-advance preserves backspace behavior.

Masking must not block paste.

## Auto-advance (OTP, segmented codes)

- Auto-focus next cell on digit entry.
- Backspace on empty cell moves to previous cell and clears it.
- Paste full code distributes across cells.
- Single hidden input + visual cells is acceptable for a11y if labels are wired correctly.

## Submit-on-click when incomplete

When user clicks submit with errors:

1. Run validation on all fields (mark untouched as touched).
2. Focus first invalid field (`focus({ preventScroll: false })` then `scrollIntoView({ block: 'nearest' })`).
3. Announce error count in a page-level `role="alert"` if 3+ errors: "3 fields need attention."
4. Do not disable the button during this flow.

## Server-side errors

Map server field errors to the same inline slots as client validation. Preserve all user input. Focus first server-error field after render.

## Labels and placeholders

- Every input has a visible `<label>` or `aria-label` when icon-only.
- Placeholder = format hint only (`name@company.com`), never the label.
- See `labels` skill for full copy rules.
