import {
  toDataUri,
  type InlineReport,
  type InlineOptions,
  type FetchAsset,
} from './inline-assets-shared';
import { buildInlinedImportmap } from './inline-assets-importmap';

export { toDataUri } from './inline-assets-shared';
export type { InlineReport, InlineOptions, FetchAsset } from './inline-assets-shared';

export type AssetRefKind = 'link' | 'script' | 'img' | 'source' | 'css-url' | 'importmap';

export interface AssetRef {
  kind: AssetRefKind;
  url: string;
}

const HTTP_URL = /^https?:\/\//i;

/** Scan LLM-generated interactive HTML for external http(s) asset references. */
export function collectAssetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = [];
  const push = (kind: AssetRefKind, url: string) => {
    if (HTTP_URL.test(url)) refs.push({ kind, url });
  };

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
  for (const m of html.matchAll(/<source\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    push('source', m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    push('css-url', m[1].trim());
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
): Promise<{ css: string; failed: { url: string; reason: string }[] }> {
  // 1. Find @font-face blocks; build dropRefs (non-woff2 fonts in blocks that have a woff2).
  const dropRefs = new Set<string>();
  for (const block of css.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
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
  for (const m of css.matchAll(urlRe)) {
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
  const failed: { url: string; reason: string }[] = [];
  const entries = [...uniqueRefs.entries()];
  await mapWithConcurrency(entries, 8, async ([raw, abs]) => {
    const got = await fetchAsset(abs);
    if (got) {
      replacements.set(raw, toDataUri(got.bytes, got.contentType));
    } else {
      failed.push({ url: abs, reason: 'fetch failed' });
    }
  });

  // 4. Rewrite.
  const rewritten = css.replace(urlRe, (full, _q, raw) => {
    const key = String(raw).trim();
    if (replacements.has(key)) return `url(${replacements.get(key)})`;
    if (dropRefs.has(key)) return 'url(about:invalid)';
    return full;
  });

  return { css: rewritten, failed };
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
): Promise<string> {
  // Collect inline module-script bodies (type="module", non-importmap, with a body).
  const moduleBodies: string[] = [];
  for (const m of html.matchAll(
    /<script\b([^>]*)\btype\s*=\s*["']module["']([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (m[3]?.trim()) moduleBodies.push(m[3]);
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
        moduleBodies,
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
      const merged: Record<string, string> = { ...orig, ...inlined };
      return `<script type="importmap">${JSON.stringify({ imports: merged })}</script>`;
    },
  );
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
      .filter((r) => r.kind !== 'importmap')
      .map((r) => fetchAsset(r.url).catch(() => null)),
  );
  let out = html;

  const markInlined = (url: string) => {
    if (!report.inlined.includes(url)) report.inlined.push(url);
  };
  const markFailed = (url: string, reason: string) => {
    if (!report.failed.some((f) => f.url === url)) report.failed.push({ url, reason });
  };

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
      const { css: rewritten, failed: cssFailed } = await inlineCssUrls(cssText, url, fetchAsset);
      cssText = rewritten;
      for (const f of cssFailed) markFailed(f.url, f.reason);
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
      markInlined(url);
      return `<script${pre}src="${toDataUri(got.bytes, got.contentType)}"${post}>`;
    },
  );

  // 3) <img src> and <source src>
  out = await replaceAsync(
    out,
    /<(img|source)\b([^>]*?)\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>/gi,
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

  // 4) url() inside authored <style> blocks (skip ones we created in step 1)
  out = await replaceAsync(
    out,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    async (full, attrs, body) => {
      if (/data-inlined-from=/.test(attrs)) return full;
      const { css: rewritten, failed: cssFailed } = await inlineCssUrls(
        body,
        'about:blank',
        fetchAsset,
      );
      for (const f of cssFailed) markFailed(f.url, f.reason);
      return `<style${attrs}>${rewritten}</style>`;
    },
  );

  // 5) importmap (Task 5)
  out = await inlineImportmaps(out, fetchAsset, report);

  return { html: out, report };
}
