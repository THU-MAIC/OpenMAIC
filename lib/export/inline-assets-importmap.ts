import { toDataUri, type InlineReport } from './inline-assets-shared';
import { parse } from 'es-module-lexer/js';

interface ModuleSpecifierRange {
  specifier: string;
  start: number;
  end: number;
}

function moduleSpecifierRanges(code: string): ModuleSpecifierRange[] {
  const [imports] = parse(code);
  return imports.flatMap((entry) => {
    if (!entry.n || entry.d === -2) return [];
    let start = entry.s;
    let end = entry.e;
    if (entry.d >= 0 && (code[start] === '"' || code[start] === "'")) {
      start++;
      end--;
    }
    return [{ specifier: entry.n, start, end }];
  });
}

/** Rewrite every statically discoverable module specifier without duplicating parser logic. */
export async function rewriteModuleSpecifiers(
  code: string,
  replacementFor: (specifier: string) => string | undefined | Promise<string | undefined>,
): Promise<string> {
  const ranges = moduleSpecifierRanges(code);
  const replacements = await Promise.all(
    ranges.map(async ({ specifier, start, end }) => {
      return (await replacementFor(specifier)) ?? code.slice(start, end);
    }),
  );
  let rewritten = '';
  let last = 0;
  ranges.forEach((range, index) => {
    rewritten += code.slice(last, range.start) + replacements[index];
    last = range.end;
  });
  return rewritten + code.slice(last);
}

export function extractSpecifiers(code: string): string[] {
  return [...new Set(moduleSpecifierRanges(code).map(({ specifier }) => specifier))];
}

/** Resolve a specifier against importmap: exact match first, then longest '/'-terminated prefix. */
export function resolveSpecifier(spec: string, imports: Record<string, string>): string | null {
  if (spec in imports) return imports[spec];
  let best: { key: string; url: string } | null = null;
  for (const [key, url] of Object.entries(imports)) {
    if (key.endsWith('/') && spec.startsWith(key)) {
      if (!best || key.length > best.key.length) best = { key, url };
    }
  }
  return best ? best.url + spec.slice(best.key.length) : null;
}

export async function buildInlinedImportmap(
  originalImports: Record<string, string>,
  moduleScripts: readonly (string | { code: string; baseUrl?: string })[],
  fetchAsset: (url: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>,
): Promise<{ imports: Record<string, string>; report: InlineReport }> {
  const report: InlineReport = { inlined: [], failed: [] };
  const resolvedDataUri = new Map<string, string>(); // specifier -> data: URI
  const visited = new Set<string>();

  const normalizedScripts = moduleScripts.map((script) =>
    typeof script === 'string' ? { code: script, baseUrl: undefined } : script,
  );

  const resolveExternal = (specifier: string, baseUrl?: string): string | null => {
    if (/^https?:\/\//i.test(specifier)) return specifier;
    if (!baseUrl || /^(?:data:|blob:|about:|#)/i.test(specifier)) return null;
    try {
      const resolved = new URL(specifier, baseUrl).href;
      return /^https?:\/\//i.test(resolved) ? resolved : null;
    } catch {
      return null;
    }
  };

  async function inlineModuleDependencies(
    code: string,
    baseUrl: string | undefined,
    stack: Set<string>,
  ): Promise<string> {
    return rewriteModuleSpecifiers(code, async (spec) => {
      if (!spec || resolveSpecifier(spec, originalImports)) {
        return undefined;
      }
      const absUrl = resolveExternal(spec, baseUrl);
      if (!absUrl) {
        return undefined;
      }
      if (stack.has(absUrl)) {
        if (!report.failed.some((failure) => failure.url === absUrl)) {
          report.failed.push({ url: absUrl, reason: 'cyclic module dependency' });
        }
        return undefined;
      }
      const got = await fetchAsset(absUrl);
      if (!got) {
        if (!report.failed.some((failure) => failure.url === absUrl)) {
          report.failed.push({ url: absUrl, reason: 'fetch failed' });
        }
        return undefined;
      }
      if (!report.inlined.includes(absUrl)) report.inlined.push(absUrl);
      const nestedStack = new Set(stack).add(absUrl);
      const nestedCode = await inlineModuleDependencies(
        new TextDecoder().decode(got.bytes),
        absUrl,
        nestedStack,
      );
      const dataUri = toDataUri(new TextEncoder().encode(nestedCode), got.contentType);
      return dataUri;
    });
  }

  async function visitSpecifier(spec: string, baseUrl?: string): Promise<void> {
    const visitKey = `${baseUrl ?? ''}\u0000${spec}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const absUrl = resolveSpecifier(spec, originalImports) ?? resolveExternal(spec, baseUrl);
    if (!absUrl) return; // bare/unmapped specifier — leave to the browser for diagnostics
    if (/^data:/i.test(absUrl)) {
      resolvedDataUri.set(spec, absUrl);
      return;
    }
    const got = await fetchAsset(absUrl);
    if (!got) {
      if (!report.failed.some((f) => f.url === absUrl))
        report.failed.push({ url: absUrl, reason: 'fetch failed' });
      return;
    }
    resolvedDataUri.set(spec, toDataUri(got.bytes, got.contentType));
    if (!report.inlined.includes(absUrl)) report.inlined.push(absUrl);
    const code = await inlineModuleDependencies(
      new TextDecoder().decode(got.bytes),
      absUrl,
      new Set([absUrl]),
    );
    resolvedDataUri.set(spec, toDataUri(new TextEncoder().encode(code), got.contentType));
    for (const childSpec of extractSpecifiers(code)) {
      await visitSpecifier(childSpec, absUrl);
    }
  }

  for (const { code, baseUrl } of normalizedScripts) {
    for (const spec of extractSpecifiers(code)) await visitSpecifier(spec, baseUrl);
  }

  // Also inline direct imports from module scripts that do not use an importmap.
  // `inlineHtmlAssets` invokes the same dependency walk while rewriting each
  // module source; this pass ensures importmap entries still discover every
  // nested dependency before the map is emitted.

  const imports: Record<string, string> = {};
  for (const [spec, dataUri] of resolvedDataUri) imports[spec] = dataUri;
  return { imports, report };
}
