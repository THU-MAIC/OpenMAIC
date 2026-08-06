import { toDataUri, type InlineReport } from './inline-assets-shared';

// Matches: import ... from 'X'  |  import 'X'  |  export ... from 'X'  |  import('X')
const IMPORT_SPEC_RE =
  /(?:\bimport\b[\s\S]*?\bfrom\b|\bexport\b[\s\S]*?\bfrom\b|\bimport)\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

export function extractSpecifiers(code: string): string[] {
  const specs = new Set<string>();
  for (const m of code.matchAll(IMPORT_SPEC_RE)) {
    const s = m[1] ?? m[2];
    if (s) specs.add(s);
  }
  return [...specs];
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
    const matches = [...code.matchAll(IMPORT_SPEC_RE)];
    const replacements: string[] = [];
    for (const match of matches) {
      const spec = match[1] ?? match[2];
      if (!spec || resolveSpecifier(spec, originalImports)) {
        replacements.push(match[0]);
        continue;
      }
      const absUrl = resolveExternal(spec, baseUrl);
      if (!absUrl || stack.has(absUrl)) {
        replacements.push(match[0]);
        continue;
      }
      const got = await fetchAsset(absUrl);
      if (!got) {
        if (!report.failed.some((failure) => failure.url === absUrl)) {
          report.failed.push({ url: absUrl, reason: 'fetch failed' });
        }
        replacements.push(match[0]);
        continue;
      }
      if (!report.inlined.includes(absUrl)) report.inlined.push(absUrl);
      const nestedStack = new Set(stack).add(absUrl);
      const nestedCode = await inlineModuleDependencies(
        new TextDecoder().decode(got.bytes),
        absUrl,
        nestedStack,
      );
      const dataUri = toDataUri(new TextEncoder().encode(nestedCode), got.contentType);
      replacements.push(match[0].replace(spec, dataUri));
    }
    let out = '';
    let last = 0;
    matches.forEach((match, index) => {
      out += code.slice(last, match.index!) + replacements[index];
      last = match.index! + match[0].length;
    });
    return out + code.slice(last);
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
