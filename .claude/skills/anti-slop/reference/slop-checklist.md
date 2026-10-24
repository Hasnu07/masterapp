# Slop Checklist — Visual Identification Matrix

Use this matrix during review of AI-generated or template UI. If **Detect** is true and **Allowed exception** is false, remove or rewrite the pattern.

## Forbidden CSS and layout clichés

| ID | Pattern | Detect (search / signal) | Allowed exception | Fix |
|----|---------|--------------------------|-------------------|-----|
| S1 | Rainbow CTA gradient | `conic-gradient`, or `linear-gradient` with ≥3 hues on `.btn`, `[role="button"]`, primary submit | Marketing hero **outside** app shell, explicitly in profile | Solid `--accent` or single-hue gradient |
| S2 | Purple-orange SaaS gradient | `#6366f1` → `#ec4899` or similar on buttons/backgrounds | None in app UI | Neutral canvas + accent solid |
| S3 | Glassmorphism panel | `backdrop-filter: blur(` without `border: 1px solid` ≥3:1 | None by default; profile may allow with strict boundary | Opaque L2/L3 surface + border |
| S4 | Frosted sidebar | Semi-transparent nav + blur over content | None | Opaque L1 surface, border-right |
| S5 | Decorative blob backgrounds | Large absolute `border-radius: 50%` blurred divs behind forms | Brand marketing pages only | Remove or replace with flat L0 |
| S6 | Neon glow border | `box-shadow: 0 0 20px` saturated hue on cards/inputs | None | 1px subtle border per elevation tokens |
| S7 | Hard drop-shadow cards | `rgba(0,0,0,0.2+)`, offset ≥8px, blur <12px | None | Border-first; shadow alpha <0.08 |
| S8 | Floating pastel pill tags on static text | `border-radius: 9999px` + pastel bg on non-interactive metadata | Interactive filter chips user can toggle | Plain secondary text or real chip component |
| S9 | Icon in every input | Leading SVG/icon on text, email, password fields | Search, clear, visibility toggle only | Remove decorative icons |
| S10 | Cartoon empty-state people | Illustration keywords: waving, high-five, team celebration, `undraw`, `:person` hero art | None | Text + CTA + optional 24px monochrome icon |
| S11 | Giant centered spinner empty page | Full-viewport loader as empty state | Initial app boot only, <1s | Actionable empty state pattern |
| S12 | Nested gradient borders | `padding: 2px` + gradient wrapper on cards | None | 1px solid `--border-subtle` |
| S13 | Over-rounded everything | `border-radius: 24px+` on inputs, tables, and buttons together | Brand profile explicitly specifies | Match system radius token (usually 6–8px UI) |
| S14 | Gradient text headings | `background-clip: text` rainbow on H1/H2 in app UI | Marketing hero only | Solid foreground color |
| S15 | Duplicate shadow + gradient + blur | Same component uses all three | None | Pick one depth mechanism (border first) |

## Quick grep patterns

```bash
# Run against changed CSS/component files
rg -i "backdrop-filter|conic-gradient" .
rg -i "linear-gradient\([^)]*#[0-9a-fA-F]{3,6}[^)]*#[0-9a-fA-F]{3,6}[^)]*#" .
rg -i "border-radius:\s*999" .
rg -i "box-shadow:.*0\.[2-9]|box-shadow:.*rgba\(0,\s*0,\s*0,\s*0\.[2-9]" .
```

## Component-level review

| Component | Slop signals | Clean alternative |
|-----------|--------------|-------------------|
| Primary button | Rainbow gradient, oversized radius, glow | Solid accent, 6–8px radius, medium weight label |
| Card | Glass background, heavy shadow, gradient border | L1 surface, 1px border, optional soft shadow |
| Empty state | Cartoon people, long paragraph, no CTA | Title + 1 sentence + verb-first button |
| Form field | Icon left, placeholder as label, pill error toast | Visible label, blur validation, inline error text |
| Modal | Blur backdrop only, no scrim opacity | Scrim 50–70% + opaque L3 panel + border |
| Nav item | Gradient active pill + icon + badge dot | Text + subtle bg or left border active indicator |

## Severity actions

| Result | Action |
|--------|--------|
| Any S1–S5 on core app path | **Block** — rewrite before merge |
| S6–S9 on secondary screens | **Fix** in same pass |
| S10–S15 | **Fix** unless profile documents exception |

## Profile integration

If `.ux-profile.md` **Banned anti-aesthetics** lists extra items, treat them as **hard-rule** equals to this matrix. Profile bans win when stricter.

## Sign-off

Reviewer confirms:

- [ ] No S1–S5 matches in application shell
- [ ] Empty states are actionable, not illustrative clutter
- [ ] Inputs contain only functional icons
- [ ] Metadata is not pill-wrapped for decoration
- [ ] Depth uses borders/shadows from elevation tokens, not glow/blur stacks
