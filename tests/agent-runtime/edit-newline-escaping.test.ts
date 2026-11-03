import { describe, expect, it } from 'vitest';
import { applyStrReplace } from '@/lib/server/agent-runtime/course-edit/apply';

describe('agent edit newline escaping', () => {
  it('rejects an escaped anchor with an actionable hint, then accepts the exact source', () => {
    const html = 'const starterCode = `print("hello")\nprint("hello")\n`;';
    const source = { content: { html } };
    const failed = applyStrReplace(source, {
      path: '/content/html',
      oldText: html.replaceAll('\n', '\\n'),
      newText: 'replacement',
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('Expected escaped anchor to be rejected');
    expect(failed.error).toContain('literal backslash+n');
    expect(failed.error).toContain('decoded string value');
    expect(source.content.html).toBe(html);
    const retried = applyStrReplace(source, {
      path: '/content/html',
      oldText: html,
      newText: 'replacement',
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error(retried.error);
    expect(retried.value.content.html).toBe('replacement');
  });

  it('keeps literal backslash+n code exact rather than converting it automatically', () => {
    const source = { html: 'split("\\n")' };
    const result = applyStrReplace(source, {
      path: '/html',
      oldText: 'split("\n")',
      newText: 'replacement',
    });
    expect(result.ok).toBe(false);
    expect(source.html).toBe('split("\\n")');
  });
});
