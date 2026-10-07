/**
 * A small but complete classroom for the standalone HTML export: one scene of
 * every kind the player supports, deliberately stored out of play order, with
 * markup-like text that must survive embedding.
 */
import type { Scene, Stage } from '@/lib/types/stage';

/** 8x8 PNG (green), base64. */
export const FIXTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQOhqHFTEMLQkAsJlRQXS/RwMAAAAASUVORK5CYII=';

export interface StandaloneFixtureMedia {
  /** Ref of the slide image whose bytes live in the export archive. */
  archivedImageRef: string;
  /** Concrete URL of a slide image fetched at export time. */
  remoteImageUrl: string;
}

export const DEFAULT_FIXTURE_MEDIA: StandaloneFixtureMedia = {
  archivedImageRef: 'ast_leaf_diagram',
  remoteImageUrl: 'https://images.example.com/chloroplast.png',
};

const theme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Arial',
};

export const FIXTURE_INTERACTIVE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Light lab</title>
<style>body{font-family:sans-serif;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#f0fdf4}
#rate{font-size:48px;font-weight:700;color:#15803d}</style></head>
<body><h1>Light intensity lab</h1>
<input id="light" type="range" min="0" max="100" value="40" aria-label="Light intensity">
<p>Photosynthesis rate: <span id="rate">40</span></p>
<p id="note">Drag the slider to change the light.</p>
<script>
  const light = document.getElementById('light');
  const rate = document.getElementById('rate');
  const closing = '</scr' + 'ipt>'; // markup-like text inside the page's own script
  light.addEventListener('input', () => { rate.textContent = String(Math.round(Math.min(100, light.value * 1.2))); });
  document.body.dataset.ready = 'true';
</script>
</body></html>`;

export function standaloneFixtureStage(stageId: string): Stage {
  return {
    id: stageId,
    name: 'Photosynthesis: <Light> & "Life"',
    description: 'How plants turn light into chemical energy.',
    style: 'professional',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  } as Stage;
}

/** Scenes in storage order (not play order): quiz, slide, pbl, interactive. */
export function standaloneFixtureScenes(
  stageId: string,
  media: StandaloneFixtureMedia = DEFAULT_FIXTURE_MEDIA,
): Scene[] {
  const quiz = {
    id: 'scene-quiz',
    stageId,
    type: 'quiz',
    title: 'Check your understanding',
    order: 2,
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question: 'Where in the cell does photosynthesis take place?',
          options: [
            { value: 'A', label: 'Mitochondria' },
            { value: 'B', label: 'Chloroplasts' },
            { value: 'C', label: 'Nucleus' },
            { value: 'D', label: 'Ribosomes' },
          ],
          answer: ['B'],
          analysis: 'Chloroplasts contain chlorophyll, which captures light energy.',
          hasAnswer: true,
          points: 1,
        },
        {
          id: 'q2',
          type: 'multiple',
          question: 'Which are inputs of photosynthesis? </script><!-- not markup -->',
          options: [
            { value: 'A', label: 'Carbon dioxide' },
            { value: 'B', label: 'Oxygen' },
            { value: 'C', label: 'Water' },
            { value: 'D', label: 'Glucose' },
          ],
          answer: ['A', 'C'],
          analysis: 'CO2 and water go in; glucose and oxygen come out.',
          hasAnswer: true,
          points: 2,
        },
        {
          id: 'q3',
          type: 'short_answer',
          question: 'In one sentence, why do leaves look green?',
          analysis: 'Chlorophyll absorbs red and blue light and reflects green light.',
          hasAnswer: false,
          points: 2,
        },
      ],
    },
  } as Scene;

  const slide = {
    id: 'scene-slide',
    stageId,
    type: 'slide',
    title: 'What is photosynthesis?',
    order: 0,
    content: {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme,
        background: { type: 'solid', color: '#f8fafc' },
        elements: [
          {
            type: 'text',
            id: 'title',
            left: 60,
            top: 40,
            width: 880,
            height: 70,
            rotate: 0,
            content:
              '<p><strong><span style="font-size: 36px;">What is photosynthesis?</span></strong></p>',
            defaultFontName: 'Arial',
            defaultColor: '#14532d',
          },
          {
            type: 'text',
            id: 'body',
            left: 60,
            top: 140,
            width: 480,
            height: 260,
            rotate: 0,
            content:
              '<ul><li><p>Plants convert light energy into chemical energy.</p></li><li><p>Inputs: carbon dioxide and water.</p></li><li><p>Outputs: glucose and oxygen.</p></li></ul>',
            defaultFontName: 'Arial',
            defaultColor: '#334155',
          },
          {
            type: 'shape',
            id: 'accent',
            left: 60,
            top: 120,
            width: 880,
            height: 4,
            rotate: 0,
            viewBox: [200, 200],
            path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
            fixedRatio: false,
            fill: '#22c55e',
          },
          {
            type: 'image',
            id: 'leaf',
            left: 580,
            top: 140,
            width: 170,
            height: 170,
            rotate: 0,
            fixedRatio: true,
            src: media.archivedImageRef,
          },
          {
            type: 'image',
            id: 'chloroplast',
            left: 770,
            top: 140,
            width: 170,
            height: 170,
            rotate: 0,
            fixedRatio: true,
            src: media.remoteImageUrl,
          },
          {
            type: 'chart',
            id: 'chart',
            left: 580,
            top: 330,
            width: 360,
            height: 200,
            rotate: 0,
            chartType: 'bar',
            data: {
              labels: ['Low', 'Medium', 'High'],
              legends: ['Rate'],
              series: [[20, 55, 80]],
            },
            themeColors: ['#22c55e'],
          },
        ],
      },
    },
    actions: [{ id: 'speech-1', type: 'speech', text: 'Let us look at photosynthesis.' }],
  } as Scene;

  const interactive = {
    id: 'scene-interactive',
    stageId,
    type: 'interactive',
    title: 'Light intensity lab',
    order: 1,
    content: { type: 'interactive', html: FIXTURE_INTERACTIVE_HTML },
  } as Scene;

  const pbl = {
    id: 'scene-pbl',
    stageId,
    type: 'pbl',
    title: 'Design a greenhouse',
    order: 3,
    content: {
      type: 'pbl',
      projectV2: {
        uiPhase: 'hero',
        title: 'Design a school greenhouse',
        description: 'Plan a small greenhouse that maximizes plant growth on a budget.',
        learningObjective: 'Apply the limiting factors of photosynthesis to a real design.',
        tags: ['biology'],
        language: 'en-US',
        proficiency: 'beginner',
        status: 'active',
        scenario: {
          setting: 'Your school wants a greenhouse for the science club.',
          goal: 'Present a design the principal can approve.',
          learnerRole: 'Lead designer',
          characters: [{ id: 'c1', name: 'Ms. Rivera', persona: 'Principal who cares about cost' }],
        },
        roles: [{ id: 'r1', type: 'instructor', name: 'Coach' }],
        milestones: [
          {
            id: 'm1',
            title: 'Research limiting factors',
            description: 'Find out what limits plant growth indoors.',
            status: 'active',
            order: 0,
            microtasks: [
              {
                id: 't1',
                title: 'List the factors',
                description: 'Light, CO2, temperature, water.',
                status: 'todo',
                assignee: 'user',
                hints: [],
                order: 0,
              },
            ],
          },
          {
            id: 'm2',
            title: 'Sketch the design',
            status: 'locked',
            order: 1,
            microtasks: [],
          },
        ],
        submissions: [],
        evaluations: [],
        threads: [],
        engagementEvents: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  } as Scene;

  return [quiz, slide, pbl, interactive];
}
