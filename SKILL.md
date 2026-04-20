# SlateUp.AI — Agent Skill

You are designing for **SlateUp.AI** (SLATE by Chalk Labs), an AI-education product with a **landing site** and a **classroom app**. Two visual temperaments from one palette.

## Tokens
Import `colors_and_type.css` — it defines the palette, type stacks, radii, shadows, spacing as CSS variables.

```html
<link rel="stylesheet" href="/path/to/colors_and_type.css">
```

## Quick reference

**Palette** — Ink `#073B4C`, Primary `#EF476F`, Yellow `#FFD166`, Blue `#118AB2`, Green `#06D6A0`, Purple `#8338EC`, Orange `#FF6B35`. Cream canvas `#FDFDFD`. Never pure white.

**Type** — Fredoka (display, 700) + Nunito (body). Display tracks `-0.025em`. No 900 weight — Fredoka reads heavy already.

**Two flavors, NEVER mix:**

| | Landing (loud) | App (quiet) |
|---|---|---|
| Border | `4px solid #073B4C` | `1px solid #E8EDF2` or none |
| Card radius | `24–28px` | `16–20px` |
| Card shadow | `6px 6px 0 #073B4C` (hard offset) | `0 6px 16px -4px rgba(7,59,76,.10)` (soft) |
| Background | Full-bleed brand blocks | Cream throughout |
| Hover | `translateY(-6px)` | `translateY(-2px)` |
| Button | Pill, 2px border, 4px offset shadow | Pill, 1px border, soft shadow |

**Rules of thumb:**
- Ink `#073B4C` is the ONLY stroke color on landing.
- Pills (999px radius) for buttons, inputs, badges — never square.
- Icons: **Lucide only**. Chip them in colored `56×56` squares with 3px ink border (landing) or bare (app).
- No emoji. No gradients (except one soft radial wash on the drafting screen). No dashed borders.
- Motion: spring physics (stiffness 200–300, damping 20). Hover is always *movement*, never color-fade.
- Floating blobs on landing: `border: 4px solid #073B4C`, `opacity: .25–.5`, scattered at % coords, 6–7s ease-in-out bob.

## Voice
Second person. `You` = reader, `We` = Chalk Labs. Em dashes liberally. Contractions always. Title Case headings, sentence case body. No emoji, no exclamation spam.

## Files

- `README.md` — full system docs (read first)
- `colors_and_type.css` — tokens
- `preview/` — visual reference for every token
- `ui_kits/landing/` — hi-fi marketing site recreation
- `ui_kits/app/` — hi-fi classroom product (Home → Drafting → Classroom)
- `assets/` — logos, favicons, banner, reference screenshots

When asked to design for SlateUp.AI, start by identifying **which product** (landing or app) and pick the matching flavor from the table above. Import components from the matching UI kit.
