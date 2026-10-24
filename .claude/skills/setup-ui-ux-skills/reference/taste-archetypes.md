# Taste archetypes

Reference profiles for Section A of `setup-ui-ux-skills`. Pick one as the project's aesthetic baseline. Custom overrides these.

A name earns a first-class heading only if it differs from every existing profile on at least two of: density, borders/elevation, color, motion, interaction grammar, typography. Brand fame alone is not enough.

## Linear

- **Density:** High. Compact rows, tight toolbars, minimal chrome.
- **Borders:** Sharp 1px neutrals; rare soft shadows.
- **Color:** Near-monochrome canvas; one purposeful accent.
- **Motion:** Instant or near-instant; no decorative flourish.
- **Best for:** Issue trackers, engineering tools, power-user dashboards.

## Stripe

- **Density:** Balanced. Readable tables, clear hierarchy, calm whitespace.
- **Borders:** Subtle dividers; soft elevation when needed.
- **Color:** Restrained neutrals; refined accent; excellent data clarity.
- **Typography:** Strong type hierarchy; careful tabular figures.
- **Best for:** SaaS products, billing, analytics, customer-facing admin.

## Apple Native

- **Density:** Generous. Larger hit targets, unified corner radii.
- **Borders:** Soft separators; fluid materials without noisy glass.
- **Color:** Neutral system palettes; semantic system colors.
- **Motion:** Smooth, short, purposeful transitions.
- **Best for:** Consumer apps, settings, media, Mac/iOS-adjacent UIs.

## Raycast

- **Density:** Ultra-compact. Keyboard-first lists and command surfaces.
- **Borders:** High-contrast edges; minimal decoration.
- **Color:** Dark-friendly; accent for selection and status only.
- **Interaction:** Slash/command palette patterns; Esc dismisses everything.
- **Best for:** Launchers, command bars, developer utilities.

## Notion

- **Density:** Balanced-to-generous. Comfortable block spacing on a page canvas; sidebar can be tighter.
- **Borders:** Rare on decorative cards. Notion paper uses hairlines on lists and a quiet L1 for tables. It does not mean “spreadsheet text on a blank page.” Elevation by background shift, not shadow.
- **Color:** Warm stone / off-white paper. Soft gray body text. One muted accent. No rainbow, no glass.
- **Typography:** Editorial hierarchy. Large page title, calm body, few weights. Not Stripe tabular-admin.
- **Motion:** 150–200ms; opacity + small translate (same restraint as Stripe).
- **Interaction:** Block/page grammar — slash to insert, inline by default, nested pages. Esc/cancel stays cheap.
- **Best for:** Docs, wikis, notes, knowledge bases, content-first products.
- **Hard rule:** Paper + block discipline only. Does not license pastel callout slop, sticker decoration, or illustration empties.

Do not auto-pick Notion when the user wants Things 3; Things 3 stays a Custom seed below.

## Things 3 (optional Custom seed)

- **Density:** Calm and task-focused. Soft grouping, clear today/upcoming structure.
- **Color:** Warm neutrals with a single cheerful accent.
- **Best for:** Personal productivity, lightweight task UIs.

## Custom

Ask the user for:

1. One to three product URLs or screenshots they want to resemble
2. Three adjectives (e.g. "dense, monochrome, sharp")
3. Anything they explicitly forbid beyond the default ban list

Record those notes under **Aesthetic reference → Notes** in `.ux-profile.md`.

## Collapse map (agent-only)

Not a Section A option. If the user names something else, map it in one line, confirm, then write a peer or Custom — never invent a new standard name.

### Product lookalikes → pick the peer

| User says | Map to |
| --- | --- |
| Vercel, GitHub | Linear |
| Shopify admin, typical billing/SaaS dashboard | Stripe |
| iOS/macOS settings-like consumer UI | Apple Native |
| Command palette, launcher, Spotlight-like | Raycast |
| Docs/wiki/notes “like Notion” | Notion |

### Design systems and kits → Custom

| User says | Action |
| --- | --- |
| Material / MUI, Fluent, Carbon, Ant Design, Polaris | Custom. If the repo already uses that system, inherit its tokens and write the system name in Aesthetic notes. |
| shadcn, Radix Themes, Chakra, DaisyUI | Not taste. Ask which of the five peers (Linear, Stripe, Apple Native, Raycast, Notion), or Custom if they have screenshots. |

If a name is not in this table, treat it as Custom. Figma, Slack, and Things 3 are omitted on purpose.
