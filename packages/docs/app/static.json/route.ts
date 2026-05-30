import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';
import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';
import { createTokenizer as createJapaneseTokenizer } from '@orama/tokenizers/japanese';
import { ORAMA_TOKENIZER, type OramaTokenizer } from '@/lib/locales.mjs';

// Static export build: the Orama index is generated at build time and written
// to /docs/static.json (basePath '/docs' + this route). The client downloads it
// and runs search fully in-browser, so no Node search server is needed.
export const revalidate = false;

// Map our per-locale tokenizer discriminator (single source: lib/locales.mjs)
// to the Orama config used to BUILD each locale's index. CJK locales need a
// custom tokenizer (Chinese/Japanese have no spaces, so the default whitespace
// tokenizer would index a whole doc as one token). The client query side in
// components/search-dialog.tsx maps the SAME discriminator the SAME way, so the
// built index and the query agree.
function oramaConfig(tokenizer: OramaTokenizer) {
  switch (tokenizer) {
    case 'mandarin':
      return { components: { tokenizer: createMandarinTokenizer() } };
    case 'japanese':
      return { components: { tokenizer: createJapaneseTokenizer() } };
    default:
      // Orama built-in language ('english' | 'russian' | 'arabic').
      return tokenizer;
  }
}

const localeMap = Object.fromEntries(
  Object.entries(ORAMA_TOKENIZER).map(([locale, tokenizer]) => [
    locale,
    oramaConfig(tokenizer),
  ]),
);

const server = createFromSource(source, { localeMap });

export async function GET() {
  return server.staticGET();
}
