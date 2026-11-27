/**
 * Reproduce the English decision-label screenshots from OpenMAIC PR #2430.
 * Run from the public feature checkout at 738bced0a, with baseline 7df05ba92
 * available in Git, dependencies installed using pnpm install --frozen-lockfile,
 * and the browser installed using pnpm exec playwright install chromium.
 *
 * Usage: node render.cjs OUTPUT_DIRECTORY
 * The checkout supplies the shared UI and styles; each revision supplies its
 * own decision form and English translations. No server or login is needed.
 */
const { createRequire } = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const repo = process.cwd();
if (!process.argv[2]) throw new Error('Usage: node render.cjs OUTPUT_DIRECTORY');
const dest = path.resolve(process.argv[2]);
const req = createRequire(path.join(repo, 'package.json'));
const baseline = '7df05ba921937f8794af00f74144d89875320b79';
const feature = '738bced0a60a630a864c1b0205b191b5540d1486';
const synthetic = {
  goal: 'Use the rehearsal log to restore the requested lighting scene.',
  title: 'Restore the rehearsal scene',
  prompt:
    'The lighting console loaded the wrong scene. What would you change, and what does the log show?',
  responseLabel: 'How would you change the scene loading flow?',
  rationaleLabel: 'Which rehearsal log entry supports this change?',
  chosen: 'Load the scene saved for the requested rehearsal version.',
  rationale: 'The log shows that the console requested R3 but loaded R2.',
};
const cases = [
  {
    file: 'before.png',
    before: true,
    fixture: {
      ...synthetic,
      prompt: 'Describe the problem, your evidence, and how you would fix it.',
    },
  },
  { file: 'after.png', fixture: synthetic },
];
const versionedPaths = [
  'components/scene-renderers/pbl/v3/decision-response.tsx',
  'lib/i18n/locales/en-US.json',
];
// Render the normal drawer, form and composer in an isolated workbench pane.
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageSquareText } from 'lucide-react';
import { DecisionResponseForm } from './components/scene-renderers/pbl/v3/decision-response';
import { TaskDock } from './components/scene-renderers/pbl/v3/task-dock';
import { LearnerComposer } from './components/scene-renderers/pbl/v3/learner-composer';
import { I18nProvider, useI18n } from './lib/hooks/use-i18n';
import { loadLocaleResource } from './lib/i18n/load-resource';
const f = window.fixture;
const view = {
  id: 'demo-scene',
  state: {
    status: 'active',
    position: { milestoneIndex: 0, milestoneId: 'm1', stageIndex: 1 },
    milestones: [{ status: 'active' }],
  },
  milestones: [
    {
      id: 'm1',
      title: f.title,
      goal: f.goal,
      stages: ['teaching', 'dialogue', 'plan', 'code', 'test', 'quiz', 'recap'],
    },
  ],
  stage: { kind: 'dialogue' },
  actions: ['chat', 'decide'],
};
function Pane() {
  const { t } = useI18n();
  const [draft, setDraft] = useState();
  const [chat, setChat] = useState('');
  const decision = {
    id: 'restore-scene',
    prompt: f.prompt,
    responseType: 'text',
    requiresRationale: true,
    options: [],
    ...(f.before
      ? {}
      : { responseLabel: f.responseLabel, rationaleLabel: f.rationaleLabel }),
  };
  return (
    <div className="pbl-workbench" id="frame">
      <section className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <header className="pbl-pane-header pbl-chrome relative z-30 flex shrink-0 items-center gap-2 border-b px-3 text-xs">
          <MessageSquareText size={15} />
          <h3 className="min-w-0 truncate font-semibold">
            {t('pblV3.learning')}
          </h3>
          <span className="ml-auto truncate text-muted-foreground">
            {t('pblV3.roles.discussion')}
          </span>
        </header>
        <div className="pbl-task-area flex min-h-0 flex-1 flex-col">
          <div className="flex-1" aria-hidden="true">
            <div className="pbl-assistant-bubble" id="bubble-tail"></div>
          </div>
          <TaskDock view={view} action={null}>
            <DecisionResponseForm
              decision={decision}
              draft={draft}
              onDraftChange={setDraft}
              disabled={false}
              onSubmit={async (chosen, rationale) => {
                window.submitted = { chosen, rationale };
                return true;
              }}
            />
          </TaskDock>
        </div>
        <form
          className="shrink-0 border-t bg-background p-3"
          id="composer-wrap"
        >
          <LearnerComposer
            id="demo-chat"
            classic
            text={chat}
            onTextChange={setChat}
            onSend={() => {}}
            speechActive={false}
            onSpeechActiveChange={() => {}}
          />
        </form>
      </section>
    </div>
  );
}
loadLocaleResource('en-US').then((initialResources) =>
  createRoot(document.getElementById('app')).render(
    <I18nProvider initialLocale="en-US" initialResources={initialResources}>
      <Pane />
    </I18nProvider>,
  ),
);
`;
async function build(revision) {
  const files = new Map();
  for (const name of versionedPaths)
    files.set(
      path.join(repo, name),
      execFileSync('git', ['show', revision + ':' + name], { cwd: repo, encoding: 'utf8' }),
    );
  const js = await req('esbuild').build({
    absWorkingDir: repo,
    stdin: { contents: entry, resolveDir: repo, loader: 'tsx' },
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2022',
    bundle: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'historical-files',
        setup(b) {
          // Voice is disabled for this local screenshot. Leave the native composer intact.
          b.onLoad({ filter: /\/audio\/speech-button\.tsx$/ }, () => ({
            contents:
              "export function SpeechButton(){throw new Error('Voice is disabled in this fixture.')}",
          }));
          b.onLoad({ filter: /(decision-response\.tsx|en-US\.json)$/ }, (args) => {
            if (files.has(args.path))
              return {
                contents: files.get(args.path),
                loader: args.path.endsWith('.json') ? 'json' : 'tsx',
                resolveDir: path.dirname(args.path),
              };
          });
        },
      },
    ],
  });
  return js.outputFiles[0].text;
}
async function run() {
  await fs.mkdir(dest, { recursive: true });
  const globals = path.join(repo, 'app/globals.css');
  const css =
    (
      await req('postcss')([req('@tailwindcss/postcss')({ base: repo })]).process(
        await fs.readFile(globals, 'utf8'),
        { from: globals },
      )
    ).css +
    (await fs.readFile(path.join(repo, 'components/scene-renderers/pbl/v3/workbench.css'), 'utf8'));
  // The crop and reviewer annotation are shared by both images.
  const frameCSS = `
html,
body {
  margin: 0;
  overflow: hidden;
  scrollbar-gutter: auto;
  font-family: var(--font-sans);
}
html {
  font-size: 16.6px;
}
#frame {
  position: absolute;
  top: 4px;
  left: 0;
  width: 773px;
  height: 790px;
  border-top: 1px solid #dce3ec;
  border-left: 4px solid #dce3ec;
}
#composer-wrap {
  height: 169px;
}
#composer-wrap [data-testid='pbl-learner-composer'] {
  height: 136px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
#bubble-tail {
  height: 13px;
  border-bottom-left-radius: 16px;
  border-bottom-right-radius: 16px;
  border-left: 2px solid #b0e3fa;
  margin: 0 12px 0 16px;
}
#red-frame {
  position: fixed;
  box-sizing: border-box;
  border: 4px solid #f44a47;
  border-radius: 5px;
  pointer-events: none;
  z-index: 1000;
}
`;
  const html =
    '<!doctype html><html lang="en-US"><meta charset="utf-8"><style>' +
    css +
    frameCSS +
    '</style><div id="app"></div><div id="red-frame"></div></html>';
  const [afterBundle, beforeBundle] = await Promise.all([build(feature), build(baseline)]);
  const browser = await req('@playwright/test').chromium.launch({ headless: true });
  try {
    for (const { file, before = false, fixture } of cases) {
      const page = await browser.newPage({
        locale: 'en-US',
        viewport: { width: 1200, height: 774 },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setContent(html);
      await page.evaluate(
        (f) => {
          window.fixture = f;
        },
        { ...fixture, before },
      );
      await page.addScriptTag({ content: before ? beforeBundle : afterBundle });
      await page.getByRole('button', { name: 'Current task', exact: true }).click();
      const group = page.getByRole('group', { name: fixture.prompt, exact: true });
      const chosen = group.getByRole('textbox', {
        name: before ? 'Your decision' : fixture.responseLabel,
        exact: true,
      });
      const rationale = group.getByRole('textbox', {
        name: before ? 'Why did you choose this?' : fixture.rationaleLabel,
        exact: true,
      });
      await chosen.fill(fixture.chosen);
      await rationale.fill(fixture.rationale);
      const submit = group.getByRole('button', { name: 'Submit decision', exact: true });
      assert.equal(await submit.isEnabled(), true);
      const geom = await page.evaluate(() => {
        const form = document.querySelector('[data-testid="pbl-decision-response"]');
        const drawer = document.querySelector('.pbl-task-drawer');
        const scroll = drawer.querySelector('.overflow-y-auto');
        scroll.scrollTop = scroll.scrollHeight;
        function rect(el) {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        }
        return {
          form: rect(form),
          rationale: rect(form.querySelectorAll('textarea')[1]),
          drawer: rect(drawer),
          dock: rect(document.querySelector('.pbl-task-dock')),
        };
      });
      await page.evaluate((g) => {
        const mark = document.getElementById('red-frame');
        mark.style.left = '9px';
        mark.style.width = '750px';
        mark.style.top = g.form.y - 8 + 'px';
        mark.style.height = g.rationale.y + g.rationale.height + 9 - (g.form.y - 8) + 'px';
      }, geom);
      await page.mouse.move(1190, 765);
      await page.screenshot({
        path: path.join(dest, file),
        clip: { x: 0, y: 0, width: 766, height: 774 },
        caret: 'initial',
      });
      await submit.click();
      assert.deepEqual(await page.evaluate(() => window.submitted), {
        chosen: fixture.chosen,
        rationale: fixture.rationale,
      });
      assert.deepEqual(errors, []);
      console.log(file, 'passed input label and submission assertions');
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
