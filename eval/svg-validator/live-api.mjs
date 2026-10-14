/** Real server orchestration, persistence, and classroom integration smoke test. */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const app = process.env.SVG_EVAL_APP_URL || 'http://localhost:3003';
const output = 'eval/svg-validator/results/live-api';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en-US');
    localStorage.setItem(
      'maic:account:settings-storage',
      JSON.stringify({ state: { sidebarCollapsed: false }, version: 5 }),
    );
  });
  await page.goto(app);
  const config = await (await page.request.get(app + '/api/model-config')).json();
  const response = await page.request.put(app + '/api/model-config', {
    data: {
      revision: config.revision,
      change: {
        kind: 'slots',
        set: { llm: process.env.SVG_EVAL_API_MODEL || 'openai:gpt-5.6-luna' },
      },
    },
  });
  assert.equal(response.status(), 200, (await response.text()).slice(0, 300));
  const started = Date.now();
  const start = await page.request.post(app + '/api/generation-runs', {
    data: {
      requirement:
        '严格只生成一页中文slide课件，讲细胞膜的主动运输和被动运输。用三个深色带白字的SVG shape流程节点和方向箭头，不要图片、视频、互动网页或测验。',
      interactive: false,
      taskEngine: false,
      outlineReview: 'auto',
      agents: { mode: 'auto' },
    },
  });
  assert.equal(start.status(), 202, (await start.text()).slice(0, 300));
  const created = await start.json();
  let run = created.data?.run || created.run;
  assert.ok(run?.id, 'run id');
  console.log(JSON.stringify({ runId: run.id, state: run.state }));
  while (!['completed', 'ended'].includes(run.state) && Date.now() - started < 600000) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await (await page.request.get(app + '/api/generation-runs/' + run.id)).json();
    run = status.data?.run || status.run;
    console.log(JSON.stringify({ runId: run.id, state: run.state, step: run.step }));
  }
  writeFileSync(
    output + '/run.json',
    JSON.stringify({ run, milliseconds: Date.now() - started }, null, 2),
  );
  assert.equal(run.state, 'completed', 'live server generation must complete');
  const documentResponse = await page.request.get(
    app + '/api/persistence/documents/' + run.stageId,
  );
  assert.equal(documentResponse.status(), 200);
  const document = await documentResponse.json();
  writeFileSync(output + '/document.json', JSON.stringify(document, null, 2));
  await page.goto(app + '/classroom/' + run.stageId);
  await page.getByTestId('scene-title').first().waitFor({ state: 'attached', timeout: 30000 });
  await page.locator('.base-element-text').first().waitFor({ timeout: 30000 });
  await page
    .getByRole('button', { name: /got it|知道了/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.screenshot({ path: output + '/classroom.png' });
  assert.deepEqual(errors, []);
  writeFileSync(
    output + '/summary.json',
    JSON.stringify(
      {
        model: process.env.SVG_EVAL_API_MODEL || 'openai:gpt-5.6-luna',
        state: run.state,
        sceneCount: document.scenes.length,
        url: app + '/classroom/' + run.stageId,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ completed: true, scenes: document.scenes.length, errors }));
} finally {
  await browser.close();
}
