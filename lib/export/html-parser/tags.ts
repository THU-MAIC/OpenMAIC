export const childlessTags = ['style', 'script', 'template'];

export const closingTags = [
  'html',
  'head',
  'body',
  'p',
  'dt',
  'dd',
  'li',
  'option',
  'thead',
  'th',
  'tbody',
  'tr',
  'td',
  'tfoot',
  'colgroup',
];

export const closingTagAncestorBreakers: Record<string, string[]> = {
  li: ['ul', 'ol', 'menu'],
  dt: ['dl'],
  dd: ['dl'],
  tbody: ['table'],
  thead: ['table'],
  tfoot: ['table'],
  tr: ['table'],
  td: ['table'],
};

export const voidTags = [
  '!doctype',
  'area',
  'base',
  'br',
  'col',
  'command',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
];
