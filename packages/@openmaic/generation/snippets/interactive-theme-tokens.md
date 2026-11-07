### Course Theme and Design Tokens

The course style is **{{styleName}}** (Light style: {{isLightStyle}}).
The runtime automatically injects design tokens as CSS variables on `:root`. Your interactive HTML and CSS MUST use these tokens instead of hardcoding page colors:

- `--color-background`: Main container and page background (current: `{{themeBackground}}`).
- `--color-surface`: Panel, card, or modal background (current: `{{themeSurface}}`).
- `--color-text`: Primary readable body and title text (current: `{{themeText}}`).
- `--color-muted`: Secondary labels, hints, and muted text (current: `{{themeMuted}}`).
- `--color-border`: Borders, dividers, and card outlines (current: `{{themeBorder}}`).
- `--color-accent`: Buttons, highlights, active states, and focal elements (current: `{{themeAccent}}`).
- `--font-family`: Typography (current: `{{themeFont}}`).

Rules:
1. Use `var(--color-background)`, `var(--color-surface)`, `var(--color-text)`, etc. for styling.
2. Do not define conflicting dark wrapper classes or arbitrary dark background styles when the style is Light.
3. Strict Light guarantee: When the style is Light, the page and canvas backgrounds must be light and clean. Never output black or dark page backgrounds (`#000`, `#0f172a`, `black`, dark slate/gray full-bleed backgrounds).
