/** Controlled faults, distinct from naturally occurring model errors. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateSceneContent } from '@openmaic/generation';
import { shapeToTextFallback } from '@openmaic/geometry';
import { SlideCanvas } from '../../packages/@openmaic/renderer/dist/SlideCanvas.js';

const source = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const output = resolve(process.argv[3] || 'eval/svg-validator/results/faults');
mkdirSync(output, { recursive: true });
const baseline = source.content.elements.find((element) => element.type === 'shape');
const faults = [
  ['after-close', { path: 'M 0 0 Z 1 1' }],
  ['incomplete', { path: 'M 0 0 L 1' }],
  ['markup', { path: '<path d="M 0 0" />' }],
  ['overflow', { path: 'M 0 0 L 1e999 1' }],
  ['zero-viewbox', { viewBox: [0, 100] }],
  ['zero-width', { width: 0 }],
  ['negative-height', { height: -10 }],
  ['path-type', { path: 42 }],
  ['viewbox-type', { viewBox: '100 100' }],
  ['no-label', { path: 'M 0 0 Z 1 1', text: undefined }],
  ['empty-label', { path: 'M 0 0 Z 1 1', text: { content: '<p><br></p>' } }],
  ['white-label-dark-fill', { path: 'M 0 0 Z 1 1', fill: '#14243c' }],
  [
    'rotated-bottom-label',
    {
      path: 'M 0 0 Z 1 1',
      rotate: 25,
      text: {
        content: '<p style="font-size:20px;color:white">保留的文字</p>',
        defaultColor: '#fff',
        align: 'bottom',
      },
    },
  ],
];
const records = [];
const canvas = (elements) => ({ ...source.scene.content.canvas, elements });
for (const [id, mutation] of faults) {
  const shape = {
    ...baseline,
    id,
    left: 180,
    top: 120,
    width: 280,
    height: 160,
    fill: '#14243c',
    text: {
      content: '<p style="font-size:20px">保留的文字</p>',
      defaultColor: '#ffffff',
      align: 'middle',
    },
    ...mutation,
  };
  const fallback = shapeToTextFallback(shape);
  const content = await generateSceneContent(
    { id, title: id, type: 'slide', order: 1, description: '', keyPoints: [] },
    async () => JSON.stringify({ elements: [shape] }),
  );
  assert.equal(content.elements.length, fallback ? 1 : 0, id);
  if (fallback) {
    assert.equal(content.elements[0].type, 'text', id);
    for (const field of [
      'content',
      'left',
      'top',
      'width',
      'height',
      'rotate',
      'vAlign',
      'fill',
      'defaultColor',
    ])
      assert.deepEqual(content.elements[0][field], fallback[field], `${id}: ${field}`);
  }
  const generated = renderToStaticMarkup(
    createElement(SlideCanvas, { slide: canvas(content.elements), scale: 1, chrome: false }),
  );
  const historical = renderToStaticMarkup(
    createElement(SlideCanvas, { slide: canvas([shape]), scale: 1, chrome: false }),
  );
  const record = {
    id,
    expectedText: !!fallback,
    content,
    shape,
    canvas: canvas(content.elements),
    historyCanvas: canvas([shape]),
  };
  records.push(record);
  writeFileSync(
    join(output, id + '.html'),
    `<!doctype html><meta charset="utf-8"><title>${id}</title><style>body{font:16px system-ui;background:#eee}.row{display:flex;gap:20px}.frame{width:500px;height:282px;overflow:hidden;background:white}.slide{width:1000px;height:562.5px;transform:scale(.5);transform-origin:top left}</style><h1>受控故障：${id}</h1><div class="row"><section><h2>新生成</h2><div id="generated" class="frame"><div class="slide">${generated}</div></div></section><section><h2>历史记录</h2><div id="history" class="frame"><div class="slide">${historical}</div></div></section></div>`,
  );
}
writeFileSync(join(output, 'summary.json'), JSON.stringify(records, null, 2));
console.log(JSON.stringify({ controlledFaults: records.length, passed: records.length, output }));
