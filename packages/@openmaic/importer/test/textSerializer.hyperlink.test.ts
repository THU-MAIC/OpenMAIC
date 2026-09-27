import { describe, expect, it } from 'vitest';
import { minimalCtx, parseTxBody } from './helpers';
import { renderTextBody } from '../src/serializer/textSerializer';
const render = (
  props = '',
  text = 'https://example.com',
  mode = '',
  namespace = 'http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor',
) => {
  const ctx = minimalCtx();
  ctx.theme.colorScheme.set('hlink', '4472C4');
  ctx.theme.colorScheme.set('dk1', '000000');
  ctx.slide.rels.set('rId2', {
    type: 'hyperlink',
    target: 'https://example.com',
    targetMode: 'External',
  });
  return renderTextBody(
    parseTxBody(
      `<a:p><a:r><a:rPr ${props.includes('u=') ? 'u="none"' : ''}><a:solidFill>${props.includes('custom') ? '<a:srgbClr val="FF0000"/>' : '<a:schemeClr val="tx1"/>'}</a:solidFill><a:hlinkClick id="rId2">${mode ? `<a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"><h:hlinkClr xmlns:h="${namespace}" val="${mode}"/></a:ext></a:extLst>` : ''}</a:hlinkClick></a:rPr><a:t>${text}</a:t></a:r></a:p>`,
    ),
    undefined,
    ctx,
  );
};
describe('hyperlink presentation defaults', () => {
  it('uses hyperlink theme color for ordinary text-theme fill', () =>
    expect(render()).toContain('color: #4472C4'));
  it('emits an explicit underline independent of browser reset styles', () =>
    expect(render()).toContain('text-decoration: underline'));
  it('uses theme color for RGB text without a keep-text-color extension', () =>
    expect(render('custom')).toContain('color: #4472C4'));
  it('preserves RGB text color when hlinkClr explicitly selects tx', () =>
    expect(render('custom', '保留红色链接', 'tx')).toContain('color: #FF0000'));
  it('uses theme color when hlinkClr selects hlink', () =>
    expect(render('custom', '链接', 'hlink')).toContain('color: #4472C4'));
  it('ignores similarly named extensions from unrelated namespaces', () =>
    expect(render('custom', '链接', 'tx', 'urn:unrelated')).toContain('color: #4472C4'));
  it('renders hyperlink underline independently of ordinary u=none', () =>
    expect(render('custom u=none', '保留红色链接')).toContain('text-decoration: underline'));
});

it('uses link semantics rather than matching the visible label to the URL', () => {
  expect(render('', '下一页')).toContain('color: #4472C4');
  expect(render('', '下一页', 'tx')).toContain('color: #000000');
});

function hyperlinkHtml(properties = '', prefix = '', text = '海龟编辑器 (codemao.cn)') {
  const ctx = minimalCtx();
  ctx.slide.rels.set('rId6', {
    type: 'hyperlink',
    target: 'https://turtle.codemao.cn/editor/python_web/242157784',
    targetMode: 'External',
  });
  return renderTextBody(
    parseTxBody(`${prefix}<a:p><a:r><a:rPr ${properties}>
    <a:hlinkClick id="rId6"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`),
    undefined,
    ctx,
  );
}

it('makes implicit hyperlink underlining explicit so slide CSS resets cannot remove it', () => {
  expect(hyperlinkHtml()).toContain('text-decoration: underline');
});
it('keeps hyperlink underline despite run or inherited u=none', () => {
  expect(hyperlinkHtml('u="none"')).toContain('text-decoration: underline');
  expect(
    hyperlinkHtml('', '<a:lstStyle><a:lvl1pPr><a:defRPr u="none"/></a:lvl1pPr></a:lstStyle>'),
  ).toContain('text-decoration: underline');
});
it('combines default hyperlink underline with strike-through', () => {
  expect(hyperlinkHtml('strike="sngStrike"')).toContain('text-decoration: underline line-through');
});
it('retains hyperlink underline inside editable tab columns', () => {
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('data-pptx-tab-column="true"');
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('text-decoration: underline');
});

it('does not apply link styling to ordinary text with u=none', () => {
  const ctx = minimalCtx();
  ctx.theme.colorScheme.set('hlink', '4472C4');
  const html = renderTextBody(
    parseTxBody(
      '<a:p><a:r><a:rPr u="none"><a:solidFill><a:srgbClr val="C64545"/></a:solidFill></a:rPr><a:t>普通红色文字</a:t></a:r></a:p>',
    ),
    undefined,
    ctx,
  );
  expect(html).toContain('color: #C64545');
  expect(html).not.toContain('text-decoration: underline');
});

it.each(['r', 'ns1'])('resolves hyperlink relationship IDs with the %s prefix', (prefix) => {
  const ctx = minimalCtx();
  ctx.theme.colorScheme.set('hlink', '2878BC');
  ctx.slide.rels.set('rIdNamed', {
    type: 'hyperlink',
    target: 'https://example.org/garden',
    targetMode: 'External',
  });
  const html = renderTextBody(
    parseTxBody(`<a:p><a:r><a:rPr u="none">
    <a:solidFill><a:srgbClr val="C64545"/></a:solidFill>
    <a:hlinkClick xmlns:${prefix}="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${prefix}:id="rIdNamed"/>
    </a:rPr><a:t>普通名称链接</a:t></a:r></a:p>`),
    undefined,
    ctx,
  );
  expect(html).toContain('href="https://example.org/garden"');
  expect(html).toContain('color: #2878BC');
  expect(html).toContain('text-decoration: underline');
});
