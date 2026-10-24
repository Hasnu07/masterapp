# Error Taxonomy

Where to show errors and what each template must include. Every template: **what happened · why it matters · recovery step** in <2 sentences.

## Surface matrix

| Surface | When to use | Visibility | Recovery |
|---|---|---|---|
| Inline (field) | Validation, fixable input | Adjacent to control, `aria-describedby` | Correct input; error clears on focus/edit |
| Toast | Transient, non-blocking | Auto-dismiss or manual dismiss | Retry action or dismiss |
| Banner | Blocks section, not whole app | Top of panel or page region | Primary recovery + optional secondary |
| Full-page | Entire view unusable | Centered in content area | Retry, go back, or contact support |

## Inline field template

```
[Format or constraint hint — no blame]
```

Examples:
- Enter an email address like name@domain.com
- Use at least 8 characters
- Enter a date in MM/DD/YYYY format

Avoid: Invalid input · You must enter · Wrong password

## Toast template

```
[What happened]. [Recovery step or action button].
```

Examples:
- We couldn't save your changes. Check your connection and try again.
- Link copied. Paste it where you need it.

Duration: 4–8 seconds for success; persist until dismissed for errors with actions.

## Banner template

```
[Headline: what happened]
[One sentence: impact + recovery]
[Primary action] [Secondary action optional]
```

Example:
- **Couldn't load projects**
  Your lists are out of date. Check your connection and refresh.
  [Try again] [Work offline]

## Full-page template

```
[Headline — plain language]
[Impact sentence]
[Primary CTA] [Copy error details if technical]
```

Example:
- **Something went wrong**
  We couldn't load this page. Your data is safe.
  [Try again] [Copy error details]

Never show stack traces in the body. Copy action includes ref ID, timestamp, route, sanitized code.

## Technical vs user-recoverable

| Type | User sees | Hidden (copy payload) |
|---|---|---|
| Validation | Format hint only | — |
| Network | Connection message + Try again | `NETWORK_ERROR`, ref |
| Auth expired | Session expired + Sign in again | `401`, ref |
| Server 5xx | Something went wrong + Try again | `500`, ref, request id |
| Unknown | Something went wrong + Copy details | full diagnostic blob |

## Voice adjustments (from `.ux-profile.md`)

| Voice | Tone tweak |
|---|---|
| Utilitarian & Minimal | Shortest possible; no filler |
| Warm & Humancentric | "We couldn't…" acceptable; brief empathy OK |
| Opinionated & Direct | Plain facts; still no blame |

Blameless rule applies to all voices.

## Anti-patterns

- You entered / You failed / Your session is invalid
- Error 404 / SQLSTATE / stack frames in UI
- Submit failed with no next step
- Modal that only says OK with no recovery path
