import { describe, expect, it } from 'vitest';
import {
  createParserState,
  finalizeParser,
  looksLikeStructuredFragment,
  parseStructuredChunk,
  stripProviderToolCallMarkup,
} from '@/lib/orchestration/stateless-generate';

/** Issue #1652 offline sample (fullwidth-pipe DSML delimiters). */
const DSML_WB_CLEAR = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="action">',
  '<｜｜DSML｜｜ parameter name="name" string="true">wb_clear</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="name" string="true">wb_draw_text</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('');

describe('stripProviderToolCallMarkup', () => {
  it('removes a pure DSML tool-call block', () => {
    expect(stripProviderToolCallMarkup(DSML_WB_CLEAR)).toBe('');
    expect(stripProviderToolCallMarkup(DSML_WB_CLEAR)).not.toContain('wb_clear');
    expect(stripProviderToolCallMarkup(DSML_WB_CLEAR)).not.toMatch(/DSML/i);
  });

  it('keeps prose before DSML markup', () => {
    const input = `先看这道题。${DSML_WB_CLEAR}`;
    expect(stripProviderToolCallMarkup(input)).toBe('先看这道题。');
  });

  it('returns empty string for empty / whitespace input', () => {
    expect(stripProviderToolCallMarkup('')).toBe('');
    expect(stripProviderToolCallMarkup('   \n')).toBe('   \n');
  });

  it('leaves ordinary classroom text unchanged', () => {
    const prose = '我们用对象 {"name":"树"} 表示一棵树。';
    expect(stripProviderToolCallMarkup(prose)).toBe(prose);
  });

  it('also accepts ASCII-pipe DSML delimiters', () => {
    const ascii =
      '<||DSML|| calls><||DSML|| invoke name="action"><||DSML|| parameter name="name" string="true">wb_clear</||DSML|| parameter></||DSML|| invoke></||DSML|| calls>';
    expect(stripProviderToolCallMarkup(ascii)).toBe('');
  });
});

describe('finalizeParser with provider DSML (#1652)', () => {
  it('does not emit DSML as visible text (0 actions)', () => {
    const state = createParserState();
    parseStructuredChunk(DSML_WB_CLEAR, state);
    const result = finalizeParser(state);
    expect(result.actions).toHaveLength(0);
    expect(result.textChunks.join('')).not.toMatch(/DSML/i);
    expect(result.textChunks.join('')).not.toContain('wb_clear');
    expect(result.textChunks.join('').trim()).toBe('');
  });

  it('preserves prose prefix when DSML follows', () => {
    const state = createParserState();
    parseStructuredChunk(`你好，同学们。${DSML_WB_CLEAR}`, state);
    const result = finalizeParser(state);
    expect(result.actions).toHaveLength(0);
    expect(result.textChunks.join('')).toBe('你好，同学们。');
  });

  it('still suppresses JSON-shaped structured fragments', () => {
    const residue = 'type":"text","content":"should not leak"';
    expect(looksLikeStructuredFragment(residue)).toBe(true);
    const state = createParserState();
    parseStructuredChunk(residue, state);
    const result = finalizeParser(state);
    expect(result.textChunks).toHaveLength(0);
    expect(result.actions).toHaveLength(0);
  });

  it('still accepts genuine plain prose', () => {
    const state = createParserState();
    parseStructuredChunk('请打开下一页。', state);
    const result = finalizeParser(state);
    expect(result.textChunks.join('')).toBe('请打开下一页。');
    expect(result.actions).toHaveLength(0);
  });
});
