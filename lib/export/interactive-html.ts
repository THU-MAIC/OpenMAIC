import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { collectSpeechText } from './narration';
import { buildExperimentCode, type ExperimentCode } from './experiment-code';

export interface InteractiveCourseHtmlInput {
  readonly courseName: string;
  readonly courseDescription?: string;
  readonly scenes: readonly Scene[];
  readonly outlines?: readonly SceneOutline[];
  readonly generatedAt?: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function highlightText(value: string, terms: readonly string[] = []): string {
  const normalizedTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (normalizedTerms.length === 0) return escapeHtml(value);

  const pattern = new RegExp(`(${normalizedTerms.map(escapeRegExp).join('|')})`, 'giu');
  return value
    .split(pattern)
    .map((part) => {
      const highlighted = normalizedTerms.some(
        (term) => term.localeCompare(part, undefined, { sensitivity: 'accent' }) === 0,
      );
      return highlighted ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part);
    })
    .join('');
}

function renderParagraphs(value: string | undefined, terms: readonly string[] = []): string {
  const text = value?.trim();
  if (!text) return '<p class="muted">暂无讲解内容。</p>';
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${highlightText(paragraph, terms).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function renderList(items: readonly string[], className = ''): string {
  const filtered = items.map((item) => item.trim()).filter(Boolean);
  if (filtered.length === 0) return '';
  return `<ul class="${className}">${filtered.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function extractCodeFromInteractiveHtml(html: string): string | undefined {
  const raw = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
  if (!raw) return undefined;
  const code = raw
    .replace(/<br\s*\/?>(?:\r?\n)?/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  return code || undefined;
}

function buildSceneExperiment(scene: Scene, outline: SceneOutline | undefined): ExperimentCode {
  const interactiveHtml =
    scene.content.type === 'interactive' && typeof scene.content.html === 'string'
      ? scene.content.html
      : '';
  return buildExperimentCode({
    title: scene.title || outline?.title,
    description: outline?.description,
    keyPoints: outline?.keyPoints,
    widgetType: outline?.widgetType,
    language: outline?.widgetOutline?.language,
    sourceCode: extractCodeFromInteractiveHtml(interactiveHtml),
  });
}

function codeTokenClass(token: string): string {
  if (token.startsWith('#')) return 'tok-comment';
  if (/^(?:["'`]|[rubf]+["'])/iu.test(token)) return 'tok-string';
  if (/^\d/u.test(token)) return 'tok-number';
  if (
    /^(?:and|as|assert|async|await|class|def|else|for|from|if|import|in|is|lambda|not|or|return|try|while|with|yield)$/u.test(
      token,
    )
  ) {
    return 'tok-keyword';
  }
  if (/^(?:True|False|None|np|plt)$/u.test(token)) return 'tok-builtin';
  return 'tok-plain';
}

/** Lightweight Python highlighting that keeps copied code text identical. */
function highlightPython(code: string): string {
  const tokenPattern =
    /(?:#[^\n]*|(?:[rubf]+)?"(?:\\.|[^"\\])*"|(?:[rubf]+)?'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:and|as|assert|async|await|class|def|else|for|from|if|import|in|is|lambda|not|or|return|try|while|with|yield|True|False|None|np|plt)\b)/giu;
  return code
    .split('\n')
    .map((line) => {
      let cursor = 0;
      let result = '';
      for (const match of line.matchAll(tokenPattern)) {
        const token = match[0];
        const start = match.index ?? cursor;
        result += escapeHtml(line.slice(cursor, start));
        result += `<span class="${codeTokenClass(token)}">${escapeHtml(token)}</span>`;
        cursor = start + token.length;
      }
      return result + escapeHtml(line.slice(cursor));
    })
    .join('\n');
}

function renderCodeBlock(id: string, label: string, language: string, code: string): string {
  const highlightedCode = language === 'python' ? highlightPython(code) : escapeHtml(code);
  return `
    <div class="code-card">
      <div class="code-toolbar">
        <div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div>
        <span class="code-label">${escapeHtml(label)}</span>
        <span class="code-language">${escapeHtml(language)}</span>
        <button class="copy-button" type="button" data-copy-code="${escapeHtml(id)}">复制代码</button>
      </div>
      <pre><code id="${escapeHtml(id)}" data-language="${escapeHtml(language)}">${highlightedCode}</code></pre>
    </div>`;
}

function renderExperimentGuide(experiment: ExperimentCode): string {
  return `
    <section class="experiment-guide" aria-label="实验理论与任务指引">
      <div class="guide-row">
        <span class="guide-label">实验目标</span>
        <p>${escapeHtml(experiment.objective)}</p>
      </div>
      <div class="guide-row">
        <span class="guide-label">原理说明</span>
        <p>${escapeHtml(experiment.principle)}</p>
      </div>
      <div class="guide-row">
        <span class="guide-label">任务提示</span>
        <p>${escapeHtml(experiment.task)}</p>
      </div>
      <div class="guide-row assertion-row">
        <span class="guide-label">断言判分规则</span>
        <ul class="assertion-rules">
          ${experiment.assertionRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}
        </ul>
      </div>
    </section>`;
}

function renderQuizDetails(scene: Scene): string {
  if (scene.content.type !== 'quiz' || scene.content.questions.length === 0) return '';
  return scene.content.questions
    .map((question, index) => {
      const answers = question.answer?.length
        ? question.answer
            .map(
              (answer) =>
                question.options?.find((option) => option.value === answer)?.label || answer,
            )
            .join('、')
        : '开放作答，请结合本节核心概念说明理由。';
      return `
        <details class="quiz-item">
          <summary><span class="question-index">${index + 1}</span>${escapeHtml(question.question)}</summary>
          <div class="answer-panel">
            <strong>参考答案</strong>
            <p>${escapeHtml(answers)}</p>
            ${question.analysis ? `<p class="analysis">${escapeHtml(question.analysis)}</p>` : ''}
          </div>
        </details>`;
    })
    .join('');
}

function renderSelfCheck(scene: Scene, outline: SceneOutline | undefined): string {
  const keyPoints = outline?.keyPoints?.filter(Boolean) ?? [];
  const fallback =
    keyPoints.length > 0 ? keyPoints.join('；') : '请用自己的话复述本节最重要的一个概念。';
  return `
    <details class="self-check">
      <summary>点击展开查看答案与解析</summary>
      <div class="answer-panel">
        <strong>本节要点</strong>
        <p>${escapeHtml(fallback)}</p>
        <p class="analysis">建议先独立完成思考，再展开对照。把答案讲给别人听，是检验理解是否扎实的好方法。</p>
      </div>
    </details>`;
}

function renderScene(scene: Scene, outline: SceneOutline | undefined, index: number): string {
  const keyPoints = outline?.keyPoints ?? [];
  const narration = collectSpeechText(scene, { keepWhitespaceOnly: false, trim: true });
  const explanation = narration || outline?.description || '这一节将通过示例和练习帮助你建立直觉。';
  const experiment = buildSceneExperiment(scene, outline);
  const codeId = `code-${index + 1}`;
  const exerciseId = `exercise-${index + 1}`;
  const details = renderQuizDetails(scene) || renderSelfCheck(scene, outline);
  const isQuiz = scene.content.type === 'quiz';

  return `
    <article class="lesson-card" id="lesson-${index + 1}">
      <div class="lesson-kicker">实验 ${String(index + 1).padStart(2, '0')} <span></span> ${isQuiz ? '随堂互动' : '概念探索'}</div>
      <h2>${escapeHtml(scene.title || outline?.title || `第 ${index + 1} 节`)}</h2>
      ${outline?.description ? `<p class="lesson-summary">${escapeHtml(outline.description)}</p>` : ''}
      <div class="teacher-card">
        <div class="teacher-avatar">AI</div>
        <div class="teacher-copy">
          <div class="teacher-label">AI 教师解析 <span>· 重点已标注</span></div>
          ${renderParagraphs(explanation, keyPoints.slice(0, 3))}
        </div>
      </div>
      ${renderList(keyPoints, 'key-points')}
      ${renderExperimentGuide(experiment)}
      ${renderCodeBlock(codeId, '实验交互代码', experiment.language, experiment.code)}
      ${renderCodeBlock(exerciseId, '练习与断言判分', 'python', experiment.exerciseCode)}
      <div class="interaction-card">
        <div class="interaction-heading"><span class="interaction-icon">✦</span><div><strong>随堂互动</strong><small>${isQuiz ? '完成问题后展开解析' : '先思考，再查看本节提示'}</small></div></div>
        ${details}
      </div>
    </article>`;
}

function formatGeneratedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function buildInteractiveCourseFilename(courseName: string): string {
  return `${sanitizeFilenamePart(courseName) || '互动实验课'}_互动实验课件.html`;
}

/** Build an entirely self-contained, offline-friendly HTML lesson handout. */
export function buildInteractiveCourseHtml(input: InteractiveCourseHtmlInput): string {
  const generatedAt = input.generatedAt ?? Date.now();
  const outlinesByOrder = new Map(
    (input.outlines ?? []).map((outline) => [outline.order, outline]),
  );
  const firstOutline = input.outlines?.[0];
  const goals = [
    ...(firstOutline?.teachingObjective ? [firstOutline.teachingObjective] : []),
    ...(input.outlines ?? []).flatMap((outline) => outline.keyPoints ?? []),
  ]
    .map((goal) => goal.trim())
    .filter((goal, index, all) => goal && all.indexOf(goal) === index)
    .slice(0, 4);
  const resolvedGoals =
    goals.length > 0
      ? goals
      : [input.courseDescription || '理解核心概念，并通过互动练习将知识应用到真实问题中。'];
  const lessons = [...input.scenes]
    .sort((a, b) => a.order - b.order)
    .map((scene, index) => renderScene(scene, outlinesByOrder.get(scene.order), index))
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.courseName)} · 互动实验课件</title>
  <style>
    :root { --ink:#172033; --muted:#697386; --line:#e7eaf1; --paper:#fff; --canvas:#f6f8fc; --brand:#6857e8; --brand-soft:#eeecff; --mint:#dff7ee; --code:#18202c; --code-ink:#e7edf7; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; color:var(--ink); background:var(--canvas); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height:1.75; }
    a { color:inherit; }
    .page { width:min(1080px, calc(100% - 36px)); margin:0 auto; padding:42px 0 80px; }
    .hero { position:relative; overflow:hidden; padding:58px clamp(28px, 6vw, 72px) 52px; border:1px solid rgba(255,255,255,.75); border-radius:32px; color:#fff; background:linear-gradient(135deg,#352e78 0%,#6857e8 55%,#9e8cff 100%); box-shadow:0 24px 70px rgba(63,52,157,.25); }
    .hero::after { content:""; position:absolute; width:360px; height:360px; right:-130px; top:-180px; border-radius:50%; background:rgba(255,255,255,.13); box-shadow:-120px 280px 0 40px rgba(255,255,255,.07); }
    .eyebrow { position:relative; z-index:1; display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border:1px solid rgba(255,255,255,.24); border-radius:999px; color:rgba(255,255,255,.86); background:rgba(255,255,255,.12); font-size:12px; letter-spacing:.08em; }
    .hero h1 { position:relative; z-index:1; max-width:740px; margin:20px 0 12px; font-size:clamp(34px, 6vw, 64px); line-height:1.1; letter-spacing:-.045em; }
    .hero-description { position:relative; z-index:1; max-width:680px; margin:0; color:rgba(255,255,255,.8); font-size:17px; }
    .hero-meta { position:relative; z-index:1; display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; font-size:13px; color:rgba(255,255,255,.76); }
    .hero-meta span { padding:5px 10px; border-radius:8px; background:rgba(255,255,255,.11); }
    .section-label { margin:46px 0 14px; color:var(--brand); font-size:12px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    .goals { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:14px; margin-bottom:34px; }
    .goal { padding:20px; border:1px solid var(--line); border-radius:18px; background:var(--paper); box-shadow:0 8px 24px rgba(27,36,66,.05); }
    .goal-number { display:block; margin-bottom:8px; color:var(--brand); font-size:12px; font-weight:800; }
    .goal p { margin:0; font-size:15px; font-weight:650; line-height:1.55; }
    .lesson-card { margin-top:26px; padding:clamp(24px, 5vw, 48px); border:1px solid var(--line); border-radius:28px; background:var(--paper); box-shadow:0 14px 36px rgba(27,36,66,.06); }
    .lesson-kicker { display:flex; align-items:center; gap:10px; color:var(--brand); font-size:12px; font-weight:800; letter-spacing:.13em; text-transform:uppercase; }
    .lesson-kicker span { width:24px; height:1px; background:currentColor; opacity:.45; }
    .lesson-card h2 { margin:11px 0 8px; font-size:clamp(24px, 4vw, 36px); line-height:1.2; letter-spacing:-.03em; }
    .lesson-summary { margin:0 0 24px; color:var(--muted); font-size:16px; }
    .teacher-card { display:flex; gap:15px; margin:26px 0 22px; padding:20px; border:1px solid #e4e0ff; border-radius:20px; background:linear-gradient(135deg,#faf9ff,#f4f1ff); }
    .teacher-avatar { flex:0 0 auto; display:grid; place-items:center; width:38px; height:38px; border-radius:13px; color:#fff; background:linear-gradient(135deg,#6857e8,#9e8cff); font-size:12px; font-weight:850; }
    .teacher-copy { min-width:0; }
    .teacher-label { margin-bottom:5px; color:#4435af; font-size:13px; font-weight:800; }
    .teacher-label span { color:#8a80d7; font-weight:600; }
    .teacher-copy p { margin:0 0 8px; color:#394259; }
    .teacher-copy p:last-child { margin-bottom:0; }
    mark { padding:1px 5px; border-radius:5px; color:#3e329a; background:#e8e3ff; }
    .key-points { display:flex; flex-wrap:wrap; gap:9px; padding:0; margin:0 0 26px; list-style:none; }
    .key-points li { padding:5px 11px; border:1px solid #d7f0e7; border-radius:999px; color:#28765d; background:var(--mint); font-size:12px; font-weight:700; }
    .experiment-guide { display:grid; gap:0; margin:26px 0; padding:4px 20px; border:1px solid #e7e3ff; border-radius:20px; background:linear-gradient(135deg,#fcfbff,#f7f5ff); }
    .guide-row { display:grid; grid-template-columns:minmax(108px, 132px) 1fr; gap:18px; padding:15px 0; border-bottom:1px solid #ece9fb; }
    .guide-row:last-child { border-bottom:0; }
    .guide-label { color:#4b3db6; font-size:12px; font-weight:850; letter-spacing:.08em; white-space:nowrap; }
    .guide-row p { margin:0; color:#48536a; font-size:14px; line-height:1.7; }
    .assertion-rules { display:flex; flex-wrap:wrap; gap:8px; padding:0; margin:0; list-style:none; }
    .assertion-rules li { padding:4px 9px; border:1px solid #f2d6b7; border-radius:8px; color:#9a5a21; background:#fff7ed; font:12px/1.45 "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    .code-card { overflow:hidden; margin:24px 0; border:1px solid #2a3547; border-radius:18px; background:var(--code); box-shadow:0 16px 30px rgba(17,25,39,.18); }
    .code-toolbar { display:flex; align-items:center; gap:10px; padding:12px 15px; border-bottom:1px solid rgba(255,255,255,.08); color:#91a0b7; font-size:12px; }
    .window-dots { display:flex; gap:6px; margin-right:3px; }
    .window-dots i { width:9px; height:9px; border-radius:50%; background:#ff625b; }
    .window-dots i:nth-child(2) { background:#ffc043; }
    .window-dots i:nth-child(3) { background:#31c74a; }
    .code-label { color:#d9e2f0; font-weight:750; }
    .code-language { flex:1; font-family:"SFMono-Regular", Consolas, "Liberation Mono", monospace; }
    .copy-button { padding:5px 9px; border:1px solid rgba(255,255,255,.15); border-radius:7px; color:#c3cede; background:rgba(255,255,255,.06); font:inherit; cursor:pointer; }
    .copy-button:hover { color:#fff; background:rgba(255,255,255,.14); }
    pre { overflow:auto; margin:0; padding:22px; color:var(--code-ink); font:13px/1.75 "SFMono-Regular", Consolas, "Liberation Mono", monospace; tab-size:2; }
    .tok-comment { color:#718096; font-style:italic; }
    .tok-string { color:#a8d37d; }
    .tok-number { color:#f4b183; }
    .tok-keyword { color:#c792ea; font-weight:700; }
    .tok-builtin { color:#7dd3fc; }
    .interaction-card { margin-top:28px; padding:18px; border:1px solid #e7eaf1; border-radius:18px; background:#fbfcff; }
    .interaction-heading { display:flex; align-items:center; gap:11px; margin-bottom:10px; }
    .interaction-icon { display:grid; place-items:center; width:30px; height:30px; border-radius:10px; color:#fff; background:#f09a4d; }
    .interaction-heading strong, .interaction-heading small { display:block; }
    .interaction-heading strong { font-size:14px; }
    .interaction-heading small { color:var(--muted); font-size:12px; }
    details { border-top:1px solid var(--line); }
    details summary { padding:14px 4px 12px; color:#30394f; font-size:14px; font-weight:750; cursor:pointer; list-style-position:inside; }
    details summary::marker { color:var(--brand); }
    .answer-panel { padding:0 12px 14px 26px; color:var(--muted); font-size:14px; }
    .answer-panel strong { color:#34405a; font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
    .answer-panel p { margin:4px 0 0; }
    .answer-panel .analysis { margin-top:10px; color:#4f6280; }
    .question-index { display:inline-grid; place-items:center; width:22px; height:22px; margin-right:8px; border-radius:7px; color:var(--brand); background:var(--brand-soft); font-size:11px; }
    .footer { padding:40px 0 0; color:#9aa3b5; text-align:center; font-size:12px; }
    .muted { color:var(--muted); }
    @media (max-width:640px) { .page { width:min(100% - 22px, 1080px); padding-top:16px; } .hero { padding:34px 23px 30px; border-radius:23px; } .hero h1 { font-size:37px; } .lesson-card { padding:24px 18px; border-radius:22px; } .teacher-card { padding:15px; } pre { padding:17px; font-size:12px; } }
    @media print { body { background:#fff; } .page { width:100%; padding:0; } .hero, .lesson-card, .goal { box-shadow:none; } .lesson-card { break-inside:avoid; } .copy-button { display:none; } }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <div class="eyebrow">OPENMAIC · LAB PREVIEW · 实验课件预览版</div>
      <h1>${escapeHtml(input.courseName)}</h1>
      <p class="hero-description">${escapeHtml(input.courseDescription || '一份可以边读、边思考、边动手实践的互动实验课件。')}</p>
      <div class="hero-meta"><span>生成于 ${escapeHtml(formatGeneratedAt(generatedAt))}</span><span>${input.scenes.length} 个实验章节</span><span>实验课件预览版 · 离线可用 · 单文件</span></div>
    </header>

    <div class="section-label">Learning guide · 学习目标</div>
    <section class="goals" aria-label="学习目标">
      ${resolvedGoals.map((goal, index) => `<div class="goal"><span class="goal-number">目标 ${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(goal)}</p></div>`).join('')}
    </section>

    <div class="section-label">Explore · 开始实验</div>
    <section aria-label="课程章节">${lessons || '<div class="lesson-card"><p class="muted">暂时没有可导出的章节。</p></div>'}</section>
    <footer class="footer">本课件由 OpenMAIC 生成 · 双击此文件即可离线学习</footer>
  </main>
  <script>
    (() => {
      const fallbackCopy = (text) => {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); } finally { area.remove(); }
      };
      document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy-code]');
        if (!button) return;
        const code = document.getElementById(button.dataset.copyCode)?.textContent || '';
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
          else fallbackCopy(code);
          const original = button.textContent;
          button.textContent = '已复制';
          window.setTimeout(() => { button.textContent = original; }, 1400);
        } catch (_) {
          fallbackCopy(code);
          button.textContent = '已复制';
          window.setTimeout(() => { button.textContent = '复制代码'; }, 1400);
        }
      });
    })();
  </script>
</body>
</html>`;
}

export function downloadInteractiveCourseHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.html') ? filename : `${filename}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
