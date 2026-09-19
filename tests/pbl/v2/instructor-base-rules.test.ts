/**
 * Guard tests for the static Instructor base-rules prompt.
 *
 * These assert that the workspace-reality + external-tool guidance is PRESENT
 * and worded with its key anchors, so it can't silently regress or be dropped.
 * (A prompt can't be unit-tested for model *compliance* — that's an eval/manual
 * concern — but we CAN deterministically guarantee the instruction is in the
 * prompt the Instructor receives, since buildSystemPrompt always prepends these
 * base rules.)
 */
import { describe, expect, it } from 'vitest';
import { loadPBLV2Prompt } from '@/lib/pbl/v2/prompts/loader';

describe('instructor base rules — workspace reality & external tools', () => {
  const rules = loadPBLV2Prompt('instructor-base-rules');

  it('describes the actual workbench layout (roadmap + chat + submission area)', () => {
    expect(rules).toContain('submission area');
    expect(rules).toMatch(/roadmap/i);
  });

  it('states the platform has NO embedded editor / professional tool', () => {
    expect(rules).toContain('NO embedded editor and no embedded professional tool');
    // The concrete hallucination to kill: pretending there is an in-app editor.
    expect(rules).toContain('online editor');
    expect(rules).toMatch(/Never imply this platform has an editor or tool it does not/i);
  });

  it('says tool work happens in the learner\u2019s own external tool, opened by them', () => {
    expect(rules).toContain('their own external tool, which they open themselves');
  });

  it('encodes when to name an external tool: skip ubiquitous office software, flag specialized tools', () => {
    expect(rules).toContain('Ubiquitous office software');
    expect(rules).toMatch(/When to name the external tool/i);
    // A few of the specialized tools must be enumerated as the flag-it bucket.
    for (const tool of ['VS Code', 'Tableau', 'PostgreSQL']) {
      expect(rules).toContain(tool);
    }
  });
});
