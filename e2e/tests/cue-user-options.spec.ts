import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { DEFAULT_MODEL_SETTINGS } from '../fixtures/test-data/model-settings';

const OPTIONS = [
  'Show a worked example with each step explained as we go',
  'Let me practice independently before we compare answers',
  'Explain the underlying concept with another everyday case',
  'Back to the lesson',
];
type ChatRequest = { messages: Array<{ role: string; parts: Array<{ text?: string }> }> };

async function seedLesson(page: Page) {
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ autoPlayLecture: false, ttsMuted: true }),
  );
  await page.goto('/classroom/warmup-nonexistent');
  const stageId = uniqueStageId('cue-options');
  const sceneId = 'cue-scene';
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Suggested replies', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: sceneId,
        stageId,
        type: 'slide',
        title: 'Suggested replies',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [
          {
            id: 'first',
            type: 'speech',
            text: 'This is the interrupted lecture sentence. '.repeat(12).trim(),
          },
          { id: 'second', type: 'speech', text: 'The next sentence must wait for play.' },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  await setCurrentScene(page, stageId, sceneId);
  await page.goto(`/classroom/${stageId}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
  return stageId;
}

async function mockChat(page: Page, withOptions: boolean) {
  const requests: ChatRequest[] = [];
  await page.route('**/api/chat/pi', async (route) => {
    requests.push(route.request().postDataJSON());
    const id = `answer-${requests.length}`;
    const prompt = 'Which example should we try?';
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        {
          type: 'agent_start',
          data: { messageId: id, agentId: 'default-1', agentName: 'Teacher' },
        },
        { type: 'text_delta', data: { messageId: id, content: prompt } },
        { type: 'agent_end', data: { messageId: id, agentId: 'default-1' } },
        {
          type: 'cue_user',
          data: { fromAgentId: 'default-1', prompt, ...(withOptions ? { options: OPTIONS } : {}) },
        },
        {
          type: 'done',
          data: {
            totalActions: 0,
            totalAgents: 1,
            agentHadContent: true,
            cueUserReceived: true,
            directorState: { turnCount: requests.length, agentResponses: [], whiteboardLedger: [] },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });
  return requests;
}

async function sendText(page: Page, text: string) {
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})));
  });
}

async function geometry(page: Page) {
  await settle(page);
  return page.getByTestId('roundtable-region').evaluate((region) => {
    const roundtable = region.getBoundingClientRect();
    const canvas = region
      .parentElement!.parentElement!.querySelector(':scope > .isolate')!
      .getBoundingClientRect();
    return {
      height: roundtable.height,
      canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
    };
  });
}

async function canvasGeometry(page: Page) {
  await settle(page);
  return page.locator('div.isolate').first().boundingBox();
}

async function assertOptionsLayout(page: Page) {
  const group = page.getByTestId('cue-user-options');
  await expect(group).toBeVisible({ timeout: 25_000 });
  await expect(group.locator('button')).toHaveCount(4);
  await expect(page.locator('[class~="group/bubble"]')).toHaveCount(0);
  await expect(page.getByTestId('cue-user-panel')).toBeVisible();
  await settle(page);
  const metrics = await group.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const slot = element.closest('[data-testid="cue-user-suggested-bubble"]')!;
    const surface = slot.firstElementChild!.getBoundingClientRect();
    const cue = document.querySelector('[data-testid="cue-user-panel"]')!.getBoundingClientRect();
    const cueContainsOptions = !!element.closest('[data-testid="cue-user-panel"]');
    const buttons = [...element.querySelectorAll('button')].map((button) => {
      const bounds = button.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        title: button.title,
        label: button.textContent,
      };
    });
    return {
      cueContainsOptions,
      bubble: {
        left: surface.left,
        right: surface.right,
        top: surface.top,
        bottom: surface.bottom,
        height: surface.height,
      },
      cue: { left: cue.left, right: cue.right },
      top: rect.top,
      bottom: rect.bottom,
      right: rect.right,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      buttons,
    };
  });
  // Suggested replies sit in the user's bubble slot, not under the centered cue.
  expect(metrics.cueContainsOptions).toBe(false);
  expect(metrics.bubble.height).toBeLessThanOrEqual(110);
  expect(metrics.bubble.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bubble.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bubble.left).toBeGreaterThan(metrics.viewportWidth / 2);
  expect(metrics.bubble.left).toBeGreaterThanOrEqual(metrics.cue.right);
  // Long labels wrap into rows and scroll vertically inside the bubble.
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(new Set(metrics.buttons.map((button) => Math.round(button.top))).size).toBeGreaterThan(1);
  for (const [index, button] of metrics.buttons.entries()) {
    expect(button.title).toBe(OPTIONS[index]);
    expect(button.label).toBe(OPTIONS[index]);
    expect(button.right).toBeLessThanOrEqual(metrics.right + 1);
  }
  return metrics;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await settle(page);
  await page.screenshot({ path: info.outputPath(name), fullPage: true });
}

test('suggested strings stay in 192px, send once as ordinary messages, and disappear on reload', async ({
  page,
  mockApi,
}, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockApi.mockModelSettings({ ...DEFAULT_MODEL_SETTINGS, media: { asr: 'browser-native' } });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', {
      value: class {
        onstart = () => {};
        onend = () => {};
        start() {
          this.onstart();
        }
        stop() {
          this.onend();
        }
        abort() {
          this.onend();
        }
      },
    });
  });
  const requests = await mockChat(page, true);
  const stageId = await seedLesson(page);
  const idle = await geometry(page);
  expect(idle.height).toBe(192);
  await page.keyboard.press('V');
  await expect(page.getByText('Listening...', { exact: true })).toBeVisible();
  expect(await geometry(page)).toEqual(idle);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Listening...', { exact: true })).toHaveCount(0);
  const play = page.locator('div[class*="z-[102]"] div.pointer-events-auto').first();
  await play.click();
  await expect(page.getByTestId('roundtable-region')).toContainText('interrupted lecture sentence');
  expect(await geometry(page)).toEqual(idle);
  await page.keyboard.press('T');
  await expect(page.getByPlaceholder('Type your message...', { exact: true })).toBeVisible();
  expect(await geometry(page)).toEqual(idle);
  await page
    .getByPlaceholder('Type your message...', { exact: true })
    .fill('Could you explain this?');
  await page.getByPlaceholder('Type your message...', { exact: true }).press('Enter');
  expect((await geometry(page)).height).toBe(192);
  const normalMetrics = await assertOptionsLayout(page);
  expect(await geometry(page)).toEqual(idle);
  expect(requests).toHaveLength(1);
  await expect(page.getByTitle('Stop Discussion', { exact: true })).toBeVisible();
  await screenshot(page, info, 'cue-options-normal-light.png');
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  const fullscreenMetrics = await assertOptionsLayout(page);
  await screenshot(page, info, 'cue-options-fullscreen-light.png');
  const fullscreenCanvas = await canvasGeometry(page);
  await page.keyboard.press('T');
  await expect(page.getByPlaceholder('Type your message...', { exact: true })).toBeVisible();
  expect(await canvasGeometry(page)).toEqual(fullscreenCanvas);
  await page.keyboard.press('Escape');
  await assertOptionsLayout(page);
  expect(await canvasGeometry(page)).toEqual(fullscreenCanvas);
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await screenshot(page, info, 'cue-options-fullscreen-dark.png');
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await assertOptionsLayout(page);
  expect(await geometry(page)).toEqual(idle);
  await screenshot(page, info, 'cue-options-normal-dark.png');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  const back = page
    .getByTestId('cue-user-options')
    .getByRole('button', { name: OPTIONS[3], exact: true });
  await back.scrollIntoViewIfNeeded();
  await back.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => requests.length).toBe(2);
  expect(
    requests[1].messages.filter(
      (message) =>
        message.role === 'user' && message.parts.some((part) => part.text === OPTIONS[3]),
    ),
  ).toHaveLength(1);
  await assertOptionsLayout(page);
  await expect(page.getByTitle('Stop Discussion', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  await sendText(page, 'Typed follow-up after refresh');
  await assertOptionsLayout(page);
  expect(requests).toHaveLength(3);
  await page.getByTitle('Stop Discussion', { exact: true }).click();
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
  expect(requests).toHaveLength(3);
  expect((await geometry(page)).height).toBe(192);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await info.attach('suggested-reply-layout', {
    body: JSON.stringify({ stageId, idle, normalMetrics, fullscreenMetrics }, null, 2),
    contentType: 'application/json',
  });
});

test('no-options cue keeps the main idle animation in normal and fullscreen views', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const requests = await mockChat(page, false);
  await seedLesson(page);
  const idle = await geometry(page);
  await sendText(page, 'Ask an open-ended question');
  await expect(page.getByTestId('cue-user-panel')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
  await expect(page.getByTestId('cue-user-suggested-bubble')).toHaveCount(0);
  await expect(page.locator('[class~="group/bubble"]')).toHaveCount(0);
  expect(await geometry(page)).toEqual(idle);
  await expect(page.getByTestId('cue-user-panel')).toContainText('Your turn');
  await page.keyboard.press('F11');
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect(page.getByTestId('cue-user-panel')).toBeVisible();
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
  await expect(page.getByTestId('cue-user-suggested-bubble')).toHaveCount(0);
  await expect(page.locator('[class~="group/bubble"]')).toHaveCount(0);
  expect(requests).toHaveLength(1);
});
