export interface InteractiveScriptSyntaxFailure {
  readonly scriptIndex: number;
  readonly message: string;
}

const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

function scriptType(attributes: string): string {
  const match = attributes.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase();
  // MIME parameters (`text/javascript; charset=utf-8`) are not part of the type.
  return raw.split(';', 1)[0]!.trim();
}

function isClassicInlineScript(attributes: string): boolean {
  if (/\bsrc\s*=/i.test(attributes)) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(scriptType(attributes));
}

/**
 * Compile-check classic inline scripts without executing them.
 *
 * Data scripts, external scripts, and module scripts are skipped: they are
 * not classic `Function` bodies, and checking them here would reject valid
 * widgets (JSON config fails classic parse; `import` is module grammar).
 * `scriptIndex` counts every `<script>` tag, including the ones skipped.
 */
export function findInteractiveScriptSyntaxFailure(
  html: string,
): InteractiveScriptSyntaxFailure | null {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let scriptIndex = 0;

  for (const match of html.matchAll(scriptPattern)) {
    scriptIndex += 1;
    const attributes = match[1] ?? '';
    const source = match[2] ?? '';
    if (!isClassicInlineScript(attributes) || !source.trim()) continue;

    try {
      // Parse only. The constructed function is never called.
      new Function(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { scriptIndex, message };
    }
  }

  return null;
}
