import { describe, expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';

const run = (text: string) =>
  `<a:r><a:rPr sz="2400"><a:latin typeface="PingFang SC"/><a:ea typeface="PingFang SC"/></a:rPr><a:t>${text}</a:t></a:r>`;
const para = (runs: string, props = '') => `<a:p><a:pPr ${props}/>${runs}</a:p>`;
const label = para(run('负责团队：城市花园志愿队'));
const render = (xml: string) => renderTxBodyHtml(xml, undefined, { frameWidthPx: 880 });

describe('literal leading spaces instead of inferred label alignment', () => {
  it.each([false, true])('preserves ten spaces with split runs: %s', (split) => {
    const continuation = (text: string) =>
      para(split ? run('          ') + run(text) : run('          ' + text));
    const html = render(label + continuation('苗圃维护小组') + continuation('雨水收集小组'));
    expect(html).not.toContain('margin-left: 120pt');
    expect(html).not.toMatch(/width:[\d.]+em/);
    expect(html.split('\u00a0'.repeat(10))).toHaveLength(3);
  });

  it('retains literal spaces for ordinary text without a label', () => {
    const html = render(para(run('    普通文字')));
    expect(html).toContain('\u00a0'.repeat(4));
    expect(html).not.toContain('width:1.00em');
  });

  it('keeps explicit paragraph indentation in addition to literal spaces', () => {
    const html = render(para(run('          苗圃维护小组'), 'marL="190500" indent="95250"'));
    expect(html).toContain('margin-left: 20px');
    expect(html).toContain('text-indent: 10px');
    expect(html).toContain('\u00a0'.repeat(10));
  });
});
