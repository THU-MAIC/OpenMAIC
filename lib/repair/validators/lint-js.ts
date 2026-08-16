import type { ValidationLayer } from '../types';

function extractScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0);
}

export async function lintEmbeddedJs(html: string): Promise<ValidationLayer> {
  // This validator emits only 'pass' or 'fail' states (no 'warn').
  const messages: string[] = [];
  for (const [i, code] of extractScripts(html).entries()) {
    try {
      // Parse-only: Function constructor throws SyntaxError on invalid JS without executing.
      // Note: script[i] indexes extraction order, not document line number.
      new Function(code);
    } catch (e) {
      messages.push(`script[${i}]: ${(e as Error).message}`);
    }
  }
  return { name: 'lint-js', status: messages.length ? 'fail' : 'pass', messages };
}
