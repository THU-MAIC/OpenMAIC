import { expect, it } from 'vitest';
import { minimalCtx, parseTxBody } from './helpers';
import { renderTextBody } from '../src/serializer/textSerializer';

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
it('preserves explicit no-underline settings', () => {
  expect(hyperlinkHtml('u="none"')).not.toContain('text-decoration: underline');
  expect(
    hyperlinkHtml('', '<a:lstStyle><a:lvl1pPr><a:defRPr u="none"/></a:lvl1pPr></a:lstStyle>'),
  ).not.toContain('text-decoration: underline');
});
it('combines default hyperlink underline with strike-through', () => {
  expect(hyperlinkHtml('strike="sngStrike"')).toContain('text-decoration: underline line-through');
});
it('retains hyperlink underline inside editable tab columns', () => {
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('data-pptx-tab-column="true"');
  expect(hyperlinkHtml('', '', '链接\t下一列')).toContain('text-decoration: underline');
});
