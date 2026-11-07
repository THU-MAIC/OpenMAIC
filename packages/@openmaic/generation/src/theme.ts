/**
 * Course Design Tokens for Interactive Scenes (#2207)
 *
 * Establishes shared visual style and CSS design tokens derived from
 * the course design brief, ensuring slides and interactive scenes share
 * one consistent visual language.
 */

export interface CourseDesignTokens {
  background: string;
  surface: string;
  text: string;
  ink: string;
  mutedText: string;
  border: string;
  accent: string;
  font: string;
  colors?: string[];
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
  colors: ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe'],
  isDark: false,
};

const DARK_PRESET_TOKENS: CourseDesignTokens = {
  background: '#0f172a',
  surface: '#1e293b',
  text: '#f8fafc',
  ink: '#f8fafc',
  mutedText: '#94a3b8',
  border: '#334155',
  accent: '#38bdf8',
  font: 'system-ui, -apple-system, sans-serif',
  colors: ['#38bdf8', '#34d399', '#fbbf24', '#f43f5e', '#a78bfa', '#2dd4bf'],
  isDark: true,
};

const PAPER_PRESET_TOKENS: CourseDesignTokens = {
  background: '#fbf8f1',
  surface: '#f3ede0',
  text: '#2d2926',
  ink: '#2d2926',
  mutedText: '#78716c',
  border: '#e6ddd0',
  accent: '#b45309',
  font: 'Georgia, "Times New Roman", serif, system-ui',
  colors: ['#b45309', '#047857', '#4338ca', '#b91c1c', '#6d28d9', '#d97706'],
  isDark: false,
};

const GRAPHITE_PRESET_TOKENS: CourseDesignTokens = {
  background: '#181a1b',
  surface: '#242729',
  text: '#e1e3e6',
  ink: '#e1e3e6',
  mutedText: '#9ba1a6',
  border: '#373b3e',
  accent: '#8ab4f8',
  font: 'system-ui, -apple-system, sans-serif',
  colors: ['#8ab4f8', '#81c995', '#fdd663', '#f28b82', '#c58af9', '#78d9ec'],
  isDark: true,
};

const HIGH_CONTRAST_TOKENS: CourseDesignTokens = {
  background: '#ffffff',
  surface: '#f0f0f0',
  text: '#000000',
  ink: '#000000',
  mutedText: '#1a1a1a',
  border: '#000000',
  accent: '#0000ee',
  font: 'system-ui, -apple-system, Arial, sans-serif',
  colors: ['#0000ee', '#007700', '#cc0000', '#7700aa', '#ee6600', '#000000'],
  isDark: false,
};

/**
 * Check if a hex or rgb color string is considered dark based on perceived luminance.
 */
export function isColorDark(color?: string): boolean {
  if (!color || typeof color !== 'string') return false;
  const hex = color.trim().toLowerCase();
  if (hex.startsWith('#')) {
    const raw = hex.slice(1);
    if (raw.length === 3) {
      const r = parseInt(raw[0] + raw[0], 16);
      const g = parseInt(raw[1] + raw[1], 16);
      const b = parseInt(raw[2] + raw[2], 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5;
    }
    if (raw.length === 6) {
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5;
    }
  }
  if (hex.startsWith('rgb')) {
    const match = hex.match(/\d+/g);
    if (match && match.length >= 3) {
      const r = Number(match[0]);
      const g = Number(match[1]);
      const b = Number(match[2]);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5;
    }
  }
  return ['black', 'navy', 'darkblue', 'midnightblue', '#000', '#111', '#222'].includes(hex);
}

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

/**
 * Derive interactive color tokens from a course design brief or style hint (#2206 / #2207).
 * When absent, returns sensible default light tokens.
 */
export function deriveDesignTokens(
  design?: string,
  fallback?: Partial<CourseDesignTokens>,
): CourseDesignTokens {
  if (!design || typeof design !== 'string' || !design.trim()) {
    return { ...DEFAULT_DESIGN_TOKENS, ...fallback };
  }

  const raw = design.trim();
  const lower = raw.toLowerCase();

  // Known presets matching
  if (lower === 'dark' || lower.includes('preset: dark') || lower.includes('theme: dark')) {
    return { ...DARK_PRESET_TOKENS, ...fallback };
  }
  if (lower === 'paper' || lower.includes('preset: paper') || lower.includes('theme: paper')) {
    return { ...PAPER_PRESET_TOKENS, ...fallback };
  }
  if (
    lower === 'graphite' ||
    lower.includes('preset: graphite') ||
    lower.includes('theme: graphite')
  ) {
    return { ...GRAPHITE_PRESET_TOKENS, ...fallback };
  }
  if (
    lower === 'high-contrast' ||
    lower.includes('high-contrast') ||
    lower.includes('high contrast')
  ) {
    return { ...HIGH_CONTRAST_TOKENS, ...fallback };
  }

  // Parse natural language design brief
  const base = { ...DEFAULT_DESIGN_TOKENS, ...fallback };

  // Check if brief specifies or implies dark mode
  const isDarkMentioned =
    /\b(dark\s+background|dark\s+mode|dark\s+theme|dark\s+canvas|black\s+background|midnight|deep\s+slate)\b/i.test(
      raw,
    );

  // Extract explicit role colors using regex patterns
  const bgMatch = raw.match(
    /(?:background|bg)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|white|black|[a-zA-Z]+)\)?/i,
  );
  const textMatch = raw.match(
    /(?:text|ink|body|title)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|white|black|[a-zA-Z]+)\)?/i,
  );
  const accentMatch = raw.match(
    /(?:accent|highlight)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\)?/i,
  );
  const surfaceMatch = raw.match(
    /(?:surface|panel|card)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\)?/i,
  );
  const borderMatch = raw.match(
    /(?:border|divider)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\)?/i,
  );
  const mutedMatch = raw.match(
    /(?:muted|secondary)(?:-color)?\s*[:=\s(]\s*\(?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\)?/i,
  );

  let background = bgMatch ? bgMatch[1] : undefined;
  if (background && background.toLowerCase() === 'white') background = '#ffffff';
  if (background && background.toLowerCase() === 'black') background = '#000000';

  let text = textMatch ? textMatch[1] : undefined;
  if (text && text.toLowerCase() === 'white') text = '#ffffff';
  if (text && text.toLowerCase() === 'black') text = '#000000';

  const accent = accentMatch ? accentMatch[1] : undefined;
  const surface = surfaceMatch ? surfaceMatch[1] : undefined;
  const border = borderMatch ? borderMatch[1] : undefined;
  const mutedText = mutedMatch ? mutedMatch[1] : undefined;

  // If no explicit background was matched but hex colors are found
  const hexes = raw.match(HEX_COLOR_RE);

  const isDark = isDarkMentioned || (background ? isColorDark(background) : false);

  const resolvedTokens: CourseDesignTokens = {
    background: background ?? (isDark ? DARK_PRESET_TOKENS.background : base.background),
    surface: surface ?? (isDark ? DARK_PRESET_TOKENS.surface : base.surface),
    text: text ?? (isDark ? DARK_PRESET_TOKENS.text : base.text),
    ink: text ?? (isDark ? DARK_PRESET_TOKENS.ink : base.ink),
    mutedText: mutedText ?? (isDark ? DARK_PRESET_TOKENS.mutedText : base.mutedText),
    border: border ?? (isDark ? DARK_PRESET_TOKENS.border : base.border),
    accent: accent ?? hexes?.[0] ?? (isDark ? DARK_PRESET_TOKENS.accent : base.accent),
    font: base.font,
    colors: hexes && hexes.length > 0 ? hexes : isDark ? DARK_PRESET_TOKENS.colors : base.colors,
    isDark,
  };

  return resolvedTokens;
}

/**
 * Generate CSS variable block for design tokens to inject into interactive HTML.
 */
export function generateDesignTokenCss(tokens: CourseDesignTokens): string {
  const isDark = Boolean(tokens.isDark);
  const strictLightRules = !isDark
    ? `
  html, body {
    background-color: ${tokens.background} !important;
    color: ${tokens.text} !important;
  }
  /* Enforce that root container / background wrappers cannot be dark in light mode */
  body > [class*="bg-black"],
  body > [class*="bg-slate-900"],
  body > [class*="bg-slate-950"],
  body > [class*="bg-gray-900"],
  body > [class*="bg-zinc-900"],
  body > [class*="bg-[#0"],
  body > [class*="bg-[#1"] {
    background-color: ${tokens.background} !important;
    color: ${tokens.text} !important;
  }
`
    : `
  html, body {
    background-color: var(--color-background) !important;
    color: var(--color-text) !important;
  }
`;

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

  /* Aliases for maximum compatibility */
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

${strictLightRules}
body {
  font-family: var(--font-family);
}
`;
}

/**
 * Inject design tokens CSS block into interactive HTML document.
 */
export function injectDesignTokenCss(html: string, tokens: CourseDesignTokens): string {
  if (html.includes('data-openmaic-theme-tokens')) {
    return html;
  }
  const css = generateDesignTokenCss(tokens);
  const styleTag = `<style data-openmaic-theme-tokens>\n${css}\n</style>`;

  if (html.includes('</head>')) {
    return html.replace('</head>', `${styleTag}\n</head>`);
  }
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>\n${styleTag}`);
  }
  if (html.includes('<html>')) {
    return html.replace('<html>', `<html>\n<head>\n${styleTag}\n</head>`);
  }
  return `${styleTag}\n${html}`;
}
