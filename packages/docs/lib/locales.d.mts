// Type declarations for the plain-JS lib/locales.mjs shared config module.

export const DEFAULT_LANGUAGE: string;
export const LANGUAGES: string[];

export type OramaTokenizer =
  | 'mandarin'
  | 'japanese'
  | 'english'
  | 'russian'
  | 'arabic';

export const ORAMA_TOKENIZER: Record<string, OramaTokenizer>;
export const DOCS_BASE_PATH: string;
export const LOCALE_LABELS: Record<string, string>;
export const RTL_LOCALES: string[];
