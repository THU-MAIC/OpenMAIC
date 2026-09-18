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
  const match = attributes.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase().split(';', 1)[0]!;
}

function isClassicInlineScript(attributes: string): boolean {
  if (/\bsrc\s*=/i.test(attributes)) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(scriptType(attributes));
}

/**
 * Compile-check classic inline scripts without executing them.
 *
 * Generated interactive HTML can still render its DOM/CSS when an inline
 * script contains a syntax error, leaving controls visible but inert. Reject
 * that output before it is persisted so the existing invalid-model-output
 * recovery path can retry instead of shipping a dead widget.
 *
 * Data scripts (for example widget-config JSON), external scripts, and module
 * scripts are intentionally skipped: they are not classic-script Function
 * bodies and validating them here would produce false positives.
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
      // Function construction parses the body but does not execute it.
      Function(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { scriptIndex, message };
    }
  }

  return null;
}
