import { extractSpecifiers } from './inline-assets-importmap';
import { collectCssAssetReferences } from './css-asset-parser';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import parseSrcset from 'parse-srcset';

export type AssetRefKind =
  | 'link'
  | 'script'
  | 'img'
  | 'srcset'
  | 'poster'
  | 'iframe-src'
  | 'iframe-srcdoc'
  | 'object-data'
  | 'embed-src'
  | 'source'
  | 'video'
  | 'audio'
  | 'svg-image'
  | 'svg-use'
  | 'css-url'
  | 'css-import'
  | 'module-import'
  | 'base'
  | 'importmap';

export interface AssetRef {
  kind: AssetRefKind;
  url: string;
}

export interface SourceRange {
  start: number;
  end: number;
}

export interface SourcePatch {
  range: SourceRange;
  replacement: string;
}

export interface HtmlAttributeAsset extends AssetRef {
  tagName: string;
  attributeName: string;
  attributes: Readonly<Record<string, string>>;
  attributeRange?: SourceRange;
  elementRange?: SourceRange;
}

export interface HtmlTextElement {
  tagName: 'script' | 'style';
  attributes: Readonly<Record<string, string>>;
  content: string;
  contentRange?: SourceRange;
  elementRange?: SourceRange;
}

export interface HtmlAssetInventory {
  attributeAssets: HtmlAttributeAsset[];
  moduleScripts: HtmlTextElement[];
  importmaps: HtmlTextElement[];
  styles: HtmlTextElement[];
  styleAttributes: Array<{ css: string; range?: SourceRange }>;
  svgPresentationAttributes: Array<{
    attributeName: string;
    cssValue: string;
    range?: SourceRange;
  }>;
}

export function applySourcePatches(html: string, patches: readonly SourcePatch[]): string {
  const ordered = [...patches].sort((left, right) => right.range.start - left.range.start);
  let previousStart = html.length;
  let result = html;
  for (const patch of ordered) {
    if (
      patch.range.start < 0 ||
      patch.range.end < patch.range.start ||
      patch.range.end > html.length ||
      patch.range.end > previousStart
    ) {
      throw new Error('overlapping-or-invalid-html-source-patch');
    }
    result = result.slice(0, patch.range.start) + patch.replacement + result.slice(patch.range.end);
    previousStart = patch.range.start;
  }
  return result;
}

export function replaceAttributePatch(
  asset: HtmlAttributeAsset,
  value: string,
): SourcePatch | null {
  return replaceAttributeRangePatch(asset.attributeName, asset.attributeRange, value);
}

export function replaceAttributeRangePatch(
  attributeName: string,
  range: SourceRange | undefined,
  value: string,
): SourcePatch | null {
  if (!range) return null;
  const escaped = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return {
    range,
    replacement: `${attributeName}="${escaped}"`,
  };
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_URL_PRESENTATION_ATTRIBUTES = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

function isTemplate(
  element: DefaultTreeAdapterTypes.Element,
): element is DefaultTreeAdapterTypes.Template {
  return element.tagName === 'template' && 'content' in element;
}

function sourceRange(location: { startOffset: number; endOffset: number } | null | undefined) {
  return location ? { start: location.startOffset, end: location.endOffset } : undefined;
}

function attributeName(attribute: DefaultTreeAdapterTypes.Element['attrs'][number]): string {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
}

function attributesOf(element: DefaultTreeAdapterTypes.Element): Record<string, string> {
  return Object.fromEntries(
    element.attrs.map((attribute) => [attributeName(attribute), attribute.value]),
  );
}

function textElement(
  html: string,
  element: DefaultTreeAdapterTypes.Element,
): HtmlTextElement | null {
  if (element.tagName !== 'script' && element.tagName !== 'style') return null;
  const location = element.sourceCodeLocation;
  const start = location?.startTag?.endOffset;
  const end = location?.endTag?.startOffset;
  return {
    tagName: element.tagName,
    attributes: attributesOf(element),
    content: start !== undefined && end !== undefined ? html.slice(start, end) : '',
    contentRange: start !== undefined && end !== undefined ? { start, end } : undefined,
    elementRange: sourceRange(location),
  };
}

function attributeRange(
  element: DefaultTreeAdapterTypes.Element,
  attribute: DefaultTreeAdapterTypes.Element['attrs'][number],
): SourceRange | undefined {
  const locations = element.sourceCodeLocation?.attrs;
  return sourceRange(locations?.[attributeName(attribute)] ?? locations?.[attribute.name]);
}

export function analyzeHtmlAssetInventory(html: string): HtmlAssetInventory {
  const inventory: HtmlAssetInventory = {
    attributeAssets: [],
    moduleScripts: [],
    importmaps: [],
    styles: [],
    styleAttributes: [],
    svgPresentationAttributes: [],
  };
  const document = parse(html, { sourceCodeLocationInfo: true });

  const visit = (element: DefaultTreeAdapterTypes.Element) => {
    const attrs = attributesOf(element);
    const type = attrs.type?.trim().toLowerCase();
    const addAttribute = (kind: AssetRefKind, name: string) => {
      const attribute = element.attrs.find((candidate) => attributeName(candidate) === name);
      if (!attribute?.value.trim()) return;
      inventory.attributeAssets.push({
        kind,
        url: attribute.value,
        tagName: element.tagName,
        attributeName: name,
        attributes: attrs,
        attributeRange: attributeRange(element, attribute),
        elementRange: sourceRange(element.sourceCodeLocation),
      });
    };

    if (element.tagName === 'base') addAttribute('base', 'href');
    if (element.tagName === 'link') addAttribute('link', 'href');
    if (element.tagName === 'script' && type !== 'importmap' && type !== 'application/json') {
      addAttribute('script', 'src');
    }
    if (element.tagName === 'img') {
      addAttribute('img', 'src');
      addAttribute('srcset', 'srcset');
    }
    if (element.tagName === 'source') {
      addAttribute('source', 'src');
      addAttribute('srcset', 'srcset');
    }
    if (element.tagName === 'video') {
      addAttribute('video', 'src');
      addAttribute('poster', 'poster');
    }
    if (element.tagName === 'audio') addAttribute('audio', 'src');
    if (element.tagName === 'iframe') {
      addAttribute('iframe-src', 'src');
      addAttribute('iframe-srcdoc', 'srcdoc');
    }
    if (element.tagName === 'object') addAttribute('object-data', 'data');
    if (element.tagName === 'embed') addAttribute('embed-src', 'src');
    if (element.namespaceURI === SVG_NAMESPACE && element.tagName === 'image') {
      addAttribute('svg-image', attrs.href !== undefined ? 'href' : 'xlink:href');
    }
    if (element.namespaceURI === SVG_NAMESPACE && element.tagName === 'use') {
      addAttribute('svg-use', attrs.href !== undefined ? 'href' : 'xlink:href');
    }

    const styleAttribute = element.attrs.find((attribute) => attribute.name === 'style');
    if (styleAttribute) {
      inventory.styleAttributes.push({
        css: styleAttribute.value,
        range: attributeRange(element, styleAttribute),
      });
    }
    if (element.namespaceURI === SVG_NAMESPACE) {
      for (const attribute of element.attrs) {
        if (!SVG_URL_PRESENTATION_ATTRIBUTES.has(attribute.name)) continue;
        inventory.svgPresentationAttributes.push({
          attributeName: attribute.name,
          cssValue: attribute.value,
          range: attributeRange(element, attribute),
        });
      }
    }

    const text = textElement(html, element);
    if (text?.tagName === 'style') inventory.styles.push(text);
    if (text?.tagName === 'script' && type === 'module') inventory.moduleScripts.push(text);
    if (text?.tagName === 'script' && type === 'importmap') inventory.importmaps.push(text);

    for (const child of element.childNodes) if (isElement(child)) visit(child);
    if (isTemplate(element)) {
      for (const child of element.content.childNodes) if (isElement(child)) visit(child);
    }
  };

  for (const child of document.childNodes) if (isElement(child)) visit(child);
  return inventory;
}

/** Compatibility view over the structured inventory. */
export function collectAssetRefs(
  html: string,
  options: { includeRelative?: boolean } = {},
): AssetRef[] {
  const inventory = analyzeHtmlAssetInventory(html);
  const refs: AssetRef[] = [];
  const pushUrl = (kind: AssetRefKind, url: string) => {
    if (kind === 'iframe-srcdoc') {
      refs.push({ kind, url: 'iframe[srcdoc]' });
      return;
    }
    const value = url.trim();
    if (!value) return;
    if (/^(?:data:|blob:)/i.test(value)) {
      if (kind === 'iframe-src' || kind === 'object-data' || kind === 'embed-src') {
        refs.push({ kind, url: value });
      } else if (/^blob:/i.test(value) && options.includeRelative) {
        refs.push({ kind, url: value });
      }
      return;
    }
    if (/^(?:about:|#)/i.test(value)) return;
    if (options.includeRelative || /^https?:\/\//i.test(value)) refs.push({ kind, url: value });
  };

  for (const ref of inventory.attributeAssets) {
    if (ref.kind === 'srcset') {
      for (const candidate of parseSrcset(ref.url)) pushUrl('srcset', candidate.url);
    } else {
      pushUrl(ref.kind, ref.url);
    }
  }
  for (const style of inventory.styles) {
    for (const ref of collectCssAssetReferences(style.content)) pushUrl(ref.kind, ref.url);
  }
  for (const style of inventory.styleAttributes) {
    for (const ref of collectCssAssetReferences(style.css, 'declaration-list')) {
      pushUrl(ref.kind, ref.url);
    }
  }
  for (const attribute of inventory.svgPresentationAttributes) {
    for (const ref of collectCssAssetReferences(
      `${attribute.attributeName}:${attribute.cssValue}`,
      'declaration-list',
    )) {
      pushUrl(ref.kind, ref.url);
    }
  }
  for (const script of inventory.moduleScripts) {
    for (const specifier of extractSpecifiers(script.content)) pushUrl('module-import', specifier);
  }
  for (const importmap of inventory.importmaps) {
    try {
      const imports = (JSON.parse(importmap.content) as { imports?: Record<string, string> })
        .imports;
      for (const value of Object.values(imports ?? {})) pushUrl('importmap', value);
    } catch {
      // Malformed import maps are surfaced by the strict video preparation path.
    }
  }
  return refs;
}
