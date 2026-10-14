/** Browser verification of real SDK pages and an isolated classroom. */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { DSL_VERSION } from '@openmaic/dsl';

const root = resolve('eval/svg-validator/results');
const output = join(root, 'browser');
mkdirSync(output, { recursive: true });
const gallery = process.env.SVG_EVAL_GALLERY_URL || 'http://localhost:1852';
const app = process.env.SVG_EVAL_APP_URL || 'http://localhost:3003';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const results = [];
const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : entry.name.endsWith('.html') && entry.name !== 'index.html'
        ? [join(directory, entry.name)]
        : [],
  );
try {
  for (const file of walk(root).filter((file) => !file.includes('/browser/'))) {
    const path = relative(root, file),
      start = errors.length;
    await page.goto(gallery + '/' + path, { timeout: 20000 });
    await page.locator('#generated').waitFor();
    const stats = await page.evaluate(() => {
      const inspect = (selector) => {
        const frame = document.querySelector(selector);
        return {
          texts: frame.querySelectorAll('.base-element-text').length,
          shapes: frame.querySelectorAll('.base-element-shape').length,
          paths: frame.querySelectorAll('svg path').length,
          text: frame.textContent,
          invalidAttributes: [...frame.querySelectorAll('[style],[transform],[d]')].flatMap(
            (element) =>
              [...element.attributes]
                .filter(
                  (attr) =>
                    ['style', 'transform', 'd'].includes(attr.name) &&
                    /NaN|Infinity/.test(attr.value),
                )
                .map((attr) => attr.value),
          ),
        };
      };
      return { generated: inspect('#generated'), historical: inspect('#history') };
    });
    assert.deepEqual(stats.generated.invalidAttributes, [], path);
    assert.deepEqual(stats.historical.invalidAttributes, [], path);
    if (path.startsWith('faults/')) {
      assert.equal(stats.generated.texts, stats.historical.texts, path);
      assert.equal(stats.generated.text, stats.historical.text, path);
      assert.equal(stats.generated.paths + stats.historical.paths, 0, path);
      const generatedPixels = await page.locator('#generated').screenshot();
      // Rasterize at the same viewport origin (rotated glyph antialiasing is position-sensitive).
      await page.evaluate(() => {
        const a = document.querySelector('#generated'),
          b = document.querySelector('#history');
        const rect = a.getBoundingClientRect();
        a.style.visibility = 'hidden';
        b.style.position = 'absolute';
        b.style.left = rect.left + 'px';
        b.style.top = rect.top + scrollY + 'px';
      });
      const historyPixels = await page.locator('#history').screenshot();
      assert.ok(generatedPixels.equals(historyPixels), `fallback pixel mismatch: ${path}`);
      await page.evaluate(() => {
        document.querySelector('#generated').style.visibility = '';
        document.querySelector('#history').removeAttribute('style');
      });
    }
    assert.deepEqual(errors.slice(start), [], path);
    const screenshot = path.replace(/[/]/g, '-').replace(/\.html$/, '.png');
    await page.screenshot({ path: join(output, screenshot), fullPage: true });
    results.push({ path, ...stats, errors: errors.slice(start), screenshot });
  }
  writeFileSync(join(output, 'gallery.json'), JSON.stringify(results, null, 2));

  // Seed the actual generated DSL, then replay both generated and historical faults.
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en-US');
    localStorage.setItem(
      'maic:account:settings-storage',
      JSON.stringify({
        state: {
          agentMode: 'preset',
          selectedAgentIds: [],
          reviewOutlineEnabled: false,
          sidebarCollapsed: false,
        },
        version: 5,
      }),
    );
  });
  await page.goto(app, { timeout: 120000 });
  const files = walk(root).filter(
    (path) => !path.includes('/faults/') && !path.includes('/browser/'),
  );
  const samples = files.map((path) =>
    JSON.parse(readFileSync(path.replace(/\.html$/, '.json'), 'utf8')),
  );
  const faults = JSON.parse(readFileSync(join(root, 'faults/summary.json'), 'utf8'));
  const now = Date.now(),
    stageId = 'svg-regression-' + now;
  const scenes = samples.map((sample, index) => ({
    ...sample.scene,
    stageId,
    id: 'natural-' + index,
    order: index,
  }));
  for (const sample of samples.filter((sample) => sample.record.invalidRawShapes.length))
    scenes.push({
      ...sample.scene,
      id: 'natural-history-' + scenes.length,
      stageId,
      order: scenes.length,
      content: {
        type: 'slide',
        canvas: { ...sample.scene.content.canvas, elements: sample.normalizedHistory },
      },
      title: sample.record.model + ' historical malformed geometry',
    });
  for (const fault of faults.filter((fault) =>
    ['after-close', 'zero-viewbox', 'white-label-dark-fill'].includes(fault.id),
  )) {
    for (const history of [false, true])
      scenes.push({
        id: `${fault.id}-${history ? 'history' : 'generated'}`,
        stageId,
        type: 'slide',
        title: `${fault.id} ${history ? 'historical' : 'generated'}`,
        order: scenes.length,
        content: { type: 'slide', canvas: history ? fault.historyCanvas : fault.canvas },
        actions: [],
        createdAt: now,
        updatedAt: now,
      });
  }
  const response = await page.request.put(app + '/api/persistence/documents/' + stageId, {
    data: {
      dslVersion: DSL_VERSION,
      stage: { id: stageId, name: 'SVG real-model regression', createdAt: now, updatedAt: now },
      scenes,
    },
  });
  assert.equal(
    response.status(),
    204,
    'isolated classroom seeding: ' + (await response.text()).slice(0, 300),
  );
  const appStart = errors.length;
  await page.goto(app + '/classroom/' + stageId, { timeout: 120000 });
  await page.getByTestId('scene-title').first().waitFor({ timeout: 60000 });
  await page
    .getByRole('button', { name: /got it|知道了/i })
    .click({ timeout: 3000 })
    .catch(() => {});
  const classroomResults = [];
  for (let index = 0; index < scenes.length; index++) {
    await page.getByTestId('scene-item').nth(index).click();
    await page.locator('.base-element-text').first().waitFor({ timeout: 15000 });
    const text = await page.locator('body').innerText();
    if (
      scenes[index].id.startsWith('after-close') ||
      scenes[index].id.startsWith('zero-viewbox') ||
      scenes[index].id.startsWith('white-label-dark-fill')
    )
      assert.ok(text.includes('保留的文字'), scenes[index].id);
    await page.screenshot({ path: join(output, `classroom-${scenes[index].id}.png`) });
    classroomResults.push({ scene: scenes[index].id, title: scenes[index].title });
  }
  // Reload proves persistence and the historical guard survive document rehydration.
  await page.reload();
  await page.getByTestId('scene-title').first().waitFor({ timeout: 30000 });
  assert.ok((await page.locator('body').innerText()).includes('保留的文字'));
  await page
    .getByRole('switch', { name: /edit course/i })
    .first()
    .click();
  await page.getByTestId('slide-nav-rail').waitFor({ timeout: 30000 });
  await page.locator('[data-shape-geometry-error] .base-element-text').first().waitFor();
  assert.ok((await page.locator('body').innerText()).includes('保留的文字'));
  await page.screenshot({ path: join(output, 'classroom-historical-pro.png') });
  await page.getByRole('button', { name: /start learning/i }).click();
  await page.getByTestId('scene-title').first().waitFor();
  // Recovery is a render projection: historical data still retains the shape.
  const stored = await page.request.get(app + '/api/persistence/documents/' + stageId);
  assert.equal(stored.status(), 200);
  const document = await stored.json();
  for (const scene of document.scenes.filter((scene) => scene.id.endsWith('-history'))) {
    assert.equal(scene.content.canvas.elements[0].type, 'shape');
  }
  const appErrors = errors.slice(appStart);
  assert.deepEqual(appErrors, [], 'classroom browser errors');
  writeFileSync(
    join(output, 'classroom.json'),
    JSON.stringify(
      {
        url: app + '/classroom/' + stageId,
        scenes: classroomResults,
        errors: appErrors,
        reloadPassed: true,
        proModePassed: true,
        historicalShapePreserved: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      galleryPages: results.length,
      classroomScenes: scenes.length,
      errors: appErrors,
      output,
    }),
  );
} finally {
  await browser.close();
}
