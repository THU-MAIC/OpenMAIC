import { previewShell } from '../../scripts/sandbox-preview-activity.mjs';
import { expect } from '@playwright/test';
import { test } from '../fixtures/pbl-learning-events';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import type { LearningView } from '@/lib/pbl/v3/types';

for (const { legacyMove, nested } of [false, true].flatMap((nested) =>
  [false, true].map((legacyMove) => ({ legacyMove, nested })),
)) {
  test(`application input and client state survive native fullscreen (legacy DOM: ${legacyMove}, gateway: ${nested})`, async ({
    page,
    learningEvents,
  }, testInfo) => {
    test.setTimeout(180000);
    if (!legacyMove) await page.clock.install();
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
      onboardingCompleted: true,
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
    let stopped = false;
    let delayedDocument: Promise<void> | undefined;
    let delayedAuthorization: Promise<void> | undefined;
    let delayedImage: Promise<void> | undefined;
    let imageWaiting = false;
    let delayedParsing: Promise<void> | undefined;
    let parsingWaiting = false;
    let authorizationWaiting = false;
    let authorizationFailure = false;
    const gatewayOrigin = 'http://preview-fixture.localhost';
    const commands: string[] = [];
    const readinessDuringPause = nested && !legacyMove;
    const openingStage = view.stage;
    let releaseFirstDocument: (() => void) | undefined;
    if (readinessDuringPause) {
      view.role = 'planner';
      view.actions = ['chat', 'edit'];
      view.stage = {
        kind: 'produce',
        agent: 'planner',
        writes: 'plan',
        reviewRequired: true,
        reads: [],
        studentActions: ['chat', 'edit'],
      } as LearningView['stage'];
      workbench.canEdit = true;
      workbench.planning = true;
      delayedImage = new Promise<void>((resolve) => {
        releaseFirstDocument = resolve;
      });
    }
    const serveApplication = async (route: import('@playwright/test').Route) => {
      documents++;
      if (delayedDocument) {
        const wait = delayedDocument;
        delayedDocument = undefined;
        await wait;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
        <form onsubmit="event.preventDefault();document.querySelector('output').textContent=++window.count"><label>Draft <input aria-label="Draft"></label><button type="button" onclick="document.querySelector('output').textContent=++window.count">Increment</button><button type="submit">Submit</button></form><output>0</output>
        <script>window.count=0;window.boot="${documents}";${nested ? 'document.querySelector("input").focus();window.initialFocusAttempt=true;' : ''}</script>
        ${nested && delayedImage ? '<img src="/pending-image">' : ''}
        ${nested && delayedParsing ? '<script src="/pending-parser-script.js"></script>' : ''}`,
      });
    };
    await page.route('**/pbl-preview-fixture', serveApplication);
    if (nested)
      await page.route(`${gatewayOrigin}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/__openmaic_preview')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: previewShell('fixture-nonce'),
          });
        if (path === '/__openmaic_authorize') {
          if (delayedAuthorization) {
            const wait = delayedAuthorization;
            delayedAuthorization = undefined;
            authorizationWaiting = true;
            await wait;
          }
          if (authorizationFailure) return route.fulfill({ status: 403, body: 'Access expired' });
          return route.fulfill({
            json: {
              activityKey: 'fixture-private-capability',
              appOrigin: new URL(page.url()).origin,
            },
          });
        }
        if (path === '/__openmaic_activity') return route.fulfill({ status: 204 });
        if (path === '/pending-parser-script.js') {
          parsingWaiting = true;
          await delayedParsing;
          return route.fulfill({ contentType: 'text/javascript', body: '' });
        }
        if (path === '/pending-image') {
          const wait = delayedImage;
          delayedImage = undefined;
          imageWaiting = true;
          await wait;
          return route.fulfill({ status: 204 });
        }
        // Re-enter the shared app route; the browser document stays on the isolated origin.
        await serveApplication(route);
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
        if (body?.action === 'status')
          return route.fulfill({
            json: {
              state: stopped ? 'stopped' : 'running',
              observedAt: new Date().toISOString(),
              sourceChanged: false,
            },
          });
        launches++;
        stopped = false;
        return route.fulfill({
          json: {
            state: 'running',
            observedAt: new Date().toISOString(),
            preview: {
              url: nested
                ? `${gatewayOrigin}/__openmaic_preview#fixture-${launches}`
                : new URL('/pbl-preview-fixture', page.url()).href,
              expiresAt: Date.now() + 300000,
            },
          },
        });
      }
      if (url.pathname.endsWith('/activity')) return route.fulfill({ json: { recorded: true } });
      if (url.pathname.endsWith('/workspace')) return route.fulfill({ json: workbench });
      if (url.searchParams.has('file'))
        return route.fulfill({ json: { text: 'Saved plan', hash: 'a'.repeat(64) } });
      if (body?.command) {
        commands.push(body.command.type);
        if (body.command.type === 'prepare') {
          view.environmentId = 'restored-preview-environment';
          view.environment = { state: 'running', ready: true };
          view.revision++;
          workbench.environmentId = view.environmentId;
          workbench.revision = view.revision;
          workbench.epoch++;
        }
      }
      return route.fulfill({ json: body?.command ? { view } : view });
    });
    const publishLearning = await learningEvents(() => ({ view, workbench }));
    await page.goto(`/classroom/${stageId}`);
    await page.getByRole('button', { name: 'Continue Project', exact: true }).click();
    await expect(page.getByTestId('pbl-application-open')).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByTestId('pbl-application-panel');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Try this interface.', { exact: true })).toBeHidden();
    const outerApp = page.frameLocator('iframe[title="Preview form"]');
    const app = nested ? outerApp.frameLocator('iframe[title="Application"]') : outerApp;
    if (readinessDuringPause) {
      // Hold the first real application document open, edit then undo before
      // autosave. Readiness while dirty must still establish this candidate.
      await expect.poll(() => imageWaiting).toBe(true);
      const firstBoot = await app
        .locator('body')
        .evaluate(() => (window as unknown as { boot: string }).boot);
      await app.getByRole('textbox', { name: 'Draft', exact: true }).evaluate((input) => {
        (input as HTMLInputElement).value = 'Candidate client state';
      });
      await expect(page.locator('.monaco-editor textarea').first()).toBeEditable();
      await page.locator('.monaco-editor .view-lines .view-line').first().click();
      await page.keyboard.press('End');
      await page.keyboard.insertText('draft');
      await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Saved plandraft');
      await expect(
        panel.getByText('Wait for your edits to save before opening the application.', {
          exact: true,
        }),
      ).toBeVisible();
      releaseFirstDocument!();
      await expect(panel.locator('iframe')).not.toHaveClass(/invisible/);
      await expect(app.locator('html')).toHaveJSProperty('inert', true);
      await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
      await page.keyboard.press('ControlOrMeta+Z');
      await expect(page.locator('.monaco-editor .view-lines')).toHaveText('Saved plan');
      await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Candidate client state',
      );
      expect(
        await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
      ).toBe(firstBoot);
      expect(launches).toBe(1);
      expect(documents).toBe(1);
      expect(commands).toEqual([]);
      view.role = 'discussion';
      view.actions = ['chat'];
      view.stage = openingStage;
      workbench.canEdit = false;
      workbench.planning = false;
      view.activitySequence!++;
      await publishLearning();
    }
    await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    await app.getByRole('textbox', { name: 'Draft', exact: true }).fill('Unsaved form input');
    await app.getByRole('button', { name: 'Increment', exact: true }).click();
    await expect(app.locator('output')).toHaveText('1');
    const boot = await app
      .locator('body')
      .evaluate(() => (window as unknown as { boot: string }).boot);
    if (nested && !legacyMove) {
      const launchCount = launches;
      await page.getByRole('button', { name: 'Workspace guide', exact: true }).click();
      const guide = page.locator('[data-pbl-onboarding="card"]');
      await expect(guide).toBeVisible();
      await expect(app.locator('html')).toHaveJSProperty('inert', true);
      await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
      // Simulate an application autofocus attempt while the guide owns input.
      await app
        .getByRole('textbox', { name: 'Draft', exact: true })
        .evaluate((element) => element.focus());
      // Spaces activate the focused Next button; use ordinary text to probe iframe isolation.
      await page.keyboard.type('BlockedInput');
      await expect(guide).toHaveAttribute('data-step', 'progress');
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Unsaved form input',
      );
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-playback-stage]')!.requestFullscreen(),
      );
      // The fullscreen promise can resolve before React reparents the portal.
      await expect
        .poll(() => guide.evaluate((element) => !!document.fullscreenElement?.contains(element)))
        .toBe(true);
      await page.evaluate(() => document.exitFullscreen());
      for (let step = 0; step < 5; step++) await guide.locator('footer button').last().click();
      await expect(guide).toHaveCount(0);
      await expect(app.locator('html')).toHaveJSProperty('inert', false);
      await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
      expect(
        await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
      ).toBe(boot);
      expect(launches).toBe(launchCount);
      expect(commands).toEqual([]);
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-playback-stage]')!.requestFullscreen(),
      );
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
      await expect(panel).toBeVisible();
      expect(await panel.evaluate((el) => document.fullscreenElement!.contains(el))).toBe(true);
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
        await panel.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(rect.right - 20, rect.top + 20));
        }),
      ).toBe(true);
    }
    if (legacyMove && nested) {
      const outer = page.getByRole('separator', { name: 'Resize workspace and assistant' }).last();
      const box = (await outer.boundingBox())!;
      const workbench = (await page.getByTestId('pbl-workbench-split').boundingBox())!;
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(workbench.x + workbench.width * 0.4, y, { steps: 10 });
      await page.mouse.up();
      await expect
        .poll(async () => (await page.getByTestId('assistant').boundingBox())!.width)
        .toBeGreaterThan(workbench.width * 0.55);
      await expect(page.getByTestId('pbl-ide')).toBeVisible();
      await expect(panel).toBeVisible();
    }
    // Folding is layout-only: preserve the document and never start another app.
    await panel.getByRole('button', { name: 'Collapse application', exact: true }).click();
    await expect(page.getByTestId('pbl-application-open')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const workspacePanel = page.getByTestId('workspace');
    const assistantPanel = page.getByTestId('assistant');
    const beforeDrag = (await workspacePanel.boundingBox())!;
    const assistantBefore = (await assistantPanel.boundingBox())!;
    const dividerX = (beforeDrag.x + beforeDrag.width + assistantBefore.x) / 2;
    await page.mouse.move(dividerX, beforeDrag.y + beforeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(dividerX + 70, beforeDrag.y + beforeDrag.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => (await workspacePanel.boundingBox())!.width)
      .toBeGreaterThan(beforeDrag.width + 30);
    await expect
      .poll(async () => (await page.getByTestId('application').boundingBox())?.width ?? 0)
      .toBeLessThan(1);
    await page.getByTestId('pbl-application-open').click();
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
      'Unsaved form input',
    );
    expect(
      await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
    ).toBe(boot);
    // Closing the entire work area must not restore a hidden inner panel when
    // only one pane is reopened. Keep the original preview document and input.
    const codeToggle = page.getByRole('button', { name: 'Toggle code workspace', exact: true });
    const appToggle = page.getByTestId('pbl-application-open');
    const collapseWorkArea = async () => {
      const outer = page.getByRole('separator', { name: 'Resize workspace and assistant' }).last();
      const box = (await outer.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(0, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      await expect(codeToggle).toHaveAttribute('aria-pressed', 'false');
      await expect(appToggle).toHaveAttribute('aria-expanded', 'false');
    };
    await collapseWorkArea();
    await codeToggle.click();
    await expect.poll(async () => (await workspacePanel.boundingBox())!.width).toBeGreaterThan(100);
    await expect
      .poll(async () => (await page.getByTestId('application').boundingBox())!.width)
      .toBeLessThan(1);
    await appToggle.click();
    await expect(panel).toBeVisible();
    await collapseWorkArea();
    await appToggle.click();
    await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(100);
    await expect.poll(async () => (await workspacePanel.boundingBox())!.width).toBeLessThan(1);
    await codeToggle.click();
    await expect.poll(async () => (await workspacePanel.boundingBox())!.width).toBeGreaterThan(100);
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
      'Unsaved form input',
    );
    expect(
      await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
    ).toBe(boot);
    // On a phone each panel remains reachable without covering the conversation.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => panel.evaluate((el) => el.clientHeight)).toBeGreaterThan(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(async () => {
        const editorBox = await page.getByTestId('workspace').boundingBox();
        const applicationBox = await panel.boundingBox();
        const assistantBox = await page.getByTestId('assistant').boundingBox();
        return (
          !!editorBox &&
          !!applicationBox &&
          !!assistantBox &&
          editorBox.width > 0 &&
          applicationBox.width > 0 &&
          assistantBox.width > 0 &&
          editorBox.x + editorBox.width <= applicationBox.x + 1 &&
          applicationBox.x + applicationBox.width <= assistantBox.x + 1
        );
      })
      .toBe(true);
    if (!legacyMove) await page.screenshot({ path: testInfo.outputPath('application-dock.png') });
    expect(launches).toBe(1);
    expect(documents).toBe(1);
    expect(commands).toEqual([]);
    if (!legacyMove) {
      // A renewal response can arrive just after the old local deadline. Keep
      // the hidden document alive so its confirmed response can restore it.
      await page.clock.fastForward(300_001);
      await expect(panel.locator('iframe')).toBeHidden();
      await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
      const renewedDeadline = await page.evaluate(() => Date.now() + 300_000);
      await outerApp.locator('body').evaluate(
        (_body, { expiresAt, origin }) => {
          parent.postMessage({ type: 'openmaic-preview-activity', expiresAt }, origin);
        },
        { expiresAt: renewedDeadline, origin: new URL(page.url()).origin },
      );
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toBeVisible();
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Unsaved form input',
      );
      expect(
        await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
      ).toBe(boot);
      expect(documents).toBe(1);
      expect(launches).toBe(1);
      await page.clock.setSystemTime(new Date());
    }
    // The dock does not trap focus or block learner input. A busy server state does
    // suspend input while keeping the application document, then resumes automatically.
    const composer = page.locator('textarea[placeholder]').last();
    await composer.fill('Keep this draft while looking at the application');
    await expect(composer).toHaveValue('Keep this draft while looking at the application');
    await app.getByRole('textbox', { name: 'Draft', exact: true }).focus();
    view.busy = true;
    view.conversation = [
      {
        id: 'source-change',
        speaker: 'coder',
        status: 'running',
        parts: [
          {
            id: 'write',
            kind: 'tool',
            action: 'write',
            status: 'running',
            args: { path: 'app.py' },
          },
        ],
      },
    ];
    view.activitySequence!++;
    await publishLearning();
    await expect(panel.locator('iframe')).toHaveCount(1);
    await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
    await page.keyboard.type('BLOCKED');
    await page.keyboard.press('Enter');
    await expect(app.locator('output')).toHaveText('1');
    await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toBeVisible();
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
      'Unsaved form input',
    );
    if (nested) {
      await expect(app.locator('html')).toHaveJSProperty('inert', true);
      const attemptFocus = async () => {
        await app.getByRole('textbox', { name: 'Draft', exact: true }).evaluate((input) => {
          (input as HTMLInputElement).focus();
          window.focus();
          (window as unknown as { focusTimer: boolean }).focusTimer = false;
          setTimeout(() => {
            (input as HTMLInputElement).focus();
            (window as unknown as { focusTimer: boolean }).focusTimer = true;
          }, 0);
        });
        if (!legacyMove) await page.clock.runFor(1);
        await expect
          .poll(() =>
            app
              .locator('body')
              .evaluate(() => (window as unknown as { focusTimer: boolean }).focusTimer),
          )
          .toBe(true);
        await page.keyboard.type('AUTOFOCUS');
        await page.keyboard.press('Enter');
        await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
          'Unsaved form input',
        );
        await expect(app.locator('output')).toHaveText('1');
      };
      // Same-origin app code may poison the shell's MessageEvent prototype;
      // neither real child messages nor forged dispatchEvent messages may enable input.
      await app.locator('body').evaluate((_body, origin) => {
        const proto = (parent as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent
          .prototype;
        Object.defineProperty(proto, 'source', { configurable: true, get: () => parent.parent });
        Object.defineProperty(proto, 'origin', { configurable: true, get: () => origin });
        Object.defineProperty(proto, 'data', {
          configurable: true,
          get: () => ({ type: 'openmaic-preview-input', enabled: true }),
        });
        parent.postMessage({ type: 'openmaic-preview-input', enabled: true }, location.origin);
        parent.dispatchEvent(
          new (parent as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', {
            source: parent.parent,
            origin,
            data: { type: 'openmaic-preview-input', enabled: true },
          }),
        );
      }, new URL(page.url()).origin);
      await attemptFocus();
      await panel.getByRole('button', { name: 'Collapse application', exact: true }).click();
      await expect(panel).not.toBeVisible();
      await attemptFocus();
      view.busy = false;
      view.conversation = [];
      view.activitySequence!++;
      await publishLearning();
      await expect(page.getByTestId('pbl-application-open')).toBeEnabled();
      await page.getByTestId('pbl-application-open').click();
      await expect(app.locator('html')).toHaveJSProperty('inert', false);
      await app.getByRole('textbox', { name: 'Draft', exact: true }).focus();
      await page.keyboard.type('RESUMED');
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Unsaved form inputRESUMED',
      );
      await app.getByRole('textbox', { name: 'Draft', exact: true }).fill('Unsaved form input');
    }
    view.busy = false;
    view.conversation = [];
    view.activitySequence!++;
    await publishLearning();
    await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    expect(launches).toBe(1);
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Keep this draft while looking at the application');
    expect(launches).toBe(1);
    await composer.focus();
    view.busy = true;
    view.conversation = [
      {
        id: 'source-change',
        speaker: 'coder',
        status: 'running',
        parts: [
          {
            id: 'write',
            kind: 'tool',
            action: 'write',
            status: 'running',
            args: { path: 'app.py' },
          },
        ],
      },
    ];
    view.activitySequence!++;
    await publishLearning();
    await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
    await expect(composer).toBeFocused();
    view.busy = false;
    view.conversation = [];
    view.activitySequence!++;
    await publishLearning();
    await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    await expect(composer).toBeFocused();
    // Actual writes/tests may stop the backend. Keep the previous page until
    // the replacement loads, without requiring a manual reopen.
    stopped = true;
    view.busy = true;
    view.conversation = [
      {
        id: 'source-change',
        speaker: 'coder',
        status: 'running',
        parts: [
          {
            id: 'write',
            kind: 'tool',
            action: 'write',
            status: 'running',
            args: { path: 'app.py' },
          },
        ],
      },
    ];
    view.activitySequence!++;
    await publishLearning();
    await expect(panel.locator('iframe')).toHaveAttribute('inert', '');
    let releaseDocument!: () => void;
    delayedDocument = new Promise<void>((resolve) => {
      releaseDocument = resolve;
    });
    let releaseAuthorization: (() => void) | undefined;
    let releaseParsing: (() => void) | undefined;
    if (nested) {
      delayedAuthorization = new Promise((resolve) => {
        releaseAuthorization = resolve;
      });
      // A pending image does not prevent interactive readiness. Hold parsing
      // after the child's focus attempt until the old-frame assertions finish.
      delayedParsing = new Promise((resolve) => {
        releaseParsing = resolve;
      });
    }
    view.busy = false;
    view.conversation = [];
    view.revision++;
    view.activitySequence!++;
    await publishLearning();
    try {
      await expect(panel.locator('iframe')).toHaveCount(2);
      if (nested) {
        const candidate = panel.locator('iframe').nth(1).contentFrame();
        await expect.poll(() => authorizationWaiting).toBe(true);
        await expect(candidate.locator('#status')).toHaveText('Opening preview…');
        releaseAuthorization!();
        await expect(candidate.locator('iframe')).toHaveCount(1);
        releaseDocument();
        await expect.poll(() => parsingWaiting).toBe(true);
        const parsingApp = candidate.frameLocator('iframe');
        await expect
          .poll(() =>
            parsingApp
              .locator('body')
              .evaluate(
                () => (window as unknown as { initialFocusAttempt: boolean }).initialFocusAttempt,
              ),
          )
          .toBe(true);
        await expect(composer).toBeFocused();
        await parsingApp
          .locator('body')
          .evaluate(
            (_body, origin) =>
              parent.parent.postMessage({ type: 'openmaic-preview-ready' }, origin),
            new URL(page.url()).origin,
          );
        await expect(panel.locator('iframe')).toHaveCount(2);
      }
      await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(
        'Unsaved form input',
      );
      await expect(panel.getByText('Updating preview…', { exact: true })).toBeVisible();
      if (!legacyMove)
        await page.screenshot({ path: testInfo.outputPath('preview-updating-keeps-page.png') });
    } finally {
      releaseAuthorization?.();
      releaseDocument();
      releaseParsing?.();
      delayedParsing = undefined;
    }
    await expect(panel.locator('iframe')).toHaveCount(1);
    await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    expect(launches).toBe(2);
    expect(documents).toBe(2);
    if (nested) {
      const stableBoot = await app
        .locator('body')
        .evaluate(() => (window as unknown as { boot: string }).boot);
      authorizationFailure = true;
      await panel.getByRole('button', { name: 'Restart application', exact: true }).click();
      await expect(panel.locator('[role="alert"]')).toBeVisible();
      await expect(panel.locator('iframe')).toHaveCount(2);
      expect(
        await app.locator('body').evaluate(() => (window as unknown as { boot: string }).boot),
      ).toBe(stableBoot);
      authorizationFailure = false;
      await panel.getByRole('button', { name: 'Reopen application', exact: true }).click();
      await expect(panel.locator('iframe')).toHaveCount(1);
      await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    }
    await panel.getByRole('button', { name: 'Collapse application', exact: true }).click();
    await expect(panel).not.toBeVisible();
    // A final source snapshot needs no compute to read, but the application does.
    view.state.status = 'completed';
    view.completedFilesAvailable = true;
    view.environment = { state: 'destroyed', ready: false };
    view.stage = {
      kind: 'mentor_say',
      agent: 'mentor',
      skill: 'recap',
      say: 'Done',
      studentActions: [],
    };
    view.actions = [];
    view.state.position.stageIndex = 6;
    view.revision++;
    view.activitySequence!++;
    await publishLearning();
    const restore = page.getByRole('button', {
      name: 'Restore application environment',
      exact: true,
    });
    await expect(restore).toBeVisible();
    await expect(page.getByTestId('pbl-application-open')).toBeDisabled();
    expect(commands).toEqual([]);
    const completedEditor = page.locator('.monaco-editor textarea').first();
    // The snapshot editor mounts independently from the application restore control.
    await expect(completedEditor).toBeAttached();
    await expect(completedEditor).not.toBeEditable();
    await restore.click();
    await expect(page.getByTestId('pbl-application-open')).toBeEnabled();
    await expect(completedEditor).not.toBeEditable();
    // A restored binding starts without a usable document. Both initial auth
    // failure and readiness timeout must obtain another ticket on explicit Reopen.
    let releaseInitial: (() => void) | undefined;
    if (nested) {
      if (legacyMove) authorizationFailure = true;
      else {
        authorizationWaiting = false;
        delayedAuthorization = new Promise<void>((resolve) => {
          releaseInitial = resolve;
        });
      }
    }
    await page.getByTestId('pbl-application-open').click();
    if (nested) {
      if (!legacyMove) {
        await expect.poll(() => authorizationWaiting).toBe(true);
        await page.clock.fastForward(60_001);
      }
      await expect(panel.locator('[role="alert"]')).toBeVisible();
      const beforeReopen = launches;
      authorizationFailure = false;
      await panel.getByRole('button', { name: 'Reopen application', exact: true }).click();
      releaseInitial?.();
      await expect.poll(() => launches).toBe(beforeReopen + 1);
      await expect(panel.locator('iframe')).toHaveCount(1);
      await expect(panel.locator('iframe')).not.toHaveAttribute('inert', '');
    }
    await expect(app.getByRole('textbox', { name: 'Draft', exact: true })).toBeVisible();
    expect(launches).toBe(nested ? 6 : 3);
    expect(commands).toEqual(['prepare']);
    await panel.getByRole('button', { name: 'Collapse application', exact: true }).click();
    await expect(panel).not.toBeVisible();
    // Completed projects without execution features still need no restore control.
    view.application = undefined;
    view.environment = { state: 'destroyed', ready: false };
    view.activitySequence!++;
    await publishLearning();
    await expect(page.getByTestId('pbl-environment-setup')).toHaveCount(0);
    expect(commands).toEqual(['prepare']);
  });
}
