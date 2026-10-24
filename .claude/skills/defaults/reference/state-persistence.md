# State Persistence — Draft Auto-Save and Cache Invalidation

Companion to `defaults`. Defines when and how to persist form drafts and preference defaults locally.

## Draft auto-save heuristics

| Form type | Persist? | Debounce | Storage |
|-----------|----------|----------|---------|
| Login / payment / OTP | **No** | — | — |
| Short settings (1–2 fields) | On blur per field | — | localStorage |
| Compose / editor / long form | **Yes** | 500–2000 ms after input | localStorage or IndexedDB |
| Multi-step wizard | **Yes** | Each step change + debounced input | sessionStorage + localStorage backup |
| Inline comment / reply | **Yes** | 300 ms | sessionStorage |

Serialize as JSON: `{ data: { fieldName: value }, updatedAt: ISO8601, schemaVersion: 1 }`.

## Storage key convention

```
draft:{formId}:{scope}:{userId?}

Examples:
  draft:project-create:workspace-abc:user-123
  draft:issue-comment:issue-456:anon
  pref:timezone:user-123
  pref:last-export-format:workspace-abc
```

- `formId`: stable identifier for the form surface.
- `scope`: workspace, route, or entity id to avoid collisions.
- Include `schemaVersion`; bump when field names change and discard incompatible drafts.

## Restore UX

On mount when draft exists and is newer than empty form:

1. Hydrate field values from draft.
2. Show non-blocking banner: "Draft restored · Last edited {relative time} · [Discard draft]"
3. Focus first empty required field, not first field overall (avoid jarring selection jumps).

If server returns newer saved data (edit conflict):

- Show choice: "Keep your draft" vs "Use server version" — never silently overwrite without notice.

## Default inference sources

| Field | Primary source | Fallback |
|-------|----------------|----------|
| Timezone | `Intl.DateTimeFormat().resolvedOptions().timeZone` | UTC |
| Locale / language | `navigator.language` | en-US |
| Country/region | Locale region subtag or geo API (with consent) | None — require explicit pick |
| Date format | Locale convention | ISO 8601 |
| Currency | Locale + domain context | USD / org default |
| Theme | `prefers-color-scheme` + saved override | system |
| Last workspace/project | localStorage `pref:last-{entity}` | first in list |

## Preference memory (non-draft)

After explicit user change, persist for next visit:

```javascript
localStorage.setItem('pref:timezone', selectedTimezone);
localStorage.setItem('pref:timezone:updatedAt', Date.now());
```

On next form open, preference beats locale heuristic.

## Cache invalidation

| Event | Action |
|-------|--------|
| Successful form submit | Delete matching draft key |
| User clicks Discard draft | Delete draft key |
| Schema version mismatch | Delete draft; log once in dev |
| Draft older than TTL (default 30 days) | Delete on read |
| User logout | Delete user-scoped drafts and prefs (or anon-only keys) |
| Entity deleted (e.g. issue closed) | Delete entity-scoped comment drafts |

Optional TTL check:

```javascript
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
if (Date.now() - draft.updatedAt > MAX_AGE_MS) {
  localStorage.removeItem(key);
  return null;
}
```

## Sensitive data — never persist

- Passwords, API secrets, tokens
- Full credit card numbers, CVV
- Government ID numbers
- Health or regulated PII unless explicitly required and encrypted

For sensitive flows, warn on `beforeunload` only if dirty — do not write values to disk.

## IndexedDB vs localStorage

| Use localStorage | Use IndexedDB |
|------------------|---------------|
| < 100 KB drafts | Rich text / attachments |
| Simple key-value | Binary blobs |
| Sync read on mount | Large offline editor state |

## Sync with route changes

- SPA route change: draft persists in storage; remount restores.
- Full page navigation away: draft persists if auto-save ran.
- Tab close: `beforeunload` not required if debounced save keeps pace; optional final sync on `visibilitychange` → `hidden`.

```javascript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDraftSync();
});
```

## Testing checklist

- [ ] Fill form, refresh — data restored
- [ ] Fill form, navigate away and back — data restored
- [ ] Submit successfully — draft cleared
- [ ] Discard — draft cleared
- [ ] Dropdowns show inferred default on first visit
- [ ] Changed preference persists on second visit
- [ ] Sensitive forms do not appear in localStorage
