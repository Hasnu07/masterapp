# Icon libraries

Companion to `setup-ui-ux-skills` Section E. Use when the project has **no** existing icon set.

## Detection hints (explore first)

Look in `package.json`, lockfiles, imports, and asset folders for:

| Signal | Likely library |
| --- | --- |
| `lucide`, `lucide-react`, `@lucide/svelte`, `lucide-vue-next` | Lucide |
| `@heroicons/react`, `@heroicons/vue`, `heroicons` | Heroicons |
| `@phosphor-icons/react`, `@phosphor-icons/web`, `phosphor-icons` | Phosphor |
| `@tabler/icons-react`, `@tabler/icons`, `@tabler/icons-svelte` | Tabler Icons |
| `@radix-ui/react-icons` | Radix Icons |
| `remixicon`, `remixicon-react` | Remix Icon |
| `@iconify/*`, `unplugin-icons` | Iconify (record the active set) |
| `src/icons/`, `assets/icons/`, SVG sprite | Project SVG / inline |

If any of these exist, record the name and package/path in `.ux-profile.md`. Do **not** offer a replacement list.

## Recommended list (no library found)

Offer these stroke / product-UI options. Lead with Lucide.

1. **Lucide** (recommended) — consistent stroke set; packages for React, Vue, Svelte, and plain SVG
2. **Heroicons** — Tailwind/Headless ecosystem; outline + solid variants
3. **Phosphor** — large set; multiple weights (prefer one weight in-app)
4. **Tabler Icons** — dense stroke set; good for dashboards
5. **Radix Icons** — compact; fits Radix/shadcn stacks
6. **Remix Icon** — broad coverage; keep to one style (line or fill)
7. **Project SVG / inline only** — no package; ship a small curated sprite

Also allow: **None / defer** — user will decide later; leave profile notes empty of a package.

## Hard rules for agents

- Use **one** library (or the recorded project SVG path) for product UI icons
- Do not mix Lucide + Heroicons + emoji in the same chrome
- Do not use emoji as UI icons (nav, buttons, empty-state marks)
- Prefer outline/stroke at 16–24px for dense product UI; match the aesthetic density
- Setup records the choice only — it does **not** install packages
