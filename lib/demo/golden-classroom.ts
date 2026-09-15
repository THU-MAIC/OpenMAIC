'use client';

import type { PPTElement, Slide } from '@openmaic/dsl';

import {
  getPersistenceRequestHeaders,
  isBrowserPersistenceEnabled,
} from '@/lib/persistence/bootstrap';
import { createConceptLearningTask } from '@/lib/learning/task-template';
import { getLearningTask, upsertLearningTask } from '@/lib/learning/task-storage';
import type { Scene, Stage } from '@/lib/types/stage';
import { stageDeletionEpoch, unmarkStageDeleted } from '@/lib/utils/deleted-stages';
import { loadStageData, saveStageData, type StageStoreData } from '@/lib/utils/stage-storage';

const DEMO_MARKER_KEY = 'zhigou.demo.linear-function.v1';
const LOCAL_STAGE_ID = 'zhigou-demo-linear-function';
const TASK_ID = 'zhigou-demo-linear-function-task';

interface DemoMarker {
  stageId: string;
  taskId: string;
}

export interface GoldenDemoResult extends DemoMarker {
  reused: boolean;
}

const BRAND = {
  teal: '#0F766E',
  cyan: '#22B8B5',
  navy: '#0B2430',
  ink: '#17313B',
  muted: '#59717A',
  pale: '#E8F6F4',
  warm: '#FFF7E7',
  amber: '#F59E0B',
  white: '#FFFFFF',
};

function text(
  id: string,
  content: string,
  left: number,
  top: number,
  width: number,
  height: number,
  options: Partial<Extract<PPTElement, { type: 'text' }>> = {},
): Extract<PPTElement, { type: 'text' }> {
  return {
    id,
    type: 'text',
    left,
    top,
    width,
    height,
    rotate: 0,
    content,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: BRAND.ink,
    lineHeight: 1.35,
    ...options,
  };
}

function box(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill: string,
  outline = fill,
): Extract<PPTElement, { type: 'shape' }> {
  return {
    id,
    type: 'shape',
    left,
    top,
    width,
    height,
    rotate: 0,
    viewBox: [width, height],
    path: `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`,
    fixedRatio: false,
    fill,
    outline: { width: 1, color: outline, style: 'solid' },
  };
}

function slide(id: string, elements: PPTElement[], script: string): Slide {
  return {
    id,
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#F7FBFA',
      themeColors: [BRAND.teal, BRAND.cyan, BRAND.amber, BRAND.navy],
      fontColor: BRAND.ink,
      fontName: 'Microsoft YaHei',
    },
    elements,
    background: { type: 'solid', color: '#F7FBFA' },
    script,
  };
}

function createIntroSlide(): Slide {
  return slide(
    'demo-slide-intro',
    [
      box('intro-accent', 0, 0, 28, 562.5, BRAND.teal),
      text(
        'intro-kicker',
        '<p style="font-size:18px"><strong>知构 AI · 数学概念课</strong></p>',
        82,
        58,
        430,
        42,
        {
          defaultColor: BRAND.teal,
        },
      ),
      text(
        'intro-title',
        '<p style="font-size:50px"><strong>一次函数</strong></p><p style="font-size:50px"><strong>斜率与截距</strong></p>',
        80,
        128,
        520,
        170,
        { defaultColor: BRAND.navy, lineHeight: 1.08 },
      ),
      text(
        'intro-subtitle',
        '<p style="font-size:23px">从一条直线出发，理解 <strong>k</strong> 与 <strong>b</strong> 如何共同决定函数图像。</p>',
        84,
        330,
        480,
        80,
        { defaultColor: BRAND.muted },
      ),
      box('intro-card', 655, 86, 250, 390, BRAND.navy),
      text(
        'intro-formula',
        '<p style="text-align:center;font-size:34px"><strong>y = kx + b</strong></p>',
        680,
        180,
        200,
        66,
        { defaultColor: BRAND.white, vAlign: 'middle' },
      ),
      text(
        'intro-k',
        '<p style="text-align:center;font-size:19px"><strong>k</strong> 决定倾斜方向与陡峭程度</p>',
        690,
        285,
        180,
        58,
        { defaultColor: '#9FE8E1' },
      ),
      text(
        'intro-b',
        '<p style="text-align:center;font-size:19px"><strong>b</strong> 决定直线与 y 轴的交点</p>',
        690,
        365,
        180,
        58,
        { defaultColor: '#FDE3A7' },
      ),
    ],
    '同学你好。这节课我们不背结论，而是通过观察和操作，理解一次函数 y 等于 kx 加 b 中两个参数分别改变了什么。',
  );
}

function createSummarySlide(): Slide {
  const cards = [
    { x: 76, label: '看方向', value: 'k > 0 上升\nk < 0 下降', color: BRAND.pale },
    { x: 365, label: '看陡缓', value: '|k| 越大\n直线越陡', color: '#EDF4FF' },
    { x: 654, label: '看交点', value: 'b 是直线与\ny 轴的交点', color: BRAND.warm },
  ];
  return slide(
    'demo-slide-summary',
    [
      text(
        'summary-kicker',
        '<p style="font-size:18px"><strong>知识收束 · 一张图记住核心规律</strong></p>',
        76,
        52,
        640,
        38,
        { defaultColor: BRAND.teal },
      ),
      text(
        'summary-title',
        '<p style="font-size:38px"><strong>读懂一次函数，只需要三步</strong></p>',
        76,
        104,
        760,
        66,
        {
          defaultColor: BRAND.navy,
        },
      ),
      ...cards.flatMap((card, index) => [
        box(`summary-card-${index}`, card.x, 220, 250, 190, card.color, '#D6E7E4'),
        text(
          `summary-label-${index}`,
          `<p style="font-size:19px"><strong>0${index + 1} · ${card.label}</strong></p>`,
          card.x + 24,
          246,
          200,
          38,
          { defaultColor: index === 2 ? '#B66B00' : BRAND.teal },
        ),
        text(
          `summary-value-${index}`,
          `<p style="font-size:23px">${card.value.replace('\n', '<br>')}</p>`,
          card.x + 24,
          305,
          200,
          76,
          { defaultColor: BRAND.ink },
        ),
      ]),
      text(
        'summary-footer',
        '<p style="text-align:center;font-size:19px">下一次看到直线，先问自己：它向哪边走？有多陡？从哪里出发？</p>',
        145,
        470,
        710,
        46,
        { defaultColor: BRAND.muted },
      ),
    ],
    '最后用三个问题收束：直线上升还是下降由 k 的正负决定，陡峭程度由 k 的绝对值决定，与 y 轴的交点由 b 决定。',
  );
}

function createInteractiveHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;background:#f6fbfa;color:#17313b;font-family:"Microsoft YaHei",system-ui,sans-serif;min-height:100vh}.shell{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px;padding:24px;min-height:100vh}.panel{background:#fff;border:1px solid #dceae7;border-radius:20px;box-shadow:0 18px 44px rgba(15,118,110,.08)}.graph{padding:18px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.eyebrow{font-size:12px;color:#0f766e;font-weight:700;letter-spacing:.08em}.formula{background:#0b2430;color:#fff;padding:9px 16px;border-radius:12px;font-size:20px;font-weight:700}.side{padding:22px;display:flex;flex-direction:column;gap:20px}h1{font-size:24px;margin:0 0 5px}p{font-size:13px;line-height:1.7;color:#59717a;margin:0}.control{padding:15px;border-radius:14px;background:#f1f8f7}.row{display:flex;justify-content:space-between;font-weight:700;margin-bottom:10px}.value{color:#0f766e}input{width:100%;accent-color:#0f766e}.chips{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.chips button,.reset{border:1px solid #cfe2df;background:#fff;color:#31515a;border-radius:10px;padding:9px;cursor:pointer;font-weight:650}.chips button:hover,.chips button.active{border-color:#22b8b5;background:#e8f6f4;color:#0f766e}.insight{margin-top:auto;padding:16px;background:#fff7e7;border:1px solid #f7dfad;border-radius:14px;color:#8a5700;font-size:13px;line-height:1.6}svg{width:100%;height:calc(100vh - 112px);min-height:430px;border-radius:14px;background:#fbfdfd}.grid{stroke:#dceae7;stroke-width:1}.axis{stroke:#6c838a;stroke-width:2}.line{stroke:#0f766e;stroke-width:5;stroke-linecap:round}.point{fill:#f59e0b;stroke:#fff;stroke-width:3}.label{font-size:13px;fill:#59717a}.tag{font-size:13px;fill:#0f766e;font-weight:700}@media(max-width:800px){.shell{grid-template-columns:1fr}.side{order:-1}svg{height:430px}}
</style></head><body><main class="shell"><section class="panel graph"><div class="top"><div><div class="eyebrow">参数实验室</div><h1>拖动参数，观察直线怎样变化</h1></div><div class="formula" id="formula">y = 1x + 0</div></div><svg id="chart" viewBox="0 0 720 480" role="img" aria-label="一次函数坐标图"></svg></section><aside class="panel side"><div><div class="eyebrow">探索任务</div><h1>让图像回答问题</h1><p>先改变 k，再改变 b。注意直线的方向、陡缓和交点。</p></div><div class="control"><div class="row"><span>斜率 k</span><span class="value" id="kv">1</span></div><input id="k" type="range" min="-3" max="3" step="0.5" value="1"></div><div class="control"><div class="row"><span>截距 b</span><span class="value" id="bv">0</span></div><input id="b" type="range" min="-4" max="4" step="1" value="0"></div><div><p style="margin-bottom:8px;font-weight:700;color:#17313b">快速试一试</p><div class="chips"><button data-k="2" data-b="0">更陡</button><button data-k="-1" data-b="0">下降</button><button data-k="1" data-b="3">上移</button></div></div><button class="reset" id="reset">恢复初始状态</button><div class="insight" id="insight">当前 k 为正，直线从左向右上升；b = 0，直线经过原点。</div></aside></main>
<script>
const svg=document.querySelector('#chart'),ki=document.querySelector('#k'),bi=document.querySelector('#b'),kv=document.querySelector('#kv'),bv=document.querySelector('#bv'),formula=document.querySelector('#formula'),insight=document.querySelector('#insight');const sx=x=>360+x*52,sy=y=>240-y*44;function render(){const k=+ki.value,b=+bi.value;kv.textContent=k;bv.textContent=b;formula.textContent='y = '+k+'x '+(b>=0?'+ ':'- ')+Math.abs(b);let html='';for(let x=-6;x<=6;x++)html+='<line class="grid" x1="'+sx(x)+'" y1="20" x2="'+sx(x)+'" y2="460"/>';for(let y=-5;y<=5;y++)html+='<line class="grid" x1="40" y1="'+sy(y)+'" x2="680" y2="'+sy(y)+'"/>';html+='<line class="axis" x1="40" y1="240" x2="680" y2="240"/><line class="axis" x1="360" y1="20" x2="360" y2="460"/><text class="label" x="666" y="230">x</text><text class="label" x="370" y="34">y</text>';const x1=-6,x2=6;html+='<line class="line" x1="'+sx(x1)+'" y1="'+sy(k*x1+b)+'" x2="'+sx(x2)+'" y2="'+sy(k*x2+b)+'"/><circle class="point" cx="360" cy="'+sy(b)+'" r="8"/><text class="tag" x="375" y="'+(sy(b)-10)+'">(0, '+b+')</text>';svg.innerHTML=html;const trend=k>0?'从左向右上升':k<0?'从左向右下降':'保持水平';const steep=Math.abs(k)>1?'而且比较陡':Math.abs(k)<1?'而且比较平缓':'';insight.textContent='当前直线'+trend+steep+'；它与 y 轴交于 (0, '+b+')。';document.querySelectorAll('.chips button').forEach(x=>x.classList.toggle('active',+x.dataset.k===k&&+x.dataset.b===b));}[ki,bi].forEach(x=>x.addEventListener('input',render));document.querySelectorAll('.chips button').forEach(x=>x.addEventListener('click',()=>{ki.value=x.dataset.k;bi.value=x.dataset.b;render()}));document.querySelector('#reset').addEventListener('click',()=>{ki.value=1;bi.value=0;render()});render();
</script></body></html>`;
}

export function buildGoldenDemoClassroom(stageId: string, now = Date.now()): StageStoreData {
  const stage: Stage = {
    id: stageId,
    name: '一次函数：斜率与截距',
    description: '知构 AI 黄金演示课堂：通过可交互图像理解一次函数的核心参数。',
    languageDirective: 'zh-CN',
    style: 'zhigou-learning-lab',
    interactiveMode: true,
    createdAt: now,
    updatedAt: now,
  };
  const sceneCore = (id: string, title: string, order: number) => ({
    id,
    stageId,
    title,
    order,
    createdAt: now,
    updatedAt: now,
  });
  const scenes: Scene[] = [
    {
      ...sceneCore('demo-scene-intro', '认识一次函数', 0),
      type: 'slide',
      content: { type: 'slide', canvas: createIntroSlide() },
    },
    {
      ...sceneCore('demo-scene-lab', '参数实验室', 1),
      type: 'interactive',
      content: { type: 'interactive', url: '', html: createInteractiveHtml() },
    },
    {
      ...sceneCore('demo-scene-quiz', '理解检测', 2),
      type: 'quiz',
      content: {
        type: 'quiz',
        questions: [
          {
            id: 'demo-q1',
            type: 'single',
            question: '函数 y = -2x + 1 的图像从左向右如何变化？',
            options: [
              { label: '上升', value: 'A' },
              { label: '下降', value: 'B' },
              { label: '保持水平', value: 'C' },
            ],
            answer: ['B'],
            analysis: '斜率 k = -2，小于 0，所以直线从左向右下降。',
            points: 1,
          },
          {
            id: 'demo-q2',
            type: 'single',
            question: '直线 y = 3x - 2 与 y 轴的交点是？',
            options: [
              { label: '(0, 3)', value: 'A' },
              { label: '(0, -2)', value: 'B' },
              { label: '(-2, 0)', value: 'C' },
            ],
            answer: ['B'],
            analysis: '令 x = 0，得到 y = b = -2，因此交点为 (0, -2)。',
            points: 1,
          },
          {
            id: 'demo-q3',
            type: 'multiple',
            question: '关于 y = kx + b，下列说法正确的是？',
            options: [
              { label: 'k 的正负决定上升或下降', value: 'A' },
              { label: '|k| 越大，直线通常越陡', value: 'B' },
              { label: 'b 决定与 y 轴的交点', value: 'C' },
              { label: '改变 b 会改变直线的倾斜程度', value: 'D' },
            ],
            answer: ['A', 'B', 'C'],
            analysis: 'b 只让直线平行移动，不改变倾斜程度；倾斜由 k 决定。',
            points: 1,
          },
        ],
      },
    },
    {
      ...sceneCore('demo-scene-summary', '规律总结', 3),
      type: 'slide',
      content: { type: 'slide', canvas: createSummarySlide() },
    },
  ];

  return {
    stage,
    scenes,
    currentSceneId: scenes[0].id,
    chats: [],
    outline: {
      requirement: '理解一次函数中斜率与截距对图像的影响',
      generationComplete: true,
      outlines: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

function readMarker(): DemoMarker | null {
  try {
    const value = localStorage.getItem(DEMO_MARKER_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<DemoMarker>;
    return typeof parsed.stageId === 'string' && typeof parsed.taskId === 'string'
      ? { stageId: parsed.stageId, taskId: parsed.taskId }
      : null;
  } catch {
    return null;
  }
}

async function createServerStage(): Promise<string> {
  const response = await fetch('/api/stages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await getPersistenceRequestHeaders()) },
    body: JSON.stringify({ name: '一次函数：斜率与截距', description: '知构 AI 黄金演示课堂' }),
  });
  if (!response.ok) throw new Error(`Unable to create demo classroom (${response.status})`);
  const payload = (await response.json()) as { stage?: { id?: string } };
  if (!payload.stage?.id) throw new Error('Demo classroom response did not include an id');
  return payload.stage.id;
}

function ensureLinkedTask(stageId: string, now: number): string {
  const existing = getLearningTask(TASK_ID);
  if (existing?.classroomId === stageId) return existing.id;
  const task = createConceptLearningTask(
    {
      courseName: '初中数学',
      knowledgePoint: '一次函数：斜率与截距',
      learningGoal: '能够根据 k 与 b 判断一次函数图像的方向、陡缓和交点',
      priorKnowledge: '平面直角坐标系与函数基本概念',
    },
    { id: TASK_ID, now },
  );
  upsertLearningTask({ ...task, classroomId: stageId, status: 'ready' });
  return task.id;
}

export async function ensureGoldenDemoClassroom(): Promise<GoldenDemoResult> {
  const marker = readMarker();
  if (marker && (await loadStageData(marker.stageId))) {
    ensureLinkedTask(marker.stageId, Date.now());
    return { ...marker, reused: true };
  }

  const stageId = isBrowserPersistenceEnabled() ? await createServerStage() : LOCAL_STAGE_ID;
  const existing = await loadStageData(stageId);
  if (!existing) {
    unmarkStageDeleted(stageId);
    const result = await saveStageData(
      stageId,
      buildGoldenDemoClassroom(stageId),
      stageDeletionEpoch(stageId),
    );
    if (result === 'stale-dropped') throw new Error('Demo classroom creation was cancelled');
  }

  const taskId = ensureLinkedTask(stageId, Date.now());
  const nextMarker = { stageId, taskId };
  localStorage.setItem(DEMO_MARKER_KEY, JSON.stringify(nextMarker));
  return { ...nextMarker, reused: Boolean(existing) };
}
