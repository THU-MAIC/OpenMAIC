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
  moduleScriptBodies: string[],
  fetchAsset: (url: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>,
): Promise<{ imports: Record<string, string>; report: InlineReport }> {
  const report: InlineReport = { inlined: [], failed: [] };
  const resolvedDataUri = new Map<string, string>(); // specifier -> data: URI
  const visited = new Set<string>();

  async function visitSpecifier(spec: string): Promise<void> {
    if (visited.has(spec)) return;
    visited.add(spec);
    const absUrl = resolveSpecifier(spec, originalImports);
    if (!absUrl) return; // not mapped (relative/bare-unmapped) — leave to browser
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
    const code = new TextDecoder().decode(got.bytes);
    for (const childSpec of extractSpecifiers(code)) {
      await visitSpecifier(childSpec);
    }
  }

  for (const body of moduleScriptBodies) {
    for (const spec of extractSpecifiers(body)) await visitSpecifier(spec);
  }

  const imports: Record<string, string> = {};
  for (const [spec, dataUri] of resolvedDataUri) imports[spec] = dataUri;
  return { imports, report };
}
