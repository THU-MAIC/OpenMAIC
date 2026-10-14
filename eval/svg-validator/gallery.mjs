/** Rebuild the gallery from saved outputs without repeating model requests. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeElement } from '@openmaic/dsl';
import { parseJsonResponse } from '@openmaic/generation';
import { SlideCanvas } from '../../packages/@openmaic/renderer/dist/SlideCanvas.js';

const root = resolve('eval/svg-validator/results');
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const links = [],
  records = [];
for (const file of walk(root).filter(
  (file) => file.endsWith('.json') && !file.includes('/browser/'),
)) {
  const sample = JSON.parse(readFileSync(file, 'utf8'));
  if (!sample.record || !sample.scene) continue;
  const slide = sample.scene.content.canvas;
  const raw = parseJsonResponse(readFileSync(file.replace(/\.json$/, '.raw.txt'), 'utf8'));
  sample.normalizedHistory = (raw.elements || []).flatMap((element, index) => {
    try {
      return [{ ...normalizeElement(element), id: 'history-' + index }];
    } catch {
      return element?.type === 'shape' ? [{ ...element, id: 'history-' + index }] : [];
    }
  });
  let latexIndex = 0;
  const latex = sample.content.elements.filter((element) => element.type === 'latex');
  sample.normalizedHistory = sample.normalizedHistory.map((element) =>
    element.type === 'latex' && latex[latexIndex]
      ? { ...latex[latexIndex++], id: element.id }
      : element,
  );
  writeFileSync(file, JSON.stringify(sample, null, 2));
  const generated = renderToStaticMarkup(
    createElement(SlideCanvas, { slide, scale: 1, chrome: false }),
  );
  const history = renderToStaticMarkup(
    createElement(SlideCanvas, {
      slide: { ...slide, elements: sample.normalizedHistory },
      scale: 1,
      chrome: false,
    }),
  );
  const title = sample.record.model + ' · ' + sample.record.case;
  writeFileSync(
    file.replace(/\.json$/, '.html'),
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><style>body{padding:24px;margin:0;font:16px system-ui;background:#eef2f6}.row{display:flex;gap:24px}.frame{width:600px;height:338px;overflow:hidden;background:white}.slide{width:1000px;height:562.5px;transform:scale(.6);transform-origin:top left}pre{white-space:pre-wrap}</style><h1>${escape(title)}</h1><div class="row"><section><h2>生成后处理</h2><div id="generated" class="frame"><div class="slide">${generated}</div></div></section><section><h2>历史 shape 渲染（公式已补齐 HTML）</h2><div id="history" class="frame"><div class="slide">${history}</div></div></section></div><details><summary>请求、验证与耗时</summary><pre>${escape(JSON.stringify(sample.record, null, 2))}</pre></details>`,
  );
  links.push({ title, path: relative(root, file).replace(/\.json$/, '.html') });
  records.push(sample.record);
}
for (const file of walk(join(root, 'faults')).filter((file) => file.endsWith('.html')))
  links.push({ title: '受控故障 · ' + file.split('/').at(-1), path: relative(root, file) });
writeFileSync(
  join(root, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>SVG regression</title><style>body{font:18px system-ui;max-width:1000px;margin:32px auto}li{margin:12px}</style><h1>轻量模型 SVG 回归</h1><p>真实模型生成与受控故障分开记录。语法合法不保证教学内容正确。</p><ul>${links.map((link) => `<li><a href="${link.path}">${escape(link.title)}</a></li>`).join('')}</ul>`,
);
writeFileSync(join(root, 'combined-generated.json'), JSON.stringify(records, null, 2));
console.log(JSON.stringify({ generatedSlides: records.length, galleryPages: links.length }));
