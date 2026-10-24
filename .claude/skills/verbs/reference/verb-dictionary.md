# Verb Dictionary

Pairing table for action labels. Default pattern: **Verb + object** in sentence case.

## Core verb pairings

| User intent | Preferred label | Avoid | Notes |
|---|---|---|---|
| Persist edits to existing record | Save changes | Submit, OK | Use Save draft if not yet published |
| Create new record | Create project, Add member | Submit, New | Name the entity type |
| First-time publish | Publish report | Submit, Go live | Publish implies visibility change |
| Send to server without naming entity | Send message | Submit | Still verb-first; name object when known |
| Remove permanently | Delete workspace | Remove (if ambiguous) | Always name the entity |
| Soft remove / undoable | Remove from list | Delete | Reserve Delete for irreversible |
| Export data | Export CSV, Download PDF | Get, Fetch | Format or destination in object |
| Import data | Import contacts, Upload file | Add file | Verb matches mental model |
| Connect integration | Connect repository | Link, Set up | Link alone is vague |
| Disconnect | Disconnect Slack | Unlink | Mirror connect vocabulary |
| Confirm destructive | Delete workspace | OK, Yes | Button repeats the destructive verb |
| Abandon flow | Cancel, Discard changes | Close, Dismiss | Close is OK for pure overlays |
| Navigate forward in wizard | Continue to payment | Next, Proceed | Only when wizard step is labeled |
| Retry failed operation | Try again, Retry upload | OK | Verb or clear recovery phrase |

## Save vs Create vs Publish

| State | Label |
|---|---|
| Editing existing saved item | Save changes |
| Creating item not yet persisted | Create [entity] |
| Item saved but not public | Save draft → Publish [entity] when going live |
| Auto-save context | Saved (status text, not button) |

Do not use Submit for any of the above.

## Action-object syntax

```
[Imperative verb] + [specific object or format]
```

**Good:** Export CSV · Invite teammate · Copy invite link · Reset password  
**Weak:** Export · Invite · Copy · Reset (acceptable only when context is unambiguous)

## Capitalization

- Buttons and inline actions: sentence case (`Save changes`)
- All-caps: never for buttons
- Title case: only for proper nouns in the object (`Connect GitHub`)

## Ban list (replace on sight)

OK · Submit · Proceed · Continue (except labeled wizard steps) · Yes / No on action buttons · Click here · Learn more (as sole CTA with no verb alternative when action is known)
