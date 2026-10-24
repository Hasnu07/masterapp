# Timing tokens

Companion to `motion`. Canonical durations, easing, and property whitelist.

## Duration scale

| Token | Value | Typical use |
| --- | --- | --- |
| `--motion-100` | 100ms | Micro feedback (opacity on press, focus ring settle) |
| `--motion-150` | 150ms | Exit, dismiss, hover settle |
| `--motion-200` | 200ms | Enter slide-over, popover, row highlight |
| `--motion-300` | 300ms | Larger surface enter (full drawer on mobile); Apple-leaning aesthetics only |

Do not invent values outside this set. If a design asks for 250ms, snap to 200 or 300.

## Easing

| Phase | Curve | Notes |
| --- | --- | --- |
| Enter | ease-out / `cubic-bezier(0.16, 1, 0.3, 1)` | Fast start, soft land |
| Exit | ease-in / `cubic-bezier(0.7, 0, 0.84, 0)` | Soft start, quick leave |
| Symmetric | `ease` or `ease-in-out` | Color / opacity only; keep ≤200ms |

**Banned on product chrome:** bounce, elastic, spring with overshoot, `back`, playful wiggle.

## Property whitelist

**Allowed:** `transform` (`translate`, `scale` ≤1.02 for press), `opacity`, and color/border-color when ≤150ms.

**Banned for motion:** `width`, `height`, `top`, `left`, `right`, `bottom`, `margin`, `padding`, `font-size`. Prefer transform + reserved layout space (`transitions` skill).

## Aesthetic mapping

| Aesthetic | Bias |
| --- | --- |
| Linear / Raycast | Prefer 100–150ms or instant; minimal translate |
| Stripe / Notion | 150–200ms; restrained opacity + small translate |
| Apple Native | Up to 300ms when it clarifies hierarchy |
| Custom | Follow profile notes; still stay on the token scale |

## Exceptions

Document in `.ux-profile.md` Notes if marketing pages outside the app shell may use longer hero motion. App chrome still follows this table.
