import { expect } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import type { LearningView } from '@/lib/pbl/v3/types';

for (const legacyMove of [false, true]) {
  test(`application input and client state survive native fullscreen (legacy DOM: ${legacyMove})`, async ({
    page,
    learningEvents,
  }) => {
    test.setTimeout(90000);
    await page.addInitScript((legacy) => {
      localStorage.setItem('locale', 'en-US');
      if (legacy) Reflect.deleteProperty(Element.prototype, 'moveBefore');
    }, legacyMove);
    const stageId = uniqueStageId('pbl-preview');
    await seedServerDocument(page, {
      stage: {
        id: stageId,
        name: 'Application preview',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      scenes: [
        {
          id: 'project',
          stageId,
          type: 'pbl',
          title: 'Preview project',
          order: 0,
          content: { type: 'pbl', projectV3: { id: 'greeting-python-lab', version: '1.1.0' } },
          actions: [],
        },
      ],
    });
    const view = {
      id: 'preview-study',
      revision: 0,
      activitySequence: 0,
      title: 'Preview project',
      reportAvailable: false,
      environmentId: 'preview-environment',
      environment: { state: 'running', ready: true },
      recovery: null,
      state: {
        status: 'running',
        position: { milestoneIndex: 0, milestoneId: 'greeting', stageIndex: 0 },
        milestones: [{ milestoneId: 'greeting', status: 'active' }],
        collected: { greeting: { decisions: [] } },
        decisionRevisions: {},
        lastSequence: 0,
      },
      stage: {
        kind: 'mentor_say',
        agent: 'discussion',
        say: 'Try your application.',
        studentActions: ['chat'],
      },
      milestones: [
        {
          id: 'greeting',
          title: 'Greeting',
          stages: ['teaching', 'dialogue', 'plan', 'code', 'tests', 'quiz', 'recap'],
        },
      ],
      role: 'discussion',
      actions: ['chat'],
      needsOpening: false,
      files: ['PLAN.md'],
      busy: false,
      messages: [],
      roleRun: null,
      decisions: [],
      questions: [],
      evaluation: null,
      application: { title: 'Preview form', description: 'Try this interface.' },
    } as unknown as LearningView;
    const workbench = {
      environmentId: view.environmentId!,
      revision: 0,
      epoch: 0,
      canEdit: false,
      canManageFiles: false,
      canRun: false,
      planning: false,
      commands: [],
      terminals: [],
    };
    let launches = 0,
      documents = 0;
    const commands: string[] = [];
    await page.route('**/pbl-preview-fixture', async (route) => {
      documents++;
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
        <label>Draft <input aria-label="Draft"></label><button onclick="document.querySelector('output').textContent=++window.count">Increment</button><output>0</output>
        <script>window.count=0;window.boot=crypto.randomUUID()</script>`,
      });
    });
    await page.route('**/api/pbl/v3**', async (route) => {
      const url = new URL(route.request().url());
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (url.searchParams.get('project') === '1')
        return route.fulfill({
          json: {
            started: true,
            hero: {
              title: view.title,
              description: 'Try a declared application.',
              gains: ['Inspect your work'],
              instructorName: 'Project tutor',
              milestoneCount: 1,
              taskCount: 7,
            },
          },
        });
      if (url.pathname.endsWith('/application')) {
        launches++;
        return route.fulfill({
          json: {
            state: 'running',
            observedAt: new Date().toISOString(),
            preview: {
              url: new URL('/pbl-preview-fixture', page.url()).href,
              expiresAt: Date.now() + 300000,
            },
          },
        });
      }
      if (url.pathname.endsWith('/activity')) return route.fulfill({ json: { recorded: true } });
      if (url.pathname.endsWith('/workspace')) return route.fulfill({ json: workbench });
      if (url.searchParams.has('file'))
        return route.fulfill({ json: { text: 'Saved plan', hash: 'a'.repeat(64) } });
      if (body?.command) commands.push(body.command.type);
      return route.fulfill({ json: body?.command ? { view } : view });
    });
    await learningEvents(() => ({ view, workbench }));
    await page.goto(`/classroom/${stageId}`);
    await page.getByRole('button', { name: 'Continue Project', exact: true }).click();
    await page.getByTestId('pbl-application-open').click();
    const dialog = page.getByRole('dialog');
    const app = page.frameLocator('iframe[title="Preview form"]');
    await app.getByRole('textbox', { name: 'Draft', exact: true }).fill('Unsaved form input');
    await app.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(app.locator('output')).toHaveText('1');
    const boot = await app
      .locator('body')
      .evaluate(() => (window as unknown as { boot: string }).boot);
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-playback-stage]')!.requestFullscreen(),
      );
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate((el) => document.fullscreenElement!.contains(el))).toBe(true);
      await page.evaluate(() => document.exitFullscreen());
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Unsaved form input',
      );
      await expect(app.locator('output')).toHaveText('1');
      expect(
        await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
      ).toBe(boot);
      expect(
        await dialog.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.right - 20, rect.top + 20));
        }),
      ).toBe(true);
    }
    expect(launches).toBe(1);
    expect(documents).toBe(1);
    expect(commands).toEqual([]);
  });
}
