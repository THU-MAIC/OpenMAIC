/**
 * OpenMAIC Course Style & Design Token Architecture (#2207)
 *
 * Provides first-class visual themes for courses:
 * - Light (default)
 * - Dark
 * - Follow the subject (deterministic domain-adaptive palette)
 * - Named presets: Paper, Graphite, High-contrast
 */

import type { SlideTheme } from '@openmaic/dsl';

export type CourseStyleId =
  | 'light'
  | 'dark'
  | 'subject'
  | 'follow-subject'
  | 'paper'
  | 'graphite'
  | 'high-contrast';

export interface CourseDesignTokens {
  background: string;
  surface: string;
  text: string;
  ink: string;
  mutedText: string;
  border: string;
  accent: string;
  font: string;
  colors: string[];
  isDark: boolean;
}

export interface CourseTheme {
  id: CourseStyleId;
  label: string;
  name: string;
  isLight: boolean;
  tokens: CourseDesignTokens;
  slideTheme: SlideTheme;
}

export const DEFAULT_COURSE_STYLE: CourseStyleId = 'light';

export const VALID_COURSE_STYLE_IDS: readonly CourseStyleId[] = [
  'light',
  'dark',
  'subject',
  'follow-subject',
  'paper',
  'graphite',
  'high-contrast',
];

const VALID_SET = new Set<string>(VALID_COURSE_STYLE_IDS);

/** Normalize user or API input into a canonical CourseStyleId. */
export function normalizeCourseStyle(raw?: unknown): CourseStyleId {
  if (typeof raw !== 'string') return DEFAULT_COURSE_STYLE;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-');
  if (
    cleaned === 'auto' ||
    cleaned === 'subject' ||
    cleaned === 'follow-the-subject' ||
    cleaned === 'follow-subject'
  ) {
    return 'subject';
  }
  if (cleaned === 'dark') return 'dark';
  if (cleaned === 'paper') return 'paper';
  if (cleaned === 'graphite') return 'graphite';
  if (cleaned === 'high-contrast' || cleaned === 'highcontrast') return 'high-contrast';
  if (cleaned === 'light') return 'light';
  return DEFAULT_COURSE_STYLE;
}

export function isValidCourseStyle(raw?: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return (
    VALID_SET.has(cleaned) ||
    cleaned === 'auto' ||
    cleaned === 'subject' ||
    cleaned === 'follow-the-subject'
  );
}

const STATIC_THEMES: Record<'light' | 'dark' | 'paper' | 'graphite' | 'high-contrast', CourseTheme> = {
  light: {
    id: 'light',
    label: 'Light',
    name: 'Light',
    isLight: true,
    tokens: {
      background: '#ffffff',
      surface: '#f8fafc',
      text: '#0f172a',
      ink: '#0f172a',
      mutedText: '#64748b',
      border: '#e2e8f0',
      accent: '#2563eb',
      font: 'system-ui, -apple-system, sans-serif',
      colors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
      isDark: false,
    },
    slideTheme: {
      backgroundColor: '#ffffff',
      fontColor: '#333333',
      fontName: 'Microsoft YaHei',
      themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47'],
      outline: { color: '#41719c', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    },
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    name: 'Dark',
    isLight: false,
    tokens: {
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
    },
    slideTheme: {
      backgroundColor: '#0f172a',
      fontColor: '#f8fafc',
      fontName: 'Microsoft YaHei',
      themeColors: ['#38bdf8', '#34d399', '#fbbf24', '#f43f5e', '#a78bfa', '#2dd4bf'],
      outline: { color: '#38bdf8', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: 'rgba(0,0,0,0.5)' },
    },
  },
  paper: {
    id: 'paper',
    label: 'Paper',
    name: 'Paper',
    isLight: true,
    tokens: {
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
    },
    slideTheme: {
      backgroundColor: '#fbf8f1',
      fontColor: '#2d2926',
      fontName: 'Georgia',
      themeColors: ['#b45309', '#047857', '#4338ca', '#b91c1c', '#6d28d9', '#d97706'],
      outline: { color: '#b45309', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 8, color: 'rgba(0,0,0,0.08)' },
    },
  },
  graphite: {
    id: 'graphite',
    label: 'Graphite',
    name: 'Graphite',
    isLight: false,
    tokens: {
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
    },
    slideTheme: {
      backgroundColor: '#181a1b',
      fontColor: '#e1e3e6',
      fontName: 'Microsoft YaHei',
      themeColors: ['#8ab4f8', '#81c995', '#fdd663', '#f28b82', '#c58af9', '#78d9ec'],
      outline: { color: '#8ab4f8', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: 'rgba(0,0,0,0.6)' },
    },
  },
  'high-contrast': {
    id: 'high-contrast',
    label: 'High-contrast',
    name: 'High-contrast',
    isLight: true,
    tokens: {
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
    },
    slideTheme: {
      backgroundColor: '#ffffff',
      fontColor: '#000000',
      fontName: 'Microsoft YaHei',
      themeColors: ['#0000ee', '#007700', '#cc0000', '#7700aa', '#ee6600', '#000000'],
      outline: { color: '#000000', width: 3, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 0, color: '#000000' },
    },
  },
};

export const COURSE_STYLES: Record<string, CourseTheme> = {
  light: STATIC_THEMES.light,
  dark: STATIC_THEMES.dark,
  subject: {
    id: 'subject',
    label: 'Follow the subject',
    name: 'Follow the subject',
    isLight: true,
    tokens: STATIC_THEMES.light.tokens,
    slideTheme: STATIC_THEMES.light.slideTheme,
  },
  'follow-subject': {
    id: 'subject',
    label: 'Follow the subject',
    name: 'Follow the subject',
    isLight: true,
    tokens: STATIC_THEMES.light.tokens,
    slideTheme: STATIC_THEMES.light.slideTheme,
  },
  paper: STATIC_THEMES.paper,
  graphite: STATIC_THEMES.graphite,
  'high-contrast': STATIC_THEMES['high-contrast'],
};

/**
 * Resolves a subject-adaptive palette deterministically from the course seed text.
 */
export function resolveSubjectTheme(
  input?: string | { requirement?: string; name?: string; id?: string },
): CourseTheme {
  const seed =
    typeof input === 'string'
      ? input
      : input?.requirement || input?.name || input?.id || '';
  const text = seed.toLowerCase();

  // 1. Nature / Biology / Life sciences / Ecology / Agriculture / Plant
  if (/bio|nature|plant|ecol|leaf|botan|forest|green|agri|organism|cell|dna|gene/.test(text)) {
    return {
      id: 'subject',
      label: 'Follow the subject',
      name: 'Follow the subject',
      isLight: true,
      tokens: {
        background: '#f8faf6',
        surface: '#edf4ea',
        text: '#1b3022',
        ink: '#1b3022',
        mutedText: '#4f6d58',
        border: '#cbe3d0',
        accent: '#16a34a',
        font: 'system-ui, -apple-system, sans-serif',
        colors: ['#16a34a', '#059669', '#65a30d', '#0d9488', '#15803d', '#84cc16'],
        isDark: false,
      },
      slideTheme: {
        backgroundColor: '#f8faf6',
        fontColor: '#1b3022',
        fontName: 'Microsoft YaHei',
        themeColors: ['#16a34a', '#059669', '#65a30d', '#0d9488', '#15803d', '#84cc16'],
        outline: { color: '#16a34a', width: 2, style: 'solid' },
        shadow: { h: 0, v: 0, blur: 8, color: 'rgba(22,163,74,0.15)' },
      },
    };
  }

  // 2. Astronomy / Space / Deep Physics / Night / Cosmos
  if (/space|astron|cosm|galaxy|star|planet|quantum|relativ|physics|orbit|telescope/.test(text)) {
    return {
      id: 'subject',
      label: 'Follow the subject',
      name: 'Follow the subject',
      isLight: false,
      tokens: {
        background: '#0b0f19',
        surface: '#151c2e',
        text: '#f1f5f9',
        ink: '#f1f5f9',
        mutedText: '#94a3b8',
        border: '#1e293b',
        accent: '#38bdf8',
        font: 'system-ui, -apple-system, sans-serif',
        colors: ['#38bdf8', '#818cf8', '#c084fc', '#34d399', '#f43f5e', '#fbbf24'],
        isDark: true,
      },
      slideTheme: {
        backgroundColor: '#0b0f19',
        fontColor: '#f1f5f9',
        fontName: 'Microsoft YaHei',
        themeColors: ['#38bdf8', '#818cf8', '#c084fc', '#34d399', '#f43f5e', '#fbbf24'],
        outline: { color: '#38bdf8', width: 2, style: 'solid' },
        shadow: { h: 0, v: 0, blur: 10, color: 'rgba(56,189,248,0.2)' },
      },
    };
  }

  // 3. History / Literature / Philosophy / Law / Culture
  if (/history|histor|literat|poem|cultur|philosoph|law|ancient|civiliz|art|myth|classic/.test(text)) {
    return {
      id: 'subject',
      label: 'Follow the subject',
      name: 'Follow the subject',
      isLight: true,
      tokens: {
        background: '#fdfbf7',
        surface: '#f7f1e6',
        text: '#2c241d',
        ink: '#2c241d',
        mutedText: '#7c6f62',
        border: '#e6dcce',
        accent: '#c2410c',
        font: 'Georgia, "Times New Roman", serif, system-ui',
        colors: ['#c2410c', '#b45309', '#4338ca', '#047857', '#9333ea', '#b91c1c'],
        isDark: false,
      },
      slideTheme: {
        backgroundColor: '#fdfbf7',
        fontColor: '#2c241d',
        fontName: 'Georgia',
        themeColors: ['#c2410c', '#b45309', '#4338ca', '#047857', '#9333ea', '#b91c1c'],
        outline: { color: '#c2410c', width: 2, style: 'solid' },
        shadow: { h: 0, v: 0, blur: 8, color: 'rgba(194,65,12,0.1)' },
      },
    };
  }

  // 4. Technology / Computer Science / Programming / AI / Mathematics / Engineering
  if (/code|program|comput|software|tech|data|ai|robot|cyber|math|calcul|algeb|engineer|electr/.test(text)) {
    return {
      id: 'subject',
      label: 'Follow the subject',
      name: 'Follow the subject',
      isLight: true,
      tokens: {
        background: '#0f172a',
        surface: '#1e293b',
        text: '#f8fafc',
        ink: '#f8fafc',
        mutedText: '#94a3b8',
        border: '#334155',
        accent: '#6366f1',
        font: 'system-ui, -apple-system, sans-serif',
        colors: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'],
        isDark: true,
      },
      slideTheme: {
        backgroundColor: '#0f172a',
        fontColor: '#f8fafc',
        fontName: 'Microsoft YaHei',
        themeColors: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6'],
        outline: { color: '#6366f1', width: 2, style: 'solid' },
        shadow: { h: 0, v: 0, blur: 10, color: 'rgba(99,102,241,0.2)' },
      },
    };
  }

  // 5. Default subject palette: Crisp clean educational cyan/blue
  return {
    id: 'subject',
    label: 'Follow the subject',
    name: 'Follow the subject',
    isLight: true,
    tokens: {
      background: '#f8fafc',
      surface: '#f1f5f9',
      text: '#0c4a6e',
      ink: '#0c4a6e',
      mutedText: '#475569',
      border: '#bae6fd',
      accent: '#0284c7',
      font: 'system-ui, -apple-system, sans-serif',
      colors: ['#0284c7', '#0ea5e9', '#38bdf8', '#06b6d4', '#2563eb', '#4f46e5'],
      isDark: false,
    },
    slideTheme: {
      backgroundColor: '#f8fafc',
      fontColor: '#0c4a6e',
      fontName: 'Microsoft YaHei',
      themeColors: ['#0284c7', '#0ea5e9', '#38bdf8', '#06b6d4', '#2563eb', '#4f46e5'],
      outline: { color: '#0284c7', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 8, color: 'rgba(2,132,199,0.12)' },
    },
  };
}

/**
 * Resolve the course theme.
 * For 'subject' / 'follow-subject', resolves deterministically from context (requirement / name / id).
 */
export function resolveCourseTheme(
  style?: string,
  context?: { requirement?: string; name?: string; id?: string },
): CourseTheme {
  const canonical = normalizeCourseStyle(style);
  if (canonical === 'subject' || canonical === 'follow-subject') {
    const theme = resolveSubjectTheme(context);
    return theme;
  }
  return STATIC_THEMES[canonical as keyof typeof STATIC_THEMES] ?? STATIC_THEMES.light;
}

/** Check if color is considered dark based on perceived luminance. */
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

/**
 * Generates the shared design-token CSS block to inject into interactive HTML.
 * Strict Light enforcement: when isDark is false, enforces light background on html and body.
 */
export function generateDesignTokenCss(tokens: CourseDesignTokens): string {
  const strictLightRules = !tokens.isDark
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
  --color-ink: ${tokens.ink};
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
