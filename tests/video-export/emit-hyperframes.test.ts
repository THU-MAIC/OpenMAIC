import { describe, it, expect } from 'vitest';
import { spotlightV1 } from '@/lib/choreography';
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import type { AssetMeta, CompilerScene } from '@/lib/video-export';
import {
  slide,
  quiz,
  el,
  speech,
  spotlight,
  laser,
  playVideo,
  stubProbe,
  stubAssets,
} from './helpers';

const audioMeta = (id: string): AssetMeta => ({
  id,
  format: 'mp3',
  present: true,
  durationMs: 2000,
});
const videoMeta = (id: string): AssetMeta => ({ id, format: 'mp4', present: true });

/** A slide classroom exercising every emitted layer: base, narration, effects, video. */
function compileSample() {
  const scenes = [
    slide(
      'intro',
      [
        speech('sp1', 'Welcome to the lesson', { audioId: 'a1' }),
        spotlight('l1', 'e1'),
        laser('la1', 'e1', '#00ff88'),
        playVideo('v1', 'e1'),
      ],
      { title: 'Intro', elements: [el('e1', { left: 250, top: 140, width: 500, height: 280 })] },
    ),
    quiz('checkpoint', [], 1),
  ];
  return compileVideoTimeline(
    { stage: { id: 'stage', name: 'Sample Lesson' }, scenes },
    {
      timing: stubProbe({ sp1: 2000 }, { v1: 3000 }),
      assets: stubAssets({ sp1: audioMeta('a1') }, { e1: videoMeta('stage:e1') }),
    },
  );
}

describe('emitHyperframes', () => {
  const ir = compileSample();
  const project = emitHyperframes(ir, { width: 1920, height: 1080 });
  const html = project.files.find((f) => f.path === 'index.html')!.content;

  it('emits the self-contained project file set', () => {
    const paths = project.files.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        'LICENSES/Inter-OFL-1.1.txt',
        'README.md',
        'index.html',
        'openmaic-video-manifest.json',
        'subtitles.srt',
        'subtitles.vtt',
      ].sort(),
    );
    expect(
      project.files.find((file) => file.path === 'LICENSES/Inter-OFL-1.1.txt')!.content,
    ).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('builds one composition driven by one paused GSAP timeline', () => {
    expect(html).toContain('data-composition-id="openmaic"');
    expect(html).toContain('data-width="1920"');
    expect(html).toContain('data-height="1080"');
    expect(html).toContain(`data-duration="${ir.totalDurationMs / 1000}"`);
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('window.__timelines["openmaic"] = tl;');
  });

  it('lays out base / narration / video clips with clip attributes', () => {
    expect(html).toMatch(/<img [^>]*class="clip"[^>]*src="assets\/frames\/[^"]+\.png"/);
    expect(html).toMatch(/<audio [^>]*class="clip"[^>]*src="assets\/audio\/[^"]+"/);
    expect(html).toMatch(/<video [^>]*class="clip"[^>]*src="assets\/media\/[^"]+"/);
    // the Quiz scene is a first-class timed visual, not an unsupported placeholder
    expect(html).toContain('data-visual-kind="quiz-cover"');
    expect(html).not.toContain('Quiz scenes are represented by markers');
  });

  it('lets unsupported authored fallback text resolve its own direction', () => {
    const unsupported = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Unsupported direction' },
        scenes: [
          {
            id: 'interactive',
            stageId: 'stage',
            title: 'Mixed fallback: English ثم العربية',
            order: 0,
            type: 'interactive',
            content: { type: 'interactive' },
            actions: [],
          } as CompilerScene,
        ],
      },
      { timing: stubProbe(), assets: stubAssets() },
    );
    const fallbackHtml = emitHyperframes(unsupported, { locale: 'ar-SA' }).files.find(
      (file) => file.path === 'index.html',
    )!.content;

    expect(fallbackHtml).toMatch(
      /<div dir="auto" style="font-size:2\.2vw[^"]*">Mixed fallback: English ثم العربية<\/div>/,
    );
    expect(fallbackHtml).toMatch(
      /<div dir="auto" style="font-size:1\.2vw[^"]*">Interactive\/widget scenes require runtime playback/,
    );
  });

  it('emits spotlight and laser overlays with authored params', () => {
    expect(html).toContain('class="fx fx-spotlight"');
    expect(html).toContain('class="fx fx-laser"');
    expect(html).toContain('#00ff88'); // authored laser color survives into the DOM
  });

  it('matches the descriptor-authored spotlight fade easing for enter and exit', () => {
    const dim = spotlightV1.layers.find((layer) => layer.id === 'dim');
    const enter = dim?.tracks.find((track) => (track.phase ?? 'enter') === 'enter');
    const exit = dim?.tracks.find((track) => track.phase === 'exit');

    expect(enter?.easing).toEqual(exit?.easing);
    if (enter?.easing?.type !== 'cubicBezier') {
      throw new Error('spotlight.v1 dim enter track must use cubic-bezier easing');
    }
    const points = enter.easing.points.join(', ');

    expect(html).toContain(`var EASE_SPOTLIGHT_FADE = cubicBezier(${points});`);
    expect(html).toContain(
      "tl.fromTo('#fx-0-1',{autoAlpha:0},{autoAlpha:1,duration:0.3,ease:EASE_SPOTLIGHT_FADE},2);",
    );
    expect(html).toContain(
      "tl.to('#fx-0-1',{autoAlpha:0,duration:0.3,ease:EASE_SPOTLIGHT_FADE},4.7);",
    );
  });

  it('does not burn in subtitles by default (clean video + sidecar files)', () => {
    // Burn-in is opt-in (#867 item 2): no caption overlay in the composition,
    // but the sidecar subtitle files are still written.
    expect(html).not.toContain('id="subtitles"');
    expect(html).not.toContain('id="subtitle-cue-0"');
    expect(project.files.some((f) => f.path === 'subtitles.srt')).toBe(true);
    expect(project.files.some((f) => f.path === 'subtitles.vtt')).toBe(true);
  });

  it('burns in a subtitle overlay when burnInSubtitles is enabled', () => {
    const burned = emitHyperframes(ir, {
      width: 1920,
      height: 1080,
      burnInSubtitles: true,
    }).files.find((f) => f.path === 'index.html')!.content;
    // A caption container plus one cue div per non-empty speech action.
    expect(burned).toContain('id="subtitles"');
    expect(burned).toContain('id="subtitle-cue-0"');
    // Cues start hidden (display:none, out of layout) and are toggled by the
    // paused timeline — see the multi-cue positioning test below for why
    // display (not visibility) matters. The reveal `tl.set` switches them to
    // -webkit-box so the 2-line clamp stays in force while visible; the inline
    // style must NOT also declare a second `display` (it would override the
    // `none` and show every cue at t=0).
    expect(burned).toMatch(/id="subtitle-cue-0"[^>]*display:none/);
    expect(burned).toMatch(/-webkit-line-clamp:2/);
    // Exactly one `display:` in the cue's inline style, and it is `none`.
    const cue0Style = burned.match(/id="subtitle-cue-0"[^>]*style="([^"]*)"/)![1];
    expect(cue0Style.match(/display:/g)).toHaveLength(1);
    expect(cue0Style).toContain('display:none');
    expect(burned).toMatch(/tl\.set\('#subtitle-cue-0',\{display:'-webkit-box'\},[\d.]+\);/);
    expect(burned).toMatch(/tl\.set\('#subtitle-cue-0',\{display:'none'\},[\d.]+\);/);
    // Narration text is rendered into the caption.
    expect(burned).toContain('Welcome to the lesson');
  });

  it('references vendored GSAP, never a CDN', () => {
    expect(html).toContain('<script src="assets/vendor/gsap.min.js"></script>');
    expect(project.gsapVendorPath).toBe('assets/vendor/gsap.min.js');
  });

  it('matches the HTML snapshot', () => {
    expect(
      html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/, 'data:font/woff2;base64,<embedded>'),
    ).toMatchSnapshot();
  });
});

describe('emitHyperframes static Quiz/PBL cover cards', () => {
  const scenes = [
    {
      id: 'quiz-card',
      stageId: 'stage',
      title: 'Quiz <script>alert("title")</script>',
      order: 0,
      type: 'quiz',
      content: {
        type: 'quiz',
        questions: [
          { id: 'q1', type: 'single', question: 'Hidden', points: 4, answer: ['SECRET_ANSWER'] },
          { id: 'q2', type: 'short_answer', question: 'Hidden too' },
        ],
      },
      actions: [],
    },
    {
      id: 'pbl-card',
      stageId: 'stage',
      title: 'PBL fallback',
      order: 1,
      type: 'pbl',
      content: {
        type: 'pbl',
        projectV2: {
          title: 'Build & Verify <Systems>',
          description:
            'A deliberately long learner-facing description with SupercalifragilisticexpialidociousWithoutBreaks.',
          gains: ['Model <threats>', 'Ship & verify'],
          roles: [
            {
              id: 'instructor',
              type: 'instructor',
              name: 'Dr. <Guide>',
              description: 'Helps you reason & test',
              systemPrompt: 'SECRET_PERSONA',
            },
          ],
          milestones: [
            { id: 'm1', microtasks: [{ id: 't1' }, { id: 't2' }] },
            { id: 'm2', microtasks: [{ id: 't3' }] },
          ],
          scenario: {
            setting: 'SECRET_SITUATION',
            characters: [
              {
                id: 'alex',
                name: 'Alex & Sam',
                persona: 'SECRET_CHARACTER_PERSONA',
              },
            ],
          },
          threads: [{ messages: [{ content: 'SECRET_CHAT' }] }],
          submissions: [{ content: 'SECRET_SUBMISSION' }],
        },
      },
      actions: [],
    },
  ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: 'Cover Cards' }, scenes },
    { timing: stubProbe(), assets: stubAssets() },
  );
  const html = emitHyperframes(ir, { width: 1280, height: 720 }).files.find(
    (file) => file.path === 'index.html',
  )!.content;

  it('emits each visual as a whole-scene track-0 clip with a static Quiz action', () => {
    expect(html).toMatch(
      /id="scene-1-visual-1" class="clip cover-card cover-quiz" data-visual-kind="quiz-cover" data-start="0" data-duration="2" data-track-index="0"/,
    );
    expect(html).toMatch(
      /id="scene-2-visual-1" class="clip cover-card cover-pbl" data-visual-kind="pbl-cover" data-start="2" data-duration="2" data-track-index="0"/,
    );
    expect(html).toContain(
      '<div class="cover-stat"><strong>2</strong><span>questions</span></div>',
    );
    expect(html).toContain('<div class="cover-stat"><strong>5</strong><span>pts</span></div>');
    // No call to action: a video viewer cannot answer the quiz, so the card
    // carries no button — inert or otherwise (#995 review).
    expect(html).not.toContain('cover-button');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('open.maic.chat');
  });

  it('renders the PBL Hero summary from learner-visible design fields', () => {
    expect(html).toContain('Build &amp; Verify &lt;Systems&gt;');
    expect(html).toContain('Model &lt;threats&gt;');
    expect(html).toContain('Ship &amp; verify');
    expect(html).toContain('<div class="cover-stat"><strong>2</strong><span>Stages</span></div>');
    expect(html).toContain('<div class="cover-stat"><strong>3</strong><span>Tasks</span></div>');
    expect(html).toContain('Dr. &lt;Guide&gt;');
    expect(html).toContain('Helps you reason &amp; test');
    expect(html).toContain('Alex &amp; Sam');
    expect(html).toContain('Role-play character');
  });

  it('renders every label from the injected locale strings', () => {
    const localized = emitHyperframes(ir, {
      width: 1280,
      height: 720,
      labels: {
        quiz: '随堂测验',
        questions: '道题',
        points: '分',
        pbl: '项目实战',
        stages: '阶段',
        tasks: '任务',
        gains: '你将收获',
        instructor: '导师',
        instructorTagline: '全程陪伴你完成项目',
        scenarioCharacter: '模拟角色',
        scenarioCharacterTagline: '情景模拟中与你互动的角色',
      },
    }).files.find((file) => file.path === 'index.html')!.content;

    expect(localized).toContain('<span class="cover-eyebrow-icon">?</span> 随堂测验');
    expect(localized).toContain('<strong>2</strong><span>道题</span>');
    expect(localized).toContain('<strong>5</strong><span>分</span>');
    expect(localized).toContain('你将收获');
    expect(localized).toContain('<span>导师</span>');
    expect(localized).toContain('<span>模拟角色</span>');
    // The English defaults are gone once labels are supplied.
    expect(localized).not.toContain('<span>pts</span>');
    expect(localized).not.toContain("What you'll gain");
  });

  it('keeps document direction unset and scopes locale direction to cover panels', () => {
    const chinese = emitHyperframes(ir, { width: 1280, locale: 'zh-CN' }).files.find(
      (file) => file.path === 'index.html',
    )!.content;
    const arabic = emitHyperframes(ir, { width: 1280, locale: 'ar-SA' }).files.find(
      (file) => file.path === 'index.html',
    )!.content;

    expect(chinese).toContain('<html lang="zh-CN">');
    expect(arabic).toContain('<html lang="ar-SA">');
    expect(arabic).not.toMatch(/<html[^>]*\sdir=["'](?:rtl|auto)["']/);
    expect(arabic).toContain('<div class="cover-panel cover-quiz-panel" dir="rtl">');
  });

  it('records the options the HTML was emitted with', () => {
    const labels = {
      quiz: 'Quiz label',
      questions: 'Question label',
      points: 'Point label',
      pbl: 'PBL label',
      stages: 'Stage label',
      tasks: 'Task label',
      gains: 'Gain label',
      instructor: 'Instructor label',
      instructorTagline: 'Instructor tagline',
      scenarioCharacter: 'Character label',
      scenarioCharacterTagline: 'Character tagline',
      quizCtaPrompt: 'Quiz CTA prompt',
      pblCtaPrompt: 'PBL CTA prompt',
      ctaVisit: 'CTA visit label',
    };
    const readme = emitHyperframes(ir, {
      width: 1280,
      height: 720,
      compositionId: 'cover-cards',
      gsapVendorPath: 'vendor/gsap.js',
      manifestPath: 'timeline.json',
      locale: 'zh-CN',
      burnInSubtitles: true,
      labels,
      cta: { destination: 'www.example.test/learn' },
    }).files.find((file) => file.path === 'README.md')!.content;

    // Reproduction requires the complete effective emitter input, including
    // defaults already resolved into concrete labels.
    expect(readme).toContain('| Locale | <code>"zh-CN"</code> (card chrome, `<html lang>`) |');
    expect(readme).toContain('| Burned-in subtitles | `true` |');
    expect(readme).toContain('| Resolution | `1280×720` |');
    expect(readme).toContain('| Composition ID | <code>"cover-cards"</code> |');
    expect(readme).toContain('| Manifest path | <code>"timeline.json"</code> |');
    expect(readme).toContain('| GSAP path | <code>"vendor/gsap.js"</code> |');
    expect(readme).toContain('| CTA destination | <code>"www.example.test/learn"</code> |');
    for (const [key, value] of Object.entries(labels)) {
      expect(readme).toContain(`"${key}": ${JSON.stringify(value)}`);
    }
    expect(readme).toContain(
      'same manifest, emitter implementation, and complete effective options produce byte-identical HTML',
    );
    expect(readme).toContain(
      'different hosts do not guarantee identical non-Latin pixels because system fonts may differ',
    );

    const disabled = emitHyperframes(ir).files.find((file) => file.path === 'README.md')!.content;
    expect(disabled).toContain('| CTA destination | <code>disabled</code> |');
    expect(disabled).toContain('"quiz": "Quiz"');
    expect(disabled).toContain('"ctaVisit": "Visit"');
  });

  it('records adversarial public strings without breaking Markdown tables or fences', () => {
    const readme = emitHyperframes(ir, {
      width: 1280,
      height: 720,
      compositionId: 'cover|````````id\nnext',
      manifestPath: 'manifest|`timeline`.json\nnext',
      gsapVendorPath: 'vendor/<gsap>|``.js\nnext',
      locale: 'en|`US`\nnext',
      labels: {
        quiz: 'Quiz | <unsafe> & `tick` then `````` fence\nnext',
      },
      cta: { destination: 'www.example.test/|`learn`\nnext' },
    }).files.find((file) => file.path === 'README.md')!.content;

    const optionsTable = readme.slice(
      readme.indexOf('| Option | Value |'),
      readme.indexOf('### Effective cover labels'),
    );
    expect(optionsTable.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(9);
    expect(optionsTable).toContain(
      '| Composition ID | <code>"cover&#124;````````id\\nnext"</code> |',
    );
    expect(optionsTable).toContain(
      '| Manifest path | <code>"manifest&#124;`timeline`.json\\nnext"</code> |',
    );
    expect(optionsTable).toContain(
      '| GSAP path | <code>"vendor/&lt;gsap&gt;&#124;``.js\\nnext"</code> |',
    );
    expect(optionsTable).toContain(
      '| CTA destination | <code>"www.example.test/&#124;`learn`\\nnext"</code> |',
    );
    expect(optionsTable).toContain(
      '| Locale | <code>"en&#124;`US`\\nnext"</code> (card chrome, `<html lang>`) |',
    );
    expect(readme).toContain(
      'one data-composition-id=<code>"cover&#124;````````id\\nnext"</code> stage',
    );
    expect(readme).toContain(
      '- <code>"manifest&#124;`timeline`.json\\nnext"</code> — the `VideoTimeline` manifest',
    );
    expect(readme).toContain(
      '- <code>"vendor/&lt;gsap&gt;&#124;``.js\\nnext"</code> — vendored GSAP',
    );
    expect(readme).not.toContain('- `manifest|');
    expect(readme).not.toContain('- `vendor/<gsap>');

    // The longest run is eight backticks in a serialized option, so the labels
    // block uses a nine-backtick fence and cannot terminate early.
    expect(readme).toContain('`````````json\n{');
    expect(readme).toContain('\n`````````\n\n## Verify');
    expect(readme).toContain('"quiz": "Quiz | <unsafe> & `tick` then `````` fence\\nnext"');
    expect(readme).not.toContain('\n```json\n');
  });

  it('renders an escaped, non-interactive, two-line CTA throughout Quiz and PBL covers', () => {
    const ctaHtml = emitHyperframes(ir, {
      width: 1280,
      height: 720,
      labels: {
        quizCtaPrompt: 'Try the quiz',
        pblCtaPrompt: 'Explore the project',
        ctaVisit: 'Visit',
      },
      cta: { destination: 'www.example.test/<learn>' },
    }).files.find((file) => file.path === 'index.html')!.content;

    expect(ctaHtml.match(/class="cover-cta"/g)).toHaveLength(2);
    expect(ctaHtml.match(/class="cover-cta-line"/g)).toHaveLength(4);
    expect(ctaHtml).toContain('<div class="cover-cta-line">Try the quiz</div>');
    expect(ctaHtml).toContain('<div class="cover-cta-line">Explore the project</div>');
    expect(
      ctaHtml.match(/Visit <bdi dir="ltr">www\.example\.test\/&lt;learn&gt;<\/bdi>/g),
    ).toHaveLength(2);
    expect(ctaHtml).not.toContain('<a');
    expect(ctaHtml).not.toContain('<button');
    expect(ctaHtml).not.toContain('href=');
    expect(ctaHtml).not.toContain('onclick=');
    expect(ctaHtml).not.toMatch(/tl\.[^(]+\([^)]*cover-cta/);

    const quizStart = ctaHtml.indexOf('class="clip cover-card cover-quiz"');
    const pblStart = ctaHtml.indexOf('class="clip cover-card cover-pbl"');
    const quizStats = ctaHtml.indexOf('class="cover-stats cover-quiz-stats"', quizStart);
    const quizCta = ctaHtml.indexOf('class="cover-cta"', quizStats);
    const pblMeta = ctaHtml.indexOf('class="cover-pbl-meta"', pblStart);
    const pblCta = ctaHtml.indexOf('class="cover-cta"', pblMeta);
    expect(quizStart).toBeLessThan(quizStats);
    expect(quizStats).toBeLessThan(quizCta);
    expect(quizCta).toBeLessThan(pblStart);
    expect(pblStart).toBeLessThan(pblMeta);
    expect(pblMeta).toBeLessThan(pblCta);

    const disabledHtml = emitHyperframes(ir, { cta: null }).files.find(
      (file) => file.path === 'index.html',
    )!.content;
    expect(disabledHtml).not.toContain('class="cover-cta"');
  });

  it('lets authored cover and subtitle leaves resolve their own direction', () => {
    const bidi = emitHyperframes(ir, {
      width: 1280,
      height: 720,
      locale: 'ar-SA',
      cta: { destination: 'www.example.test' },
    }).files.find((file) => file.path === 'index.html')!.content;
    const subtitleBidi = emitHyperframes(compileSample(), {
      width: 1280,
      height: 720,
      burnInSubtitles: true,
    }).files.find((file) => file.path === 'index.html')!.content;

    expect(bidi.match(/<h1 class="cover-title" dir="auto">/g)).toHaveLength(2);
    expect(bidi).toContain('<p class="cover-description" dir="auto"');
    expect(bidi.match(/class="cover-gain-text" dir="auto"/g)).toHaveLength(2);
    expect(bidi).toContain('<strong dir="auto">Dr. &lt;Guide&gt;</strong>');
    expect(bidi).toContain('<small dir="auto">Helps you reason &amp; test</small>');
    expect(subtitleBidi).toMatch(/id="subtitle-cue-0"[^>]*dir="auto"/);
    expect(bidi).toContain('<html lang="ar-SA">');
    expect(bidi).not.toMatch(/<html[^>]*\sdir=["'](?:rtl|auto)["']/);
    expect(bidi.match(/class="cover-panel [^"]+" dir="rtl"/g)).toHaveLength(2);
    expect(bidi).toContain('<bdi dir="ltr">www.example.test</bdi>');
    // Locale-owned chrome inherits the explicitly-scoped panel direction.
    expect(bidi).toContain('<div class="cover-eyebrow"><span');
    expect(bidi).not.toContain('class="cover-eyebrow" dir="auto"');
    expect(bidi).not.toContain('class="cover-section-label" dir="auto"');
  });

  it('omits the people row entirely when the project authored no instructor', () => {
    const bare = [
      {
        id: 'pbl-bare',
        stageId: 'stage',
        title: 'Bare PBL',
        order: 0,
        type: 'pbl',
        content: { type: 'pbl', projectV2: { title: 'Bare', description: '' } },
        actions: [],
      },
    ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
    const bareIr = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Bare' }, scenes: bare },
      { timing: stubProbe(), assets: stubAssets() },
    );
    const bareHtml = emitHyperframes(bareIr, {
      width: 1280,
      labels: { instructor: '导师', instructorTagline: '全程陪伴你完成项目' },
    }).files.find((file) => file.path === 'index.html')!.content;

    // A card with nobody on it must not invent a "Tutor" whose name is the word
    // "Tutor" — the stage/task counts stand alone (#995 review).
    expect(bareHtml).not.toContain('<div class="cover-people">');
    expect(bareHtml).not.toContain('cover-person-instructor');
    expect(bareHtml).not.toContain('全程陪伴你完成项目');
    expect(bareHtml).toContain('cover-stats');
  });

  it('keeps the instructor row when the project authored one, with a tagline fallback', () => {
    const named = [
      {
        id: 'pbl-named',
        stageId: 'stage',
        title: 'Named PBL',
        order: 0,
        type: 'pbl',
        content: {
          type: 'pbl',
          projectV2: {
            title: 'Named',
            description: '',
            roles: [{ id: 'i', type: 'instructor', name: '林教练' }],
          },
        },
        actions: [],
      },
    ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
    const namedIr = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Named' }, scenes: named },
      { timing: stubProbe(), assets: stubAssets() },
    );
    const namedHtml = emitHyperframes(namedIr, {
      width: 1280,
      labels: { instructor: '导师', instructorTagline: '全程陪伴你完成项目' },
    }).files.find((file) => file.path === 'index.html')!.content;

    expect(namedHtml).toContain(
      '<strong dir="auto">林教练</strong><small dir="auto">全程陪伴你完成项目</small>',
    );
    expect(namedHtml).toContain('<div class="cover-avatar">林</div>');
  });

  it('escapes authored text, excludes runtime/internal data, and clamps pathological text', () => {
    expect(html).toContain('Quiz &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("title")</script>');
    expect(html).not.toMatch(/SECRET_(ANSWER|PERSONA|SITUATION|CHARACTER_PERSONA|CHAT|SUBMISSION)/);
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('-webkit-line-clamp:3');
    expect(html).toContain('-webkit-line-clamp:2');
  });

  /**
   * The stage is a fixed-pixel box, so a card written in raw px would render at
   * 720p type size inside a 4K frame. Every cover length must scale with the
   * render width — and never with the browser viewport (`vw`), which differs
   * between `hyperframes preview` and `hyperframes render`.
   */
  it('scales cover typography and panel width with the render resolution', () => {
    const at = (width: number) =>
      emitHyperframes(ir, { width }).files.find((file) => file.path === 'index.html')!.content;
    const hd = at(1280);
    const uhd = at(3840);

    expect(hd).toContain('.cover-stat strong { color:#fff;font-size:28px');
    expect(uhd).toContain('.cover-stat strong { color:#fff;font-size:84px');
    expect(hd).toContain('font-size:52px;line-height:1.08');
    expect(uhd).toContain('font-size:156px;line-height:1.08');
    expect(hd).toContain('width:min(88%,1040px)');
    expect(uhd).toContain('width:min(88%,3120px)');
    // Smallest label and hairline borders survive at 720p and grow with 4K.
    expect(hd).toMatch(/\.cover-person-copy span \{[^}]*font-size:9px/);
    expect(uhd).toMatch(/\.cover-person-copy span \{[^}]*font-size:27px/);
    expect(hd).toContain('border:1px solid rgba(255,255,255,.13)');
    expect(uhd).toContain('border:3px solid rgba(255,255,255,.13)');

    for (const css of [hd, uhd]) {
      expect(css).not.toMatch(/\.cover-[\w-]+[^}]*\d(?:\.\d+)?vw/);
      expect(css).not.toContain('clamp(');
    }
  });
});

/**
 * A PBL card carrying every supported field in long CJK is the densest thing the
 * exporter can produce. The panel is a fixed box, so the emitter decides which
 * sections survive — scene type, title and the stage/task counts always do, the
 * detail rows give way in reverse priority (#995 review).
 */
describe('emitHyperframes cover cards at constrained resolutions', () => {
  const dense = [
    {
      id: 'pbl-dense',
      stageId: 'stage',
      title: 'PBL',
      order: 0,
      type: 'pbl',
      content: {
        type: 'pbl',
        projectV2: {
          title: '构建一个确定性、离线可验证且支持超长中文标题排版的课程渲染导出流水线',
          description:
            '本项目要求你从设计数据出发，完成建模、实现与验证三个阶段，并在真实的 720p 与 480p 导出中确认排版不会撑破画面，同时保证字幕与封面共存。',
          gains: [
            '把设计期数据与运行时状态彻底分离，确保导出结果可复现',
            '验证 HTML 转义、时间边界与超长英文单词换行的实际表现',
            '在无网络条件下生成可复现的视频产物并通过 lint 校验',
            '为受限分辨率定义信息优先级，避免面板被静默裁切',
          ],
          roles: [
            {
              id: 'instructor',
              type: 'instructor',
              name: '导出教练',
              description: '帮助你逐步推进确定性渲染、排查边界并完成发布验证。',
            },
          ],
          milestones: [
            { id: 'm1', microtasks: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] },
            { id: 'm2', microtasks: [{ id: 't4' }, { id: 't5' }] },
            { id: 'm3', microtasks: [{ id: 't6' }] },
          ],
          scenario: { characters: [{ id: 'reviewer', name: '发布评审员' }] },
        },
      },
      actions: [],
    },
  ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: 'Dense' }, scenes: dense },
    { timing: stubProbe(), assets: stubAssets() },
  );
  const at = (width: number, height: number) =>
    emitHyperframes(ir, { width, height }).files.find((file) => file.path === 'index.html')!
      .content;

  it('preserves five gains before layout degradation is necessary', () => {
    const fiveGainScene = [
      {
        id: 'pbl-five-gains',
        stageId: 'stage',
        title: 'PBL',
        order: 0,
        type: 'pbl',
        content: {
          type: 'pbl',
          projectV2: {
            title: 'Compact project',
            description: 'A compact project description.',
            gains: ['Gain one', 'Gain two', 'Gain three', 'Gain four', 'Gain five'],
            milestones: [{ id: 'm1', microtasks: [{ id: 't1' }] }],
          },
        },
        actions: [],
      },
    ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
    const fiveGainIr = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Five gains' }, scenes: fiveGainScene },
      { timing: stubProbe(), assets: stubAssets() },
    );
    const fiveGainHtml = emitHyperframes(fiveGainIr, {
      width: 1280,
      height: 720,
      cta: { destination: 'open.maic.chat' },
    }).files.find((file) => file.path === 'index.html')!.content;

    expect(fiveGainHtml.match(/class="cover-gain-text"/g)).toHaveLength(5);
    expect(fiveGainHtml).toContain('Gain five');
    expect(fiveGainHtml).toContain('<strong>1</strong><span>Stages</span>');
    expect(fiveGainHtml).toContain('<div class="cover-cta">');
  });

  it('degrades optional PBL content in the people, 5→4→2→0, description order', () => {
    const ladderScene = [
      {
        id: 'pbl-degradation-ladder',
        stageId: 'stage',
        title: 'PBL',
        order: 0,
        type: 'pbl',
        content: {
          type: 'pbl',
          projectV2: {
            title: 'A compact project title',
            description:
              'A description long enough to occupy three planned lines while the frame height decreases through every degradation threshold in one-pixel steps.',
            gains: [
              'First compact gain',
              'Second compact gain',
              'Third compact gain',
              'Fourth compact gain',
              'Fifth compact gain',
            ],
            roles: [
              {
                id: 'instructor',
                type: 'instructor',
                name: 'Export Coach',
                description: 'Keeps the project moving.',
              },
            ],
            milestones: [{ id: 'm1', microtasks: [{ id: 't1' }] }],
          },
        },
        actions: [],
      },
    ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
    const ladderIr = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Degradation ladder' }, scenes: ladderScene },
      { timing: stubProbe(), assets: stubAssets() },
    );

    const signatures: string[] = [];
    for (let height = 900; height >= 260; height -= 1) {
      const ladderHtml = emitHyperframes(ladderIr, {
        width: 1280,
        height,
        cta: { destination: 'open.maic.chat' },
      }).files.find((file) => file.path === 'index.html')!.content;
      const people = ladderHtml.includes('<div class="cover-people">') ? 'people' : 'no-people';
      const gains = ladderHtml.match(/class="cover-gain-text"/g)?.length ?? 0;
      const description = ladderHtml.match(
        /class="cover-description" dir="auto" style="-webkit-line-clamp:(\d)"/,
      )?.[1];
      const signature = `${people}/${gains}/${description ?? 0}`;
      if (signatures.at(-1) !== signature) signatures.push(signature);
    }

    expect(signatures).toEqual([
      'people/5/3',
      'no-people/5/3',
      'no-people/4/3',
      'no-people/2/3',
      'no-people/0/3',
      'no-people/0/2',
      'no-people/0/0',
    ]);
    // Core content survives even after every optional section is gone.
    const shortest = emitHyperframes(ladderIr, {
      width: 1280,
      height: 260,
      cta: { destination: 'open.maic.chat' },
    }).files.find((file) => file.path === 'index.html')!.content;
    expect(shortest).toContain('<strong>1</strong><span>Stages</span>');
    expect(shortest).toContain('<div class="cover-cta">');
  });

  it('uses the 0.64 digit width at the people-retention planner threshold', () => {
    const digitThresholdScene = [
      {
        id: 'pbl-digit-threshold',
        stageId: 'stage',
        title: 'PBL',
        order: 0,
        type: 'pbl',
        content: {
          type: 'pbl',
          projectV2: {
            // At 25 digits, 0.64em crosses the title from one planned line to
            // two; the lowercase fallback 0.62em remains one line.
            title: '0123456789012345678901234',
            description: '',
            gains: [],
            roles: [
              {
                id: 'instructor',
                type: 'instructor',
                name: 'Digit Coach',
                description: 'Keeps this threshold observable.',
              },
            ],
            milestones: [{ id: 'm1', microtasks: [{ id: 't1' }] }],
          },
        },
        actions: [],
      },
    ] as Parameters<typeof compileVideoTimeline>[0]['scenes'];
    const digitThresholdIr = compileVideoTimeline(
      { stage: { id: 'stage', name: 'Digit threshold' }, scenes: digitThresholdScene },
      { timing: stubProbe(), assets: stubAssets() },
    );
    const digitThresholdHtml = emitHyperframes(digitThresholdIr, {
      width: 1280,
      height: 540,
      cta: { destination: 'open.maic.chat' },
    }).files.find((file) => file.path === 'index.html')!.content;

    // The required 0.64em digit class plans a second title line, so people are
    // the first optional block to degrade. Regressing to 0.62em retains them.
    expect(digitThresholdHtml).not.toContain('<div class="cover-people">');
    expect(digitThresholdHtml).toContain('<strong>1</strong><span>Stages</span>');
    expect(digitThresholdHtml).toContain('<div class="cover-cta">');
  });

  it('keeps the whole card at 1280x720', () => {
    const hd = at(1280, 720);

    expect(hd).toContain('构建一个确定性');
    expect(hd).toContain('<strong>3</strong><span>Stages</span>');
    expect(hd).toContain('<strong>6</strong><span>Tasks</span>');
    expect(hd).toContain("What you'll gain");
    expect(hd).toContain('导出教练');
    expect(hd).toContain('发布评审员');
  });

  it('drops the people row at 854x480, where its caption type stops being legible', () => {
    const sd = at(854, 480);

    expect(sd).toContain('构建一个确定性');
    expect(sd).toContain('<strong>3</strong><span>Stages</span>');
    expect(sd).toContain('<strong>6</strong><span>Tasks</span>');
    expect(sd).not.toContain('<div class="cover-people">');
    expect(sd).not.toContain('导出教练');
    expect(sd).not.toContain('发布评审员');
  });

  it('sheds gains before the title and counts when the panel runs out of room', () => {
    // A 1280x480 frame keeps the full-size type but halves the vertical room,
    // so the budget forces more than the people row out.
    const squat = at(1280, 480);

    expect(squat).toContain('构建一个确定性');
    expect(squat).toContain('<strong>3</strong><span>Stages</span>');
    expect(squat).not.toContain('<div class="cover-people">');
    expect(squat).not.toContain("What you'll gain");
  });
});

describe('emitHyperframes multi-cue subtitle positioning (regression)', () => {
  // A scene with several narration cues; the earlier cut left inactive cues in
  // layout (visibility:hidden + inline-block), so the band grew multiple rows
  // tall and the active cue drifted up into the slide/title area.
  const ir = compileVideoTimeline(
    {
      stage: { id: 'stage', name: 'Multi Cue' },
      scenes: [
        slide(
          'intro',
          [
            speech('sp1', 'First caption line', { audioId: 'a1' }),
            speech('sp2', 'Second caption line', { audioId: 'a2' }),
            speech('sp3', 'Third caption line', { audioId: 'a3' }),
          ],
          { title: 'Intro', elements: [] },
        ),
      ],
    },
    {
      timing: stubProbe({ sp1: 2000, sp2: 2000, sp3: 2000 }, {}),
      assets: stubAssets({ sp1: audioMeta('a1'), sp2: audioMeta('a2'), sp3: audioMeta('a3') }, {}),
    },
  );
  const html = emitHyperframes(ir, { width: 1920, height: 1080, burnInSubtitles: true }).files.find(
    (f) => f.path === 'index.html',
  )!.content;

  it('stacks every cue in one grid cell so the active cue never shifts', () => {
    // All cues share grid-area 1/1 — one slot, not one row each.
    const cueCount = (html.match(/id="subtitle-cue-\d+"/g) ?? []).length;
    expect(cueCount).toBe(3);
    expect(html.match(/grid-area:1\/1/g)?.length).toBe(3);
    expect(html).toContain('id="subtitles" style="position:absolute');
    // The container is a grid so the single occupied cell owns the whole band.
    expect(html).toMatch(/id="subtitles"[^>]*display:grid/);
  });

  it('removes inactive cues from layout (display:none, never visibility:hidden)', () => {
    // Every cue starts display:none; toggled cues use display, not visibility —
    // a visibility-hidden cue would keep its box and push the active one out of slot.
    for (let i = 0; i < 3; i++) {
      expect(html).toMatch(new RegExp(`id="subtitle-cue-${i}"[^>]*display:none`));
      expect(html).toContain(`tl.set('#subtitle-cue-${i}',{display:'-webkit-box'}`);
      expect(html).toContain(`tl.set('#subtitle-cue-${i}',{display:'none'}`);
    }
    expect(html).not.toContain('visibility:hidden');
    expect(html).not.toContain("visibility:'hidden'");
  });
});

describe('emitHyperframes determinism red-lines (hyperframes lint proxy)', () => {
  const project = emitHyperframes(compileSample());
  const html = project.files.find((f) => f.path === 'index.html')!.content;

  it('loads no script or asset from an http(s) origin (no CDN)', () => {
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it('embeds its primary font so Hyperframes never resolves Google Fonts', () => {
    expect(html).toContain('@font-face');
    expect(html).toContain('font-family: "Inter"');
    expect(html).toMatch(/src:\s*url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/);
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('uses no non-deterministic runtime APIs', () => {
    expect(html).not.toContain('Date.now');
    expect(html).not.toContain('Math.random');
    expect(html).not.toContain('requestAnimationFrame');
    expect(html).not.toContain('setTimeout');
    expect(html).not.toContain('setInterval');
  });

  it('uses no infinite repeats (finite ring pulse only)', () => {
    expect(html).not.toContain('repeat:-1');
    expect(html).not.toContain('repeat: -1');
    expect(html).not.toContain('Infinity');
  });

  it('declares an explicit root duration and extends the timeline to it', () => {
    expect(html).toMatch(/data-duration="[\d.]+"/);
    expect(html).toMatch(/tl\.set\(\{\}, \{\}, [\d.]+\);/);
  });
});
