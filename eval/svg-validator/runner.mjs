/** Real-model SVG regression. Run with: node eval/svg-validator/runner.mjs */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  generateSceneContent,
  generateSceneActions,
  generateSceneOutlinesFromRequirements,
  buildCompleteScene,
  parseJsonResponse,
} from '@openmaic/generation';
import { validateScene, normalizeElement } from '@openmaic/dsl';
import { validateShapeGeometry } from '@openmaic/geometry';
import { SlideCanvas } from '../../packages/@openmaic/renderer/dist/SlideCanvas.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
createRequire(require.resolve('next/package.json'))('@next/env').loadEnvConfig(
  process.env.EVAL_ENV_DIR || root,
  true,
  { info() {}, error() {} },
);
const runDir = resolve(
  process.env.SVG_EVAL_OUTPUT ||
    join(root, 'eval/svg-validator/results', new Date().toISOString().replace(/[:.]/g, '-')),
);
mkdirSync(runDir, { recursive: true });
const models = (
  process.env.SVG_EVAL_MODELS ||
  'OPENAI:gpt-5.6-luna,OPENAI:glm-5.3-flash,DEEPSEEK:deepseek-flash,OPENAI:gemini-3-flash-preview'
)
  .split(',')
  .map((ref) => {
    const colon = ref.indexOf(':');
    return { provider: ref.slice(0, colon), model: ref.slice(colon + 1) };
  });
const repeats = Number(process.env.SVG_EVAL_REPEATS || 2);
const scenarios = [
  {
    id: 'triangles',
    title: '勾股定理面积拼图',
    description:
      '生成一页1000×562.5的中文课件，用四个独立直角三角形围绕中央正方形解释勾股定理的面积证明。三角形用自定义SVG path绘制；每个形状给出正确的viewBox、尺寸和简短形状内文字。边长和面积标签用文字或公式。全部图形可编辑，不使用图片。图形之间的关系要准确。',
    keyPoints: ['四个直角三角形', '中央正方形', '面积关系'],
  },
  {
    id: 'arcs-curves',
    title: '圆弧和连续曲线',
    description:
      '生成一页1000×562.5的中文课件，左侧画椭圆轨道并标出起点、终点、顺逆时针圆弧；右侧画连续的正弦样曲线和坐标轴。优先用SVG A/a、C/S、Q/T和H/V路径，至少包含一条相对路径和科学计数法坐标。图形使用独立shape，配置viewBox与尺寸，开放路径使用透明填充。加上简短文字解释，不使用图片。',
    keyPoints: ['椭圆圆弧', '连续曲线', '相对坐标'],
  },
  {
    id: 'labels-flow',
    title: '细胞膜与物质运输',
    description:
      '生成一页1000×562.5的中文课件，画带有物质进出箭头的细胞膜示意图，以及主动运输/被动运输三个流程节点。使用自定义SVG path、圆角和弧线，不使用图片。节点采用深色填充和白色形状内文字，分别设置顶部、居中或底部文字对齐。布局避免重叠，给出明确的方向关系。',
    keyPoints: ['细胞膜', '方向箭头', '运输流程'],
  },
];
const safeName = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, '-');
const safeHtml = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const canvas = (elements) => ({
  id: 'svg-regression',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: {
    fontName: 'Arial',
    fontColor: '#333333',
    backgroundColor: '#ffffff',
    themeColors: ['#5b9bd5'],
  },
  elements,
  background: { type: 'solid', color: '#ffffff' },
});
function inspectRaw(raw) {
  const parsed = parseJsonResponse(raw);
  const shapes = parsed?.elements?.filter((e) => e?.type === 'shape') || [];
  return shapes.map((shape, index) => {
    try {
      const normalized = normalizeElement(shape);
      const validation = validateShapeGeometry(normalized);
      return { index, validation, label: typeof shape.text?.content === 'string' };
    } catch (error) {
      return {
        index,
        normalizationError: String(error),
        label: typeof shape.text?.content === 'string',
      };
    }
  });
}
async function invoke(spec, system, prompt, metrics, step) {
  const base = process.env[spec.provider + '_BASE_URL'],
    key = process.env[spec.provider + '_API_KEY'];
  if (!base || !key) throw new Error('Missing configured provider ' + spec.provider);
  const started = Date.now();
  const response = await fetch(base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: spec.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      max_tokens: Number(process.env.SVG_EVAL_MAX_TOKENS || 16384),
      stream: false,
      ...(process.env.SVG_EVAL_DISABLE_THINKING === '1' ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(300000),
  });
  const data = await response.json();
  metrics.push({
    step,
    status: response.status,
    requestedModel: spec.model,
    maxTokens: Number(process.env.SVG_EVAL_MAX_TOKENS || 16384),
    requestedThinking:
      process.env.SVG_EVAL_DISABLE_THINKING === '1' ? 'disabled' : 'provider-default',
    returnedModel: data.model || null,
    milliseconds: Date.now() - started,
    usage: data.usage || null,
    finishReason: data.choices?.[0]?.finish_reason || null,
    reasoningCharacters: data.choices?.[0]?.message?.reasoning_content?.length || 0,
  });
  if (!response.ok || typeof data.choices?.[0]?.message?.content !== 'string')
    throw new Error(
      `Model call failed: HTTP ${response.status}, business code ${data.code ?? data.error?.code ?? 'unknown'}`,
    );
  return data.choices[0].message.content;
}
const css =
  'body{margin:0;padding:24px;background:#f1f5f9;font:14px system-ui;color:#172033}h1{font-size:24px}.grid{display:flex;gap:16px}.card{padding:12px;background:white;border-radius:10px}.frame{position:relative;width:500px;height:282px;overflow:hidden;background:white}.slide{position:absolute;inset:0;width:1000px;height:562.5px;transform:scale(.5);transform-origin:top left}.tag{font-size:13px;max-width:490px}pre{white-space:pre-wrap;font-size:12px}';
function htmlPage(title, generatedHtml, historyHtml, record) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${title}</title><style>${css}</style><h1>${title}</h1><div class="grid"><div class="card"><h2>生成后处理 → 真实 SDK 渲染</h2><div class="frame" id="generated"><div class="slide">${generatedHtml}</div></div></div><div class="card"><h2>同份模型输出作为历史记录 → 真实 SDK 渲染</h2><div class="frame" id="history"><div class="slide">${historyHtml}</div></div></div></div><pre id="metrics"></pre><script>document.querySelector('#metrics').textContent=JSON.stringify(${safeHtml(record)},null,2)</script></html>`;
}
const results = [];
async function runModel(spec) {
  const modelDir = join(runDir, safeName(spec.provider + '-' + spec.model));
  mkdirSync(modelDir, { recursive: true });
  const outlineMetrics = [];
  try {
    if (process.env.SVG_EVAL_RESUME === '1' && existsSync(join(modelDir, 'outline.json'))) {
      console.log(JSON.stringify({ model: spec.model, stage: 'outline', status: 'reused' }));
    } else {
      const outline = await generateSceneOutlinesFromRequirements(
        {
          requirement:
            '用中文制作三页矢量图课件，分别讲勾股定理面积证明、椭圆圆弧与连续曲线、细胞膜物质运输。只需要slide，不要互动网页和测验。',
        },
        undefined,
        undefined,
        (system, prompt) => invoke(spec, system, prompt, outlineMetrics, 'outline'),
      );
      writeFileSync(
        join(modelDir, 'outline.json'),
        JSON.stringify({ outline, metrics: outlineMetrics }, null, 2),
      );
      console.log(
        JSON.stringify({
          model: spec.model,
          stage: 'outline',
          success: outline.success,
          count: outline.data?.outlines?.length || 0,
        }),
      );
    }
  } catch (error) {
    writeFileSync(
      join(modelDir, 'outline.json'),
      JSON.stringify({ error: String(error), metrics: outlineMetrics }, null, 2),
    );
  }
  for (let repetition = 1; repetition <= repeats; repetition++)
    for (const scenario of scenarios) {
      const id = scenario.id + '-' + repetition;
      const existing = join(modelDir, id + '.json');
      if (process.env.SVG_EVAL_RESUME === '1' && existsSync(existing)) {
        const previous = JSON.parse(readFileSync(existing, 'utf8'));
        if (previous.record?.status === 'generated') {
          results.push({
            ...previous.record,
            relativePage: safeName(spec.provider + '-' + spec.model) + '/' + id + '.html',
          });
          continue;
        }
      }
      const metrics = [],
        warnings = [];
      let raw = '';
      const logger = {
        debug() {},
        info() {},
        warn(message) {
          warnings.push(String(message));
        },
        error(message) {
          warnings.push(String(message));
        },
      };
      const started = Date.now();
      console.log(JSON.stringify({ model: spec.model, case: id, status: 'started' }));
      try {
        const outline = { ...scenario, type: 'slide', order: 1 };
        const content = await generateSceneContent(
          outline,
          async (system, prompt) => {
            raw = await invoke(spec, system, prompt, metrics, 'scene-content');
            return raw;
          },
          { logger, languageDirective: '用简体中文教学。' },
        );
        if (!content?.elements) throw new Error('Production generation returned no slide content');
        const rawValidation = inspectRaw(raw);
        const parsed = parseJsonResponse(raw);
        const normalizedHistory = (parsed?.elements || [])
          .flatMap((element) => {
            try {
              return [normalizeElement(element)];
            } catch {
              return element?.type === 'shape' ? [element] : [];
            }
          })
          .map((element, index) => ({ ...element, id: 'history-' + index }));
        // Saved latex already carries production-generated HTML; preserve that when
        // projecting raw shapes into the historical-rendering comparison.
        let latexIndex = 0;
        const renderedLatex = content.elements.filter((e) => e.type === 'latex');
        for (let i = 0; i < normalizedHistory.length; i++)
          if (normalizedHistory[i].type === 'latex') {
            const rendered = renderedLatex[latexIndex++];
            if (rendered) normalizedHistory[i] = { ...rendered, id: normalizedHistory[i].id };
          }
        const actions =
          scenario.id === 'triangles' && repetition === 1
            ? await generateSceneActions(
                outline,
                content,
                (system, prompt) => invoke(spec, system, prompt, metrics, 'scene-actions'),
                { logger },
              )
            : [];
        const scene = buildCompleteScene(outline, content, actions, 'svg-eval-stage', {
          sceneId: 'svg-eval-' + safeName(spec.model) + '-' + id,
        });
        const sceneValidation = validateScene(scene);
        const generatedHtml = renderToStaticMarkup(
          createElement(SlideCanvas, { slide: canvas(content.elements), scale: 1, chrome: false }),
        );
        const historyHtml = renderToStaticMarkup(
          createElement(SlideCanvas, { slide: canvas(normalizedHistory), scale: 1, chrome: false }),
        );
        const invalid = rawValidation.filter(
          (item) => item.normalizationError || !item.validation.ok,
        );
        const record = {
          model: spec.model,
          provider: spec.provider,
          case: id,
          status: 'generated',
          milliseconds: Date.now() - started,
          rawShapeCount: rawValidation.length,
          invalidRawShapes: invalid,
          generatedShapeCount: content.elements.filter((e) => e.type === 'shape').length,
          generatedTextCount: content.elements.filter((e) => e.type === 'text').length,
          warnings,
          sceneValidation,
          metrics,
        };
        writeFileSync(join(modelDir, id + '.raw.txt'), raw);
        writeFileSync(
          join(modelDir, id + '.json'),
          JSON.stringify({ record, content, scene, normalizedHistory }, null, 2),
        );
        writeFileSync(
          join(modelDir, id + '.html'),
          htmlPage(spec.model + ' · ' + id, generatedHtml, historyHtml, record),
        );
        results.push({
          ...record,
          relativePage: safeName(spec.provider + '-' + spec.model) + '/' + id + '.html',
        });
        console.log(
          JSON.stringify({
            model: spec.model,
            case: id,
            status: 'generated',
            rawShapes: rawValidation.length,
            invalidShapes: invalid.length,
            dslValid: sceneValidation.valid,
          }),
        );
      } catch (error) {
        const record = {
          model: spec.model,
          provider: spec.provider,
          case: id,
          status: 'failed',
          error: String(error),
          milliseconds: Date.now() - started,
          metrics,
          warnings,
        };
        if (raw) writeFileSync(join(modelDir, id + '.raw.txt'), raw);
        writeFileSync(join(modelDir, id + '.json'), JSON.stringify(record, null, 2));
        results.push(record);
        console.log(JSON.stringify(record));
      }
      writeFileSync(
        join(runDir, 'summary.json'),
        JSON.stringify({ runDir, models, repeats, results }, null, 2),
      );
    }
}
// Two concurrent real-model calls, without automatic model fallbacks/retries.
for (let i = 0; i < models.length; i += 2) await Promise.all(models.slice(i, i + 2).map(runModel));
writeFileSync(
  join(runDir, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>SVG real-model regression</title><style>${css}</style><h1>真实轻量模型 SVG 回归</h1>${results.map((record) => `<p>${record.model} · ${record.case}: ${record.relativePage ? `<a href="${record.relativePage}">查看生成与历史渲染对照</a>` : record.error}</p>`).join('')}`,
);
console.log(
  JSON.stringify({
    completed: true,
    runDir,
    slides: results.length,
    failures: results.filter((r) => r.status === 'failed').length,
  }),
);
