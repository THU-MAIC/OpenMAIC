import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// Static export build: the Orama index is generated at build time and written
// to /docs/static.json (basePath '/docs' + this route). The client downloads it
// and runs search fully in-browser, so no Node search server is needed.
export const revalidate = false;

// Orama's built-in tokenizers don't cover every locale (no zh / ja). Map each
// docs locale to the closest supported tokenizer; CJK falls back to 'english'
// (whitespace/basic tokenization), which is fine for a docs search index.
const server = createFromSource(source, {
  language: 'english',
  localeMap: {
    en: 'english',
    'zh-cn': 'english',
    'zh-tw': 'english',
    ja: 'english',
    ru: 'russian',
    ar: 'arabic',
  },
});

export async function GET() {
  return server.staticGET();
}
