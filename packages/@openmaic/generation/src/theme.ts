/**
 * Shared visual tokens for interactive scenes.
 */

export interface InteractiveDesignPalette {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

export interface CourseDesignTokens {
  background: string;
  surface: string;
  text: string;
  ink: string;
  mutedText: string;
  border: string;
  accent: string;
  font: string;
  isDark?: boolean;
}

export const DEFAULT_DESIGN_TOKENS: CourseDesignTokens = {
  background: '#ffffff',
  surface: '#f8fafc',
  text: '#0f172a',
  ink: '#0f172a',
  mutedText: '#64748b',
  border: '#e2e8f0',
  accent: '#2563eb',
  font: 'system-ui, -apple-system, sans-serif',
  isDark: false,
};

/** Check whether a CSS color has dark perceived luminance. */
export function isColorDark(color?: string): boolean {
  if (!color || typeof color !== 'string') return false;
  const value = color.trim().toLowerCase();
  if (value.startsWith('#')) {
    const raw = value.slice(1);
    if (raw.length === 3 || raw.length === 6) {
      const expanded = raw.length === 3 ? raw.replace(/./g, (char) => char + char) : raw;
      const r = parseInt(expanded.slice(0, 2), 16);
      const g = parseInt(expanded.slice(2, 4), 16);
      const b = parseInt(expanded.slice(4, 6), 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
    }
  }
  if (value.startsWith('rgb')) {
    const match = value.match(/\d+/g);
    if (match && match.length >= 3) {
      return (
        (0.299 * Number(match[0]) + 0.587 * Number(match[1]) + 0.114 * Number(match[2])) / 255 < 0.5
      );
    }
  }
  return ['black', 'navy', 'darkblue', 'midnightblue'].includes(value);
}

/**
 * Resolve the structured palette supplied by the course agent.
 * Missing roles use the neutral light fallback; no prose is interpreted here.
 */
export function resolveDesignTokens(
  palette?: Partial<InteractiveDesignPalette>,
): CourseDesignTokens {
  const background = palette?.background ?? DEFAULT_DESIGN_TOKENS.background;
  const surface = palette?.surface ?? DEFAULT_DESIGN_TOKENS.surface;
  const text = palette?.text ?? DEFAULT_DESIGN_TOKENS.text;
  const mutedText = palette?.muted ?? DEFAULT_DESIGN_TOKENS.mutedText;
  const border = palette?.border ?? DEFAULT_DESIGN_TOKENS.border;
  const accent = palette?.accent ?? DEFAULT_DESIGN_TOKENS.accent;
  return {
    background,
    surface,
    text,
    ink: text,
    mutedText,
    border,
    accent,
    font: DEFAULT_DESIGN_TOKENS.font,
    isDark: isColorDark(background),
  };
}

/** Generate the non-invasive CSS variable block for interactive HTML. */
export function generateDesignTokenCss(tokens: CourseDesignTokens): string {
  return `
/* @openmaic/theme-tokens */
:root {
  --color-background: ${tokens.background};
  --color-surface: ${tokens.surface};
  --color-text: ${tokens.text};
  --color-ink: ${tokens.ink || tokens.text};
  --color-muted: ${tokens.mutedText};
  --color-border: ${tokens.border};
  --color-accent: ${tokens.accent};
  --font-family: ${tokens.font};

  --bg: var(--color-background);
  --background: var(--color-background);
  --surface: var(--color-surface);
  --text: var(--color-text);
  --ink: var(--color-ink);
  --muted: var(--color-muted);
  --muted-text: var(--color-muted);
  --border: var(--color-border);
  --accent: var(--color-accent);
  --font: var(--font-family);

  --theme-background: var(--color-background);
  --theme-surface: var(--color-surface);
  --theme-text: var(--color-text);
  --theme-ink: var(--color-ink);
  --theme-muted: var(--color-muted);
  --theme-border: var(--color-border);
  --theme-accent: var(--color-accent);
  --theme-font: var(--font-family);
}

body {
  font-family: var(--font-family);
}
`;
}

/** Inject the token block once into an interactive HTML document. */
export function injectDesignTokenCss(html: string, tokens: CourseDesignTokens): string {
  if (html.includes('data-openmaic-theme-tokens')) return html;
  const styleTag = `<style data-openmaic-theme-tokens>\n${generateDesignTokenCss(tokens)}\n</style>`;
  if (html.includes('</head>')) return html.replace('</head>', `${styleTag}\n</head>`);
  if (html.includes('<head>')) return html.replace('<head>', `<head>\n${styleTag}`);
  if (html.includes('<html>'))
    return html.replace('<html>', `<html>\n<head>\n${styleTag}\n</head>`);
  return `${styleTag}\n${html}`;
}
