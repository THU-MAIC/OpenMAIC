import {
  toDataUri,
  type InlineReport,
  type InlineOptions,
  type FetchAsset,
} from './inline-assets-shared';
import {
  buildInlinedImportmap,
  extractSpecifiers,
  resolveSpecifier,
  rewriteModuleSpecifiers,
} from './inline-assets-importmap';
import parseSrcset, { type SrcsetCandidate } from 'parse-srcset';

export { toDataUri } from './inline-assets-shared';
export type { InlineReport, InlineOptions, FetchAsset } from './inline-assets-shared';

export type AssetRefKind =
  | 'link'
  | 'script'
  | 'img'
  | 'srcset'
  | 'poster'
  | 'iframe-src'
  | 'object-data'
  | 'embed-src'
  | 'source'
  | 'video'
  | 'audio'
  | 'css-url'
  | 'css-import'
  | 'module-import'
  | 'base'
  | 'importmap';

export interface AssetRef {
  kind: AssetRefKind;
  url: string;
}

const HTTP_URL = /^https?:\/\//i;

interface CssImportConditions {
  layer?: string | null;
  supports?: string;
  media?: string;
}

function readParenthesized(value: string, start: number): { inner: string; rest: string } | null {
  if (value[start] !== '(') return null;
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (depth === 0) {
      return { inner: value.slice(start + 1, index), rest: value.slice(index + 1).trim() };
    }
  }
  return null;
}

function parseCssImportConditions(value: string): CssImportConditions {
  let rest = value.trim();
  const conditions: CssImportConditions = {};
  if (/^layer\b/i.test(rest)) {
    rest = rest.slice(5).trimStart();
    if (rest.startsWith('(')) {
      const parsed = readParenthesized(rest, 0);
      conditions.layer = parsed?.inner.trim() ?? null;
      rest = parsed?.rest ?? '';
    } else {
      conditions.layer = null;
    }
  }
  if (/^supports\s*\(/i.test(rest)) {
    const open = rest.indexOf('(');
    const parsed = readParenthesized(rest, open);
    conditions.supports = parsed?.inner.trim() ?? '';
    rest = parsed?.rest ?? '';
  }
  conditions.media = rest || undefined;
  return conditions;
}

function wrapImportedCss(css: string, conditions: CssImportConditions): string {
  let wrapped = css;
  if (conditions.media) wrapped = `@media ${conditions.media}{${wrapped}}`;
  if (conditions.supports) {
    const supports = /^(?:\(|not\b|selector\(|font-(?:format|tech)\()/i.test(conditions.supports)
      ? conditions.supports
      : `(${conditions.supports})`;
    wrapped = `@supports ${supports}{${wrapped}}`;
  }
  if (conditions.layer !== undefined) {
    wrapped = conditions.layer ? `@layer ${conditions.layer}{${wrapped}}` : `@layer{${wrapped}}`;
  }
  return wrapped;
}

function serializeSrcset(candidates: SrcsetCandidate[]): string {
  return candidates
    .map((candidate) => {
      const descriptor =
        candidate.w !== undefined
          ? `${candidate.w}w`
          : candidate.d !== undefined
            ? `${candidate.d}x`
            : candidate.h !== undefined
              ? `${candidate.h}h`
              : '';
      return descriptor ? `${candidate.url} ${descriptor}` : candidate.url;
    })
    .join(', ');
}

/** Scan LLM-generated interactive HTML for resources that must be bundled. */
export function collectAssetRefs(
  html: string,
  options: { includeRelative?: boolean } = {},
): AssetRef[] {
  const refs: AssetRef[] = [];
  const push = (kind: AssetRefKind, url: string) => {
    const value = url.trim();
    if (!value) return;
    if (/^(?:data:|blob:)/i.test(value)) {
      if (kind === 'iframe-src' || kind === 'object-data' || kind === 'embed-src') {
        refs.push({ kind, url: value });
      }
      return;
    }
    if (/^(?:about:|#)/i.test(value)) return;
    if (options.includeRelative || HTTP_URL.test(value)) refs.push({ kind, url: value });
  };

  for (const m of html.matchAll(/<base\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('base', m[1]);
  }
  for (const m of html.matchAll(/<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('link', m[1]);
  }
  for (const m of html.matchAll(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const whole = m[0].toLowerCase();
    if (whole.includes('importmap') || whole.includes('application/json')) continue;
    push('script', m[2]);
  }
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('img', m[1]);
  }
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*?\bsrcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    for (const candidate of parseSrcset(m[1])) push('srcset', candidate.url);
  }
  for (const m of html.matchAll(/<source\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('source', m[1]);
  }
  for (const m of html.matchAll(/<video\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('video', m[1]);
  }
  for (const m of html.matchAll(/<video\b[^>]*?\bposter\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('poster', m[1]);
  }
  for (const m of html.matchAll(/<audio\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('audio', m[1]);
  }
  for (const m of html.matchAll(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('iframe-src', m[1]);
  }
  for (const m of html.matchAll(/<object\b[^>]*?\bdata\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('object-data', m[1]);
  }
  for (const m of html.matchAll(/<embed\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('embed-src', m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    push('css-url', m[1].trim());
  }
  for (const m of html.matchAll(/@import\s+(?:url\(\s*)?["']?([^"'\s)]+)["']?\s*\)?/gi)) {
    push('css-import', m[1]);
  }
  for (const m of html.matchAll(
    /<script\b([^>]*)\btype\s*=\s*["']module["']([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    for (const spec of extractSpecifiers(m[3])) push('module-import', spec);
  }
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const map = JSON.parse(m[1]);
      const imports = map.imports ?? {};
      for (const v of Object.values(imports)) {
        if (typeof v === 'string') push('importmap', v);
      }
    } catch {
      // malformed importmap — skip
    }
  }
  return refs;
}

const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 * 1024;

export function createAssetFetcher(options?: InlineOptions): FetchAsset {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxBytes = options?.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const cache = new Map<string, Promise<{ bytes: Uint8Array; contentType: string } | null>>();

  return function fetchAsset(url: string) {
    const cached = cache.get(url);
    if (cached) return cached;
    const promise = (async () => {
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetchImpl(url);
          if (!res.ok) {
            // permanent client errors (e.g. 404, 403): don't retry
            if (res.status !== 429 && res.status < 500) return null;
            // transient server/rate-limit error: fall through to retry
            if (attempt === MAX_ATTEMPTS) return null;
          } else {
            const buf = new Uint8Array(await res.arrayBuffer());
            if (buf.byteLength > maxBytes) return null;
            const contentType =
              res.headers.get('content-type')?.split(';')[0]?.trim() || guessMime(url);
            return { bytes: buf, contentType };
          }
        } catch {
          // network error (connection reset, ECONNRESET, etc.)
          if (attempt === MAX_ATTEMPTS) return null;
        }
        // backoff before next attempt (150ms, 300ms)
        await new Promise((r) => setTimeout(r, 150 * attempt));
      }
      return null;
    })();
    cache.set(url, promise);
    return promise;
  };
}

/** Run `fn` over `items` with at most `limit` concurrent calls. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Fallback MIME by extension when the server omits content-type. */
function guessMime(url: string): string {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** Extension pattern matching non-woff2 font files (.woff, .ttf, .otf, .eot).
 * The `(\?|#|$)` boundary prevents `.woff` from matching inside `.woff2`. */
const NON_WOFF2_FONT_EXT = /\.(woff|ttf|otf|eot)(\?|#|$)/i;
const WOFF2_EXT = /\.woff2(\?|#|$)/i;

/** Inline every url(...) inside a CSS text, resolving relative URLs against cssUrl.
 *
 * Woff2-preference optimisation: within any @font-face block that contains a
 * woff2 url(), only the woff2 is inlined; sibling woff/ttf/otf/eot urls are
 * rewritten to `url(about:invalid)` so browsers never fetch them (they use the
 * first matching format — woff2 — and never reach the fallbacks). @font-face
 * blocks with NO woff2 fall back to the normal inline-everything behaviour.
 */
export async function inlineCssUrls(
  css: string,
  cssUrl: string,
  fetchAsset: FetchAsset,
  activeCssUrls: ReadonlySet<string> = new Set(),
): Promise<{ css: string; failed: { url: string; reason: string }[]; inlined: string[] }> {
  const failed: { url: string; reason: string }[] = [];
  const inlined: string[] = [];
  const importRe = /@import\s+(?:url\(\s*)?(["']?)([^"'\s)]+)\1\s*\)?\s*([^;]*);?/gi;
  const imports = [...css.matchAll(importRe)];
  const importedCss = new Map<string, string>();
  for (const match of imports) {
    const raw = match[2].trim();
    if (/^(?:data:|blob:|about:|#)/i.test(raw)) continue;
    let abs: string;
    try {
      abs = new URL(raw, cssUrl).href;
    } catch {
      continue;
    }
    if (activeCssUrls.has(abs)) {
      // Only imports on the current recursion path are cycles. Sibling imports
      // of the same stylesheet may carry distinct media/layer/supports guards.
      importedCss.set(match[0], '');
      continue;
    }
    const got = await fetchAsset(abs);
    if (!got) {
      failed.push({ url: abs, reason: 'fetch failed' });
      continue;
    }
    const nested = await inlineCssUrls(
      new TextDecoder().decode(got.bytes),
      abs,
      fetchAsset,
      new Set(activeCssUrls).add(abs),
    );
    inlined.push(abs, ...nested.inlined);
    importedCss.set(match[0], wrapImportedCss(nested.css, parseCssImportConditions(match[3])));
    failed.push(...nested.failed);
  }
  const cssWithImports = css.replace(importRe, (full) => importedCss.get(full) ?? full);

  // 1. Find @font-face blocks; build dropRefs (non-woff2 fonts in blocks that have a woff2).
  const dropRefs = new Set<string>();
  for (const block of cssWithImports.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
    const blockUrls = [...block.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((m) =>
      m[2].trim(),
    );
    const hasWoff2 = blockUrls.some((u) => WOFF2_EXT.test(u) || /^data:font\/woff2/i.test(u));
    if (!hasWoff2) continue;
    for (const u of blockUrls) {
      if (!/^data:/i.test(u) && NON_WOFF2_FONT_EXT.test(u)) dropRefs.add(u);
    }
  }

  // 2. Collect unique refs to FETCH (exclude data:, dropRefs, unresolvable).
  const urlRe = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
  const uniqueRefs = new Map<string, string>(); // raw -> absolute url
  for (const m of cssWithImports.matchAll(urlRe)) {
    const raw = m[2].trim();
    if (/^data:/i.test(raw)) continue;
    if (dropRefs.has(raw)) continue;
    if (uniqueRefs.has(raw)) continue;
    try {
      uniqueRefs.set(raw, new URL(raw, cssUrl).href);
    } catch {
      // skip unresolvable
    }
  }

  // 3. Fetch in parallel (bounded).
  const replacements = new Map<string, string>();
  const entries = [...uniqueRefs.entries()];
  await mapWithConcurrency(entries, 8, async ([raw, abs]) => {
    const got = await fetchAsset(abs);
    if (got) {
      replacements.set(raw, toDataUri(got.bytes, got.contentType));
      inlined.push(abs);
    } else {
      failed.push({ url: abs, reason: 'fetch failed' });
    }
  });

  // 4. Rewrite.
  const rewritten = cssWithImports.replace(urlRe, (full, _q, raw) => {
    const key = String(raw).trim();
    if (replacements.has(key)) return `url(${replacements.get(key)})`;
    if (dropRefs.has(key)) return 'url(about:invalid)';
    return full;
  });

  return { css: rewritten, failed, inlined };
}

// ---------------------------------------------------------------------------
// inlineHtmlAssets — Task 4
// ---------------------------------------------------------------------------

async function replaceAsync(
  input: string,
  re: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(re)];
  // Process sequentially so the fetcher cache is populated before the next
  // occurrence of the same URL is processed (dedup guarantee).
  const replaced: string[] = [];
  for (const m of matches) {
    replaced.push(await replacer(...(m as unknown as string[])));
  }
  let result = '';
  let last = 0;
  matches.forEach((m, i) => {
    result += input.slice(last, m.index!) + replaced[i];
    last = m.index! + m[0].length;
  });
  return result + input.slice(last);
}

async function inlineImportmaps(
  html: string,
  fetchAsset: FetchAsset,
  report: InlineReport,
  keepFallbacks: boolean,
): Promise<string> {
  // Collect both inline module bodies and external module sources. The latter
  // must be inspected before the script is converted to a data URI, otherwise
  // bare imports in an external module are invisible to importmap analysis.
  const moduleScripts: Array<{ code: string; baseUrl?: string }> = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src && /^https?:\/\//i.test(src)) {
      const got = await fetchAsset(src);
      if (!got) {
        if (!report.failed.some((failure) => failure.url === src))
          report.failed.push({ url: src, reason: 'fetch failed' });
        continue;
      }
      moduleScripts.push({ code: new TextDecoder().decode(got.bytes), baseUrl: src });
    } else if (m[2]?.trim()) {
      moduleScripts.push({ code: m[2], baseUrl: undefined });
    }
  }
  return await replaceAsync(
    html,
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
    async (full, json) => {
      let parsed: { imports?: Record<string, string> };
      try {
        parsed = JSON.parse(json);
      } catch {
        return full;
      }
      const orig = parsed.imports ?? {};
      const { imports: inlined, report: r } = await buildInlinedImportmap(
        orig,
        moduleScripts,
        fetchAsset,
      );
      for (const u of r.inlined) if (!report.inlined.includes(u)) report.inlined.push(u);
      for (const f of r.failed)
        if (!report.failed.some((g) => g.url === f.url)) report.failed.push(f);
      // Merge: start from originals, overlay inlined data: entries.
      // Merge: original prefix entries are retained as online fallback; inlined explicit
      // data: entries take precedence for the modules we inlined. Keeping both is safe per
      // the importmap spec (explicit specifier shadows prefix key) and strictly more correct:
      // a sub-path not seen during static analysis can still resolve via the prefix online.
      const merged: Record<string, string> = keepFallbacks ? { ...orig, ...inlined } : inlined;
      return `<script type="importmap">${JSON.stringify({ imports: merged })}</script>`;
    },
  );
}

function readImportmapImports(html: string): Record<string, string> {
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      return (JSON.parse(match[1]) as { imports?: Record<string, string> }).imports ?? {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Rewrite direct URL/relative module dependencies to data URIs for offline use. */
async function inlineModuleSource(
  code: string,
  baseUrl: string | undefined,
  imports: Record<string, string>,
  fetchAsset: FetchAsset,
  report: InlineReport,
): Promise<string> {
  const built = await buildInlinedImportmap(imports, [{ code, baseUrl }], fetchAsset);
  for (const url of built.report.inlined)
    if (!report.inlined.includes(url)) report.inlined.push(url);
  for (const failure of built.report.failed) {
    if (!report.failed.some((existing) => existing.url === failure.url))
      report.failed.push(failure);
  }
  return rewriteModuleSpecifiers(code, (specifier) => {
    return !resolveSpecifier(specifier, imports) ? built.imports[specifier] : undefined;
  });
}

export async function inlineHtmlAssets(
  html: string,
  options?: InlineOptions,
): Promise<{ html: string; report: InlineReport }> {
  const fetchAsset = options?.fetcher ?? createAssetFetcher(options);
  const report: InlineReport = { inlined: [], failed: [] };

  // Pre-warm non-importmap asset fetches in parallel so the sequential
  // replaceAsync passes below hit a warm cache (fonts are parallelized
  // inside inlineCssUrls; importmap modules are handled in buildInlinedImportmap).
  await Promise.all(
    collectAssetRefs(html)
      .filter(
        (ref) =>
          ref.kind !== 'importmap' &&
          ref.kind !== 'iframe-src' &&
          ref.kind !== 'object-data' &&
          ref.kind !== 'embed-src',
      )
      .map((r) => fetchAsset(r.url).catch(() => null)),
  );
  let out = html;

  const markInlined = (url: string) => {
    if (!report.inlined.includes(url)) report.inlined.push(url);
  };
  const markFailed = (url: string, reason: string) => {
    if (!report.failed.some((f) => f.url === url)) report.failed.push({ url, reason });
  };

  // Resolve importmap entries before converting external module scripts. This
  // lets the importmap walker inspect their source bodies and nested imports.
  out = await inlineImportmaps(out, fetchAsset, report, options?.keepImportmapFallbacks !== false);

  // 1) <link rel=stylesheet href> → <style> with nested url() inlined
  out = await replaceAsync(
    out,
    /<link\b([^>]*?)\bhref\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, pre, url, post) => {
      const isStylesheet = /rel\s*=\s*["']?stylesheet/i.test(pre + post);
      if (!isStylesheet) return full;
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      let cssText = new TextDecoder().decode(got.bytes);
      const {
        css: rewritten,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineCssUrls(cssText, url, fetchAsset);
      cssText = rewritten;
      for (const f of cssFailed) markFailed(f.url, f.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      const mediaMatch = /\bmedia\s*=\s*["']([^"']+)["']/i.exec(pre + post);
      const mediaAttr = mediaMatch ? ` media="${mediaMatch[1].replace(/"/g, '&quot;')}"` : '';
      markInlined(url);
      return `<style data-inlined-from=""${mediaAttr}>${cssText}</style>`;
    },
  );

  // 2) <script src> (non-importmap) → data: URI src
  out = await replaceAsync(
    out,
    /<script\b([^>]*?)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, pre, url, post) => {
      const attrs = (pre + post).toLowerCase();
      if (attrs.includes('importmap') || attrs.includes('application/json')) return full;
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      const type = /\btype\s*=\s*["']module["']/i.test(pre + post);
      const source = new TextDecoder().decode(got.bytes);
      const rewritten = type
        ? await inlineModuleSource(source, url, readImportmapImports(out), fetchAsset, report)
        : source;
      markInlined(url);
      return `<script${pre}src="${toDataUri(new TextEncoder().encode(rewritten), got.contentType)}"${post}>`;
    },
  );

  // Inline module bodies can contain direct absolute imports or relative
  // imports. Rewrite those too; bare specifiers remain governed by importmap.
  out = await replaceAsync(
    out,
    /<script\b([^>]*?)\btype\s*=\s*["']module["']([^>]*)>([\s\S]*?)<\/script>/gi,
    async (full, pre, post, body) => {
      const rewritten = await inlineModuleSource(
        body,
        undefined,
        readImportmapImports(out),
        fetchAsset,
        report,
      );
      return `<script${pre}type="module"${post}>${rewritten}</script>`;
    },
  );

  // 3) <img>/<source>/<video>/<audio> src
  out = await replaceAsync(
    out,
    /<(img|source|video|audio)\b([^>]*?)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, tag, pre, url, post) => {
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      markInlined(url);
      return `<${tag}${pre}src="${toDataUri(got.bytes, got.contentType)}"${post}>`;
    },
  );

  // 4) Responsive image candidates use the same offline guarantee as src.
  out = await replaceAsync(
    out,
    /<(img|source)\b([^>]*?)\bsrcset\s*=\s*(["'])([^"']+)\3([^>]*)>/gi,
    async (full, tag, pre, quote, value, post) => {
      const candidates = parseSrcset(value);
      const rewritten = await Promise.all(
        candidates.map(async (candidate) => {
          if (!HTTP_URL.test(candidate.url)) return candidate;
          const got = await fetchAsset(candidate.url);
          if (!got) {
            markFailed(candidate.url, 'fetch failed');
            return candidate;
          }
          markInlined(candidate.url);
          return { ...candidate, url: toDataUri(got.bytes, got.contentType) };
        }),
      );
      return `<${tag}${pre}srcset=${quote}${serializeSrcset(rewritten)}${quote}${post}>`;
    },
  );

  // 5) <video poster> is an external image resource too.
  out = await replaceAsync(
    out,
    /<video\b([^>]*?)\bposter\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
    async (full, pre, url, post) => {
      const got = await fetchAsset(url);
      if (!got) {
        markFailed(url, 'fetch failed');
        return full;
      }
      markInlined(url);
      return `<video${pre}poster="${toDataUri(got.bytes, got.contentType)}"${post}>`;
    },
  );

  // 6) url() inside authored <style> blocks (skip ones we created in step 1)
  out = await replaceAsync(
    out,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    async (full, attrs, body) => {
      if (/data-inlined-from=/.test(attrs)) return full;
      const {
        css: rewritten,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineCssUrls(body, 'about:blank', fetchAsset);
      for (const f of cssFailed) markFailed(f.url, f.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      return `<style${attrs}>${rewritten}</style>`;
    },
  );

  return { html: out, report };
}
