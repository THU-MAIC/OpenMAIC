import {
  toDataUri,
  type InlineReport,
  type InlineOptions,
  type FetchAsset,
} from './inline-assets-shared';
import {
  buildInlinedImportmap,
  resolveSpecifier,
  rewriteModuleSpecifiers,
} from './inline-assets-importmap';
import {
  analyzeHtmlAssetInventory,
  applySourcePatches,
  collectAssetRefs,
  replaceAttributePatch,
  replaceAttributeRangePatch,
  type AssetRefKind,
  type SourcePatch,
} from './html-asset-inventory';
import parseSrcset, { type SrcsetCandidate } from 'parse-srcset';
import type { AtRule, Root } from 'postcss';
import {
  cssImportReference,
  cssUrlReferences,
  parseCss,
  rewriteCssValue,
} from './css-asset-parser';

export { toDataUri } from './inline-assets-shared';
export type { InlineReport, InlineOptions, FetchAsset } from './inline-assets-shared';
export { collectAssetRefs } from './html-asset-inventory';
export type { AssetRef, AssetRefKind } from './html-asset-inventory';

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

async function inlineParsedCssUrls(
  root: Root,
  cssUrl: string,
  fetchAsset: FetchAsset,
  dropRefs: ReadonlySet<string>,
): Promise<{ failed: { url: string; reason: string }[]; inlined: string[] }> {
  const failed: { url: string; reason: string }[] = [];
  const inlined: string[] = [];
  const refsByUrl = new Map<string, Map<string, string>>();
  root.walkDecls((declaration) => {
    for (const ref of cssUrlReferences(declaration.value)) {
      const raw = ref.raw.trim();
      if (/^(?:data:|blob:|about:|#)/i.test(raw) || dropRefs.has(raw)) continue;
      try {
        const resolved = new URL(raw, cssUrl);
        const fragment = resolved.hash;
        resolved.hash = '';
        const fetchUrl = resolved.href;
        const raws = refsByUrl.get(fetchUrl) ?? new Map<string, string>();
        raws.set(raw, fragment);
        refsByUrl.set(fetchUrl, raws);
      } catch {
        // Leave unresolvable values untouched for strict residual validation.
      }
    }
  });

  const replacements = new Map<string, string>();
  await mapWithConcurrency([...refsByUrl.entries()], 8, async ([fetchUrl, raws]) => {
    const got = await fetchAsset(fetchUrl);
    if (got) {
      const dataUri = toDataUri(got.bytes, got.contentType);
      for (const [raw, fragment] of raws) replacements.set(raw, dataUri + fragment);
      inlined.push(fetchUrl);
    } else {
      failed.push({ url: fetchUrl, reason: 'fetch failed' });
    }
  });

  root.walkDecls((declaration) => {
    declaration.value = rewriteCssValue(declaration.value, (raw) => {
      const key = raw.trim();
      if (replacements.has(key)) return replacements.get(key);
      if (dropRefs.has(key)) return 'about:invalid';
      return undefined;
    });
  });
  return { failed, inlined };
}

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
  const root = parseCss(css, cssUrl);
  const imports: AtRule[] = [];
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === 'import') imports.push(rule);
  });
  for (const rule of imports) {
    const reference = cssImportReference(rule);
    if (!reference) continue;
    const raw = reference.url.trim();
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
      rule.remove();
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
    failed.push(...nested.failed);
    const wrapped = wrapImportedCss(nested.css, parseCssImportConditions(reference.conditions));
    rule.replaceWith(...parseCss(wrapped, abs).nodes);
  }

  // 1. Find @font-face blocks; build dropRefs (non-woff2 fonts in blocks that have a woff2).
  const dropRefs = new Set<string>();
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== 'font-face') return;
    const blockUrls: string[] = [];
    rule.walkDecls((declaration) => {
      blockUrls.push(...cssUrlReferences(declaration.value).map((ref) => ref.raw.trim()));
    });
    const hasWoff2 = blockUrls.some((u) => WOFF2_EXT.test(u) || /^data:font\/woff2/i.test(u));
    if (!hasWoff2) return;
    for (const u of blockUrls) {
      if (!/^data:/i.test(u) && NON_WOFF2_FONT_EXT.test(u)) dropRefs.add(u);
    }
  });

  const rewritten = await inlineParsedCssUrls(root, cssUrl, fetchAsset, dropRefs);
  failed.push(...rewritten.failed);
  inlined.push(...rewritten.inlined);

  return { css: root.toString(), failed, inlined };
}

async function inlineStyleAttributeUrls(
  css: string,
  fetchAsset: FetchAsset,
): Promise<{ css: string; failed: { url: string; reason: string }[]; inlined: string[] }> {
  const root = parseCss(`.openmaic-style{${css}}`, 'style-attribute');
  const result = await inlineParsedCssUrls(root, 'about:blank', fetchAsset, new Set());
  const serialized = root.toString();
  return {
    css: serialized.slice(serialized.indexOf('{') + 1, serialized.lastIndexOf('}')),
    ...result,
  };
}

async function inlineSvgPresentationAttributeUrls(
  attributeName: string,
  cssValue: string,
  fetchAsset: FetchAsset,
): Promise<{ cssValue: string; failed: { url: string; reason: string }[]; inlined: string[] }> {
  const root = parseCss(
    `.openmaic-svg{${attributeName}:${cssValue}}`,
    'svg-presentation-attribute',
  );
  let declarationValue = cssValue;
  const result = await inlineParsedCssUrls(root, 'about:blank', fetchAsset, new Set());
  root.walkDecls((declaration) => {
    if (declaration.prop === attributeName) declarationValue = declaration.value;
  });
  return { cssValue: declarationValue, ...result };
}

// ---------------------------------------------------------------------------
// inlineHtmlAssets — Task 4
// ---------------------------------------------------------------------------

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
  const inventory = analyzeHtmlAssetInventory(html);
  for (const script of inventory.moduleScripts) {
    const src = script.attributes.src;
    if (src && /^https?:\/\//i.test(src)) {
      const got = await fetchAsset(src);
      if (!got) {
        if (!report.failed.some((failure) => failure.url === src))
          report.failed.push({ url: src, reason: 'fetch failed' });
        continue;
      }
      moduleScripts.push({ code: new TextDecoder().decode(got.bytes), baseUrl: src });
    } else if (script.content.trim()) {
      moduleScripts.push({ code: script.content, baseUrl: undefined });
    }
  }
  const patches: SourcePatch[] = [];
  for (const importmap of inventory.importmaps) {
    if (!importmap.contentRange) continue;
    let parsed: { imports?: Record<string, string>; [key: string]: unknown };
    try {
      parsed = JSON.parse(importmap.content);
    } catch {
      continue;
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
    patches.push({
      range: importmap.contentRange,
      replacement: JSON.stringify({ ...parsed, imports: merged }),
    });
  }
  return applySourcePatches(html, patches);
}

function readImportmapImports(html: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const importmap of analyzeHtmlAssetInventory(html).importmaps) {
    try {
      Object.assign(
        imports,
        (JSON.parse(importmap.content) as { imports?: Record<string, string> }).imports ?? {},
      );
    } catch {
      // Strict preparation reports malformed import maps separately.
    }
  }
  return imports;
}

function unresolvedAssetUrls(html: string): string[] {
  const inventory = analyzeHtmlAssetInventory(html);
  const imports = readImportmapImports(html);
  const unresolved = new Set(
    collectAssetRefs(html, { includeRelative: true })
      .filter((ref) => ref.kind !== 'module-import' || !resolveSpecifier(ref.url, imports))
      .map((ref) => ref.url),
  );
  for (const importmap of inventory.importmaps) {
    try {
      JSON.parse(importmap.content);
    } catch {
      unresolved.add('malformed importmap');
    }
  }
  return [...unresolved];
}

/**
 * Scoped maps are intentionally rejected until module referrer URLs can be
 * preserved through data-URI packaging; silently flattening them changes which
 * dependency wins for modules under each scope.
 */
function unsupportedImportmapFeatures(html: string): string[] {
  for (const importmap of analyzeHtmlAssetInventory(html).importmaps) {
    try {
      const parsed = JSON.parse(importmap.content) as { scopes?: unknown };
      if (
        parsed.scopes !== undefined &&
        (typeof parsed.scopes !== 'object' ||
          parsed.scopes === null ||
          Array.isArray(parsed.scopes) ||
          Object.keys(parsed.scopes).length > 0)
      ) {
        return ['unsupported-importmap-scopes'];
      }
    } catch {
      // Malformed import maps are reported by residual validation.
    }
  }
  return [];
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
): Promise<{ html: string; report: InlineReport; unresolved: string[] }> {
  const fetchAsset = options?.fetcher ?? createAssetFetcher(options);
  const report: InlineReport = { inlined: [], failed: [] };
  const unsupported = unsupportedImportmapFeatures(html);
  if (unsupported.length > 0) return { html, report, unresolved: unsupported };

  // Pre-warm non-importmap asset fetches in parallel so the sequential
  // structured rewrite phases hit a warm cache (fonts are parallelized inside
  // inlineCssUrls; importmap modules are handled in buildInlinedImportmap).
  await Promise.all(
    collectAssetRefs(html)
      .filter(
        (ref) =>
          ref.kind !== 'importmap' &&
          ref.kind !== 'iframe-src' &&
          ref.kind !== 'iframe-srcdoc' &&
          ref.kind !== 'object-data' &&
          ref.kind !== 'embed-src',
      )
      .map((ref) => {
        const url =
          ref.kind === 'svg-image' || ref.kind === 'svg-use' || ref.kind === 'css-url'
            ? ref.url.split('#')[0]
            : ref.url;
        return fetchAsset(url).catch(() => null);
      }),
  );
  let out = html;

  const markInlined = (url: string) => {
    if (!report.inlined.includes(url)) report.inlined.push(url);
  };
  const markFailed = (url: string, reason: string) => {
    if (!report.failed.some((f) => f.url === url)) report.failed.push({ url, reason });
  };

  const inlineAttributes = async (kinds: ReadonlySet<AssetRefKind>) => {
    const patches: SourcePatch[] = [];
    for (const asset of analyzeHtmlAssetInventory(out).attributeAssets) {
      if (!kinds.has(asset.kind) || !HTTP_URL.test(asset.url)) continue;
      const isSvgReference = asset.kind === 'svg-image' || asset.kind === 'svg-use';
      const hashIndex = isSvgReference ? asset.url.indexOf('#') : -1;
      const fetchUrl = hashIndex === -1 ? asset.url : asset.url.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : asset.url.slice(hashIndex);
      const got = await fetchAsset(fetchUrl);
      if (!got) {
        markFailed(fetchUrl, 'fetch failed');
        continue;
      }
      const patch = replaceAttributePatch(asset, toDataUri(got.bytes, got.contentType) + fragment);
      if (patch) patches.push(patch);
      markInlined(fetchUrl);
    }
    out = applySourcePatches(out, patches);
  };

  // Resolve importmap entries before converting external module scripts. This
  // lets the importmap walker inspect their source bodies and nested imports.
  out = await inlineImportmaps(out, fetchAsset, report, options?.keepImportmapFallbacks !== false);

  // 1) Real <link rel=stylesheet href> → <style> with nested url() inlined.
  {
    const patches: SourcePatch[] = [];
    for (const asset of analyzeHtmlAssetInventory(out).attributeAssets) {
      if (
        asset.kind !== 'link' ||
        !HTTP_URL.test(asset.url) ||
        !asset.attributes.rel?.toLowerCase().split(/\s+/).includes('stylesheet') ||
        !asset.elementRange
      ) {
        continue;
      }
      const got = await fetchAsset(asset.url);
      if (!got) {
        markFailed(asset.url, 'fetch failed');
        continue;
      }
      let cssText = new TextDecoder().decode(got.bytes);
      const {
        css: rewritten,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineCssUrls(cssText, asset.url, fetchAsset);
      cssText = rewritten;
      for (const f of cssFailed) markFailed(f.url, f.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      const mediaAttr = asset.attributes.media
        ? ` media="${asset.attributes.media.replace(/"/g, '&quot;')}"`
        : '';
      markInlined(asset.url);
      patches.push({
        range: asset.elementRange,
        replacement: `<style data-inlined-from=""${mediaAttr}>${cssText}</style>`,
      });
    }
    out = applySourcePatches(out, patches);
  }

  // 2) Real <script src> (non-importmap) → data: URI src.
  {
    const patches: SourcePatch[] = [];
    for (const asset of analyzeHtmlAssetInventory(out).attributeAssets) {
      if (asset.kind !== 'script' || !HTTP_URL.test(asset.url)) continue;
      const got = await fetchAsset(asset.url);
      if (!got) {
        markFailed(asset.url, 'fetch failed');
        continue;
      }
      const type = asset.attributes.type?.trim().toLowerCase() === 'module';
      const source = new TextDecoder().decode(got.bytes);
      const rewritten = type
        ? await inlineModuleSource(source, asset.url, readImportmapImports(out), fetchAsset, report)
        : source;
      const patch = replaceAttributePatch(
        asset,
        toDataUri(new TextEncoder().encode(rewritten), got.contentType),
      );
      if (patch) patches.push(patch);
      markInlined(asset.url);
    }
    out = applySourcePatches(out, patches);
  }

  // Inline module bodies can contain direct absolute imports or relative
  // imports. Rewrite those too; bare specifiers remain governed by importmap.
  {
    const patches: SourcePatch[] = [];
    for (const script of analyzeHtmlAssetInventory(out).moduleScripts) {
      if (!script.contentRange || !script.content.trim()) continue;
      const rewritten = await inlineModuleSource(
        script.content,
        undefined,
        readImportmapImports(out),
        fetchAsset,
        report,
      );
      patches.push({ range: script.contentRange, replacement: rewritten });
    }
    out = applySourcePatches(out, patches);
  }

  // 3) Real <img>/<source>/<video>/<audio> src attributes.
  await inlineAttributes(new Set<AssetRefKind>(['img', 'source', 'video', 'audio']));

  // 4) Responsive image candidates use the same offline guarantee as src.
  {
    const patches: SourcePatch[] = [];
    for (const asset of analyzeHtmlAssetInventory(out).attributeAssets) {
      if (asset.kind !== 'srcset') continue;
      const rewritten = await Promise.all(
        parseSrcset(asset.url).map(async (candidate) => {
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
      const patch = replaceAttributePatch(asset, serializeSrcset(rewritten));
      if (patch) patches.push(patch);
    }
    out = applySourcePatches(out, patches);
  }

  // 5) <video poster> is an external image resource too.
  await inlineAttributes(new Set<AssetRefKind>(['poster', 'svg-image', 'svg-use']));

  // 6) url() inside authored <style> blocks (skip ones we created in step 1).
  {
    const patches: SourcePatch[] = [];
    for (const style of analyzeHtmlAssetInventory(out).styles) {
      if (style.attributes['data-inlined-from'] !== undefined || !style.contentRange) continue;
      const {
        css: rewritten,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineCssUrls(style.content, 'about:blank', fetchAsset);
      for (const f of cssFailed) markFailed(f.url, f.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      patches.push({ range: style.contentRange, replacement: rewritten });
    }
    out = applySourcePatches(out, patches);
  }

  // 7) url() inside authored style attributes.
  {
    const patches: SourcePatch[] = [];
    for (const style of analyzeHtmlAssetInventory(out).styleAttributes) {
      if (!style.range) continue;
      const {
        css: rewritten,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineStyleAttributeUrls(style.css, fetchAsset);
      for (const f of cssFailed) markFailed(f.url, f.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      const patch = replaceAttributeRangePatch('style', style.range, rewritten);
      if (patch) patches.push(patch);
    }
    out = applySourcePatches(out, patches);
  }

  // 8) url() inside SVG presentation attributes.
  {
    const patches: SourcePatch[] = [];
    for (const attribute of analyzeHtmlAssetInventory(out).svgPresentationAttributes) {
      if (!attribute.range) continue;
      const {
        cssValue,
        failed: cssFailed,
        inlined: cssInlined,
      } = await inlineSvgPresentationAttributeUrls(
        attribute.attributeName,
        attribute.cssValue,
        fetchAsset,
      );
      for (const failure of cssFailed) markFailed(failure.url, failure.reason);
      for (const inlined of cssInlined) markInlined(inlined);
      if (cssValue === attribute.cssValue) continue;
      const patch = replaceAttributeRangePatch(attribute.attributeName, attribute.range, cssValue);
      if (patch) patches.push(patch);
    }
    out = applySourcePatches(out, patches);
  }

  return { html: out, report, unresolved: unresolvedAssetUrls(out) };
}
