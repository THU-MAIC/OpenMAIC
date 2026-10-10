import { createMathPlugin, type MathPlugin, type MathPluginOptions } from '@streamdown/math';
import { safeKatexOptions } from '@openmaic/dsl';

/**
 * Streamdown's math plugin with the hardened KaTeX options merged in.
 *
 * `@streamdown/math` only forwards `errorColor` to `rehype-katex`, so its
 * plugin would render with KaTeX's defaults (formula-defined macros enabled).
 * This keeps its remark side and its `rehype-katex` instance, and replaces the
 * rehype options with `safeKatexOptions(...)` of what it configured.
 *
 * `rehype-katex` holds one options object per plugin instance and spreads it
 * into each render (`{ ...options, displayMode, throwOnError }`), including
 * its error retry. KaTeX writes built-in state into `macros` while rendering
 * (an `align` environment sets `\@eqnsw`, for example), so a shared object
 * would leak between formulas and between messages. `macros` is therefore an
 * enumerable getter: every spread, and so every render, gets a fresh one.
 */
export function createSafeMathPlugin(options?: MathPluginOptions): MathPlugin {
  const base = createMathPlugin(options);
  const rehype = base.rehypePlugin;
  if (
    !Array.isArray(rehype) ||
    typeof rehype[0] !== 'function' ||
    typeof rehype[1] !== 'object' ||
    rehype[1] === null
  ) {
    // Fail loudly if an upgrade changes the plugin's shape, rather than
    // silently rendering with KaTeX's defaults.
    throw new Error('@streamdown/math: unexpected rehypePlugin shape');
  }
  const [rehypeKatex, katexOptions] = rehype;
  return { ...base, rehypePlugin: [rehypeKatex, freshMacrosOptions(katexOptions as object)] };
}

/** Hardened options whose `macros` is rebuilt on every read. */
export function freshMacrosOptions(options: object): object {
  const { macros: _shared, ...hardened } = safeKatexOptions(options);
  return Object.defineProperty(hardened, 'macros', {
    enumerable: true,
    get: () => safeKatexOptions(options).macros,
  });
}
