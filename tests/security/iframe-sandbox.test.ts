/**
 * Verify that iframes rendering inline HTML (srcDoc) never combine
 * `allow-scripts` with `allow-same-origin` in their sandbox attribute.
 *
 * Per the HTML spec, the combination of allow-scripts + allow-same-origin on a
 * srcDoc iframe effectively negates the sandbox — the embedded document is
 * treated as same-origin with the parent, so any script inside can reach the
 * parent's cookies, localStorage, and DOM.
 *
 * This test reads the source files that render interactive iframes and asserts
 * their sandbox strings never include both tokens simultaneously.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Extract all `sandbox="..."` attribute values from a source file. */
function extractSandboxValues(filePath: string): string[] {
  const src = readFileSync(resolve(__dirname, '../../', filePath), 'utf-8');
  const matches = [...src.matchAll(/sandbox=["'`]([^"'`]+)["'`]/g)];
  return matches.map((m) => m[1]);
}

/**
 * Returns true if the sandbox value is dangerous for srcDoc content:
 * both allow-scripts AND allow-same-origin present.
 */
function isDangerousSandbox(sandbox: string): boolean {
  const tokens = sandbox.split(/\s+/);
  return tokens.includes('allow-scripts') && tokens.includes('allow-same-origin');
}

describe('iframe sandbox safety', () => {
  test('InteractiveIframeHost does not combine allow-scripts + allow-same-origin', () => {
    const sandboxes = extractSandboxValues('components/scene-renderers/InteractiveIframeHost.tsx');
    expect(sandboxes.length).toBeGreaterThan(0);
    for (const sandbox of sandboxes) {
      expect(isDangerousSandbox(sandbox)).toBe(false);
    }
  });

  test('ThumbnailInteractive does not combine allow-scripts + allow-same-origin', () => {
    const sandboxes = extractSandboxValues(
      'components/slide-renderer/components/ThumbnailInteractive/index.tsx',
    );
    expect(sandboxes.length).toBeGreaterThan(0);
    for (const sandbox of sandboxes) {
      expect(isDangerousSandbox(sandbox)).toBe(false);
    }
  });
});
