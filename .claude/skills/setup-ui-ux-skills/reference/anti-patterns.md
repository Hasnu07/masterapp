# Default anti-aesthetic ban list

Confirm or edit this list during `setup-ui-ux-skills`. Downstream skills (especially `anti-slop`) treat confirmed items as hard bans.

## Visual clutter

| Ban | Why |
| --- | --- |
| Gratuitous glassmorphism (`backdrop-filter` without a hard edge) | Low contrast; looks like generic AI UI |
| Neon glowing borders / multi-stop rainbow CTAs | Decorative noise; weak hierarchy |
| Floating pastel pill badges for ordinary metadata | Fake importance; visual chatter |
| Decorative blob / mesh gradients behind content | Distracts from task; hard to theme |
| Nested scroll regions (page + card + list all scroll) | Breaks spatial memory and keyboard scroll |

## Empty states and illustration

| Ban | Why |
| --- | --- |
| Cartoon people waving / high-fiving / celebrating | Generic SaaS cliché; wastes space |
| Huge centered illustration with no CTA | Dead end; no activation path |

## Controls and chrome

| Ban | Why |
| --- | --- |
| Icons inside inputs unless functional (search, clear, password reveal) | Noise; accessibility confusion |
| Soft drop-shadows as the only separator (no border) | Muddy depth; fails low-contrast displays |
| Disabled primary submit as the only incomplete-form feedback | Silent trap; user cannot discover errors |

## How to customize

- Remove a row if the brand truly requires it (document why in `.ux-profile.md`).
- Add brand-specific bans (e.g. "no purple gradients", "no Inter font") as bullet lines under **Banned anti-aesthetics**.
