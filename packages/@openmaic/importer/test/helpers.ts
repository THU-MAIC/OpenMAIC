/**
 * 解析层（XML → 画布 HTML）单测的共享脚手架。
 *
 * 这一层是纯函数管线：txBody XML → parseTextBody → renderTextBody → HTML 字符串。
 * helper 负责两件事：
 *   1) 把一段 OOXML 文本片段包成带命名空间的 <p:txBody> 再解析成 TextBody；
 *   2) 造一个 renderTextBody 够用的最小 RenderContext（master/layout/theme 全给空兜底）。
 */

import { parseXml, SafeXmlNode } from '../src/parser/XmlParser';
import { parseTextBody, type TextBody } from '../src/model/nodes/ShapeNode';
import { renderTextBody, type RenderTextBodyOptions } from '../src/serializer/textSerializer';
import type { RenderContext } from '../src/serializer/RenderContext';
import type { PlaceholderInfo } from '../src/model/nodes/BaseNode';

const OOXML_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

/**
 * 把 txBody 内部 XML（bodyPr / lstStyle / 若干 a:p）包成完整 <p:txBody> 并解析。
 * 直接传 `<a:p>…</a:p>` 即可，命名空间由这里统一注入。
 */
export function parseTxBody(innerXml: string): TextBody {
  const node = parseXml(`<p:txBody ${OOXML_NS}>${innerXml}</p:txBody>`);
  const tb = parseTextBody(node);
  if (!tb) throw new Error('parseTextBody 返回空——检查 txBody XML 是否合法');
  return tb;
}

/**
 * renderTextBody 够用的最小 RenderContext。只填序列化器真正会读的字段，
 * 其余用空 Map / 空节点兜底（createRenderContext 的默认值同款）。
 */
export function minimalCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  const empty = new SafeXmlNode(null);
  const ctx = {
    presentation: {} as RenderContext['presentation'],
    slide: { index: 0, rels: new Map() } as unknown as RenderContext['slide'],
    theme: {
      colorScheme: new Map(),
      majorFont: { latin: '', ea: '', cs: '', hans: '' },
      minorFont: { latin: '', ea: '', cs: '', hans: '' },
      fillStyles: [],
      lineStyles: [],
      effectStyles: [],
    } as unknown as RenderContext['theme'],
    master: {
      defaultTextStyle: empty,
      textStyles: {},
      placeholders: [],
      colorMap: new Map(),
      spTree: empty,
      rels: new Map(),
    } as unknown as RenderContext['master'],
    layout: {
      placeholders: [],
      spTree: empty,
      rels: new Map(),
      showMasterSp: true,
    } as unknown as RenderContext['layout'],
    layoutPath: '',
    masterPath: '',
    mediaUrlCache: new Map(),
    colorCache: new Map(),
    mediaMode: 'base64' as const,
    ...overrides,
  };
  return ctx as RenderContext;
}

/** 一步到位：文本片段 XML → 渲染出的 HTML 字符串。 */
export function renderTxBodyHtml(
  innerXml: string,
  placeholder?: PlaceholderInfo,
  options?: RenderTextBodyOptions,
): string {
  return renderTextBody(parseTxBody(innerXml), placeholder, minimalCtx(), options);
}
