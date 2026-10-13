import { test, expect } from '../fixtures/base';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page, TestInfo } from '@playwright/test';

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    const transitions = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(transitions.map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

async function assertParkedTeacherLayout(page: Page) {
  const layout = await page.locator('[data-bubble-role="teacher"]').evaluate((teacher) => {
    const header = teacher.querySelector<HTMLElement>('[data-bubble-header]')!;
    const speech = teacher.querySelector<HTMLElement>('[data-bubble-speech]')!;
    const paragraph = speech.querySelector('p')!;
    const avatar =
      teacher.querySelector<HTMLElement>('.absolute.-top-2\\.5') ?? header.querySelector('img');
    const visibleThroughAncestors = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth)
        return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const bounds = parent.getBoundingClientRect();
        if (
          style.overflowY !== 'visible' &&
          (rect.top < bounds.top - 0.5 || rect.bottom > bounds.bottom + 0.5)
        )
          return false;
        if (
          style.overflowX !== 'visible' &&
          (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)
        )
          return false;
      }
      return true;
    };
    const bounds = speech.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const lines = Array.from(range.getClientRects());
    const visibleLines = lines.filter(
      (line) => line.bottom > bounds.top && line.top < bounds.bottom,
    );
    const lineHeight = parseFloat(getComputedStyle(paragraph).lineHeight);
    return {
      headerVisible: visibleThroughAncestors(header),
      avatarVisible: !!avatar && visibleThroughAncestors(avatar),
      speechVisible: visibleThroughAncestors(speech),
      completeLines: visibleLines.every(
        (line) => line.top >= bounds.top - 0.5 && line.bottom <= bounds.bottom + 0.5,
      ),
      promptEndVisible:
        lines.at(-1)!.bottom <= bounds.bottom + 0.5 && lines.at(-1)!.top >= bounds.top - 0.5,
      scrollTop: speech.scrollTop,
      scrollHeight: speech.scrollHeight,
      viewportHeight: bounds.height,
      lineHeight,
      wholeLineHeight:
        speech.scrollHeight <= speech.clientHeight ||
        Math.abs(bounds.height / lineHeight - Math.round(bounds.height / lineHeight)) < 0.05,
    };
  });
  expect(layout.headerVisible).toBe(true);
  expect(layout.avatarVisible).toBe(true);
  expect(layout.speechVisible).toBe(true);
  expect(layout.completeLines).toBe(true);
  expect(layout.promptEndVisible).toBe(true);
  expect(layout.wholeLineHeight).toBe(true);
  return layout;
}

test('interrupt, quick reply, server save/reload and manual stop preserve the learner park', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const requests: Array<{
    messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
  }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    (settings) => localStorage.setItem('maic:account:settings-storage', settings),
    createSettingsStorage({ autoPlayLecture: false, ttsMuted: true }),
  );
  await page.route('**/api/chat/pi', async (route) => {
    requests.push(route.request().postDataJSON());
    const prompt =
      requests.length === 1 ? 'Which example should we try?' : 'Would you like another example?';
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        {
          type: 'agent_start',
          data: {
            messageId: `answer-${requests.length}`,
            agentId: 'default-1',
            agentName: 'Teacher',
          },
        },
        { type: 'text_delta', data: { messageId: `answer-${requests.length}`, content: prompt } },
        {
          type: 'agent_end',
          data: { messageId: `answer-${requests.length}`, agentId: 'default-1' },
        },
        {
          type: 'cue_user',
          data: {
            fromAgentId: 'default-1',
            prompt,
            options: [
              { label: 'Show an example' },
              { label: 'Let me practice' },
              { label: 'Back to the lesson', action: 'end_discussion' },
            ],
          },
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
  await page.goto('/classroom/warmup-nonexistent');
  const stageId = uniqueStageId('cue-park');
  const sceneId = 'cue-scene';
  const now = Date.now();
  const lectureText = 'This is the interrupted lecture sentence. '.repeat(12).trim();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Learner handoff verification', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: sceneId,
        stageId,
        type: 'slide',
        title: 'Learner handoff',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [
          { id: 'first', type: 'speech', text: lectureText },
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
  const play = page.locator('div[class*="z-[102]"] div.pointer-events-auto').first();
  await expect(play).toBeVisible();
  await play.click();
  await expect(page.locator('[data-bubble-role="teacher"]').first()).toContainText(
    'interrupted lecture sentence',
  );
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await input.fill('Could you explain this?');
  await input.press('Enter');
  const cue = page.locator('[data-bubble-role="user"] [data-testid="cue-user-options"]');
  await expect(cue).toBeVisible({ timeout: 20_000 });
  await expect(cue.locator('button')).toHaveCount(3);
  expect(requests).toHaveLength(1);
  await expect(page.getByTitle('Stop Discussion', { exact: true })).toBeVisible();
  await expect(page.getByTestId('cue-user-resume-lesson')).toHaveCount(0);
  await captureScreenshot(page, testInfo, 'cue-before-reload.png');

  await cue
    .getByRole('button', { name: 'Show an example', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect.poll(() => requests.length).toBe(2);
  expect(
    requests[1]!.messages.filter(
      (message) =>
        message.role === 'user' && message.parts.some((part) => part.text === 'Show an example'),
    ),
  ).toHaveLength(1);
  await expect(cue).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-bubble-role="teacher"]')).toHaveCount(1);
  await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(
    'Would you like another example?',
    { timeout: 20_000 },
  );

  const owner = await (await page.request.get('/api/persistence/learner-key')).json();
  const readPark = async () => {
    const sessionsResponse = await page.request.get(
      `/api/persistence/runtime/stages/${stageId}/learners/${encodeURIComponent(owner.learnerKey)}/sessions`,
    );
    expect(sessionsResponse.ok()).toBe(true);
    const sessions = await sessionsResponse.json();
    const states: Array<{
      type: string;
      status: string;
      updatedAt: number;
      cueUser?: { prompt?: string };
    }> = [];
    for (const session of sessions) {
      if (session.kind !== 'chat') continue;
      const response = await page.request.get(
        `/api/persistence/runtime/sessions/${encodeURIComponent(session.id)}/records`,
      );
      // Snapshot compaction may retire a generation between listSessions and
      // listRecords; HttpRuntimeStore treats the same 404 as an empty result.
      if (response.status() === 404) continue;
      expect(response.ok()).toBe(true);
      const records = await response.json();
      const state = records
        .filter(
          (record: { payload: { kind?: string } }) => record.payload.kind === 'chat_session_state',
        )
        .at(-1)?.payload;
      if (state?.type === 'qa') states.push(state);
    }
    return states.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  };
  await expect
    .poll(async () => (await readPark())?.cueUser?.prompt, { timeout: 20_000 })
    .toBe('Would you like another example?');
  await page.reload();
  await expect(cue).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-bubble-role="teacher"]')).toHaveCount(1);
  await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(
    'Would you like another example?',
  );
  expect(requests).toHaveLength(2);
  await expect(page.locator('[data-bubble-role="user"]')).toContainText('Your turn');
  await expect(page.locator('[data-bubble-role="user"]')).not.toContainText(
    'Would you like another example?',
  );
  await captureScreenshot(page, testInfo, 'cue-normal-light.png');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await captureScreenshot(page, testInfo, 'cue-normal-dark.png');
  await page.getByTitle('Fullscreen', { exact: true }).click();
  await expect(cue).toBeVisible();
  await expect(cue.locator('button')).toHaveCount(3);
  await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(
    'Would you like another example?',
  );
  await expect(cue).toHaveCSS('opacity', '1');
  await captureScreenshot(page, testInfo, 'cue-fullscreen-dark.png');
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await captureScreenshot(page, testInfo, 'cue-fullscreen-light.png');
  await cue
    .getByRole('button', { name: 'Back to the lesson', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(cue).toHaveCount(0);
  await expect(page.getByTitle('Stop Discussion', { exact: true })).toHaveCount(0);
  await page.getByTitle('Exit Fullscreen', { exact: true }).click();
  await expect(play).toBeVisible();
  expect(requests).toHaveLength(2);
  await expect.poll(async () => (await readPark())?.status, { timeout: 20_000 }).toBe('completed');
  expect((await readPark())?.cueUser).toBeUndefined();
  await captureScreenshot(page, testInfo, 'cue-stopped-paused.png');
  await play.click();
  await expect(page.locator('[data-bubble-role="teacher"]').first()).toContainText(
    'interrupted lecture sentence',
  );
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
});

const cueScenarios = [
  {
    name: 'prompt-only',
    prompt: 'What do you think?',
    teacherText: 'What do you think?',
    options: undefined,
  },
  {
    name: 'metadata-free',
    prompt: undefined,
    teacherText: 'What do you think?',
    options: undefined,
  },
  {
    name: 'actions-only prompt fallback',
    prompt: 'What does the diagram show?',
    teacherText: undefined,
    options: [
      { label: 'Explain the diagram' },
      { label: 'Continue lesson', action: 'end_discussion' as const },
    ],
  },
  {
    name: 'four bounded options',
    prompt: 'Which approach would you like to try?',
    teacherText:
      'This example connects the previous explanation to the next step. '.repeat(5) +
      'Which approach would you like to try?',
    options: [
      'Show a detailed example and explain each step with extra hints',
      'Let me practice this topic with a new problem and useful hints',
      'Explain the connection to the earlier example before practice',
      'Back to the lesson and leave the current explanation for now.',
    ].map((label, index) => ({
      label: label.padEnd(60, '.').slice(0, 60),
      ...(index === 3 ? { action: 'end_discussion' as const } : {}),
    })),
  },
];

test('Stop cancels a first Q&A during preparation before a session exists', async ({ page }) => {
  await page.addInitScript(
    (settings) => localStorage.setItem('maic:account:settings-storage', settings),
    createSettingsStorage({ autoPlayLecture: false, ttsMuted: true }),
  );
  await page.goto('/classroom/warmup-nonexistent');
  const stageId = uniqueStageId('initial-send-stop');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Cancel preparation', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'stop-scene',
        stageId,
        type: 'slide',
        title: 'Cancel preparation',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  await setCurrentScene(page, stageId, 'stop-scene');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/model-config', async (route) => {
    await gate;
    await route.fallback();
  });
  let requests = 0;
  await page.route('**/api/chat/pi', async (route) => {
    requests++;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: {"type":"done","data":{"totalAgents":0,"totalActions":0}}\n\n',
    });
  });
  try {
    await page.goto(`/classroom/${stageId}`);
    await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
    await page.keyboard.press('T');
    const input = page.getByPlaceholder('Type your message...', { exact: true });
    await input.fill('First question');
    await input.press('Enter');
    const stop = page.getByTitle('Stop Discussion', { exact: true });
    await expect(stop).toBeVisible();
    await stop.evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });
    await expect(stop).toHaveCount(0);
    const modelRead = page.waitForResponse((response) =>
      response.url().endsWith('/api/model-config'),
    );
    release();
    await modelRead;
    await page.reload();
    await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
    await expect(stop).toHaveCount(0);
    expect(requests).toBe(0);
    const owner = await (await page.request.get('/api/persistence/learner-key')).json();
    const sessions = await (
      await page.request.get(
        `/api/persistence/runtime/stages/${stageId}/learners/${encodeURIComponent(owner.learnerKey)}/sessions`,
      )
    ).json();
    expect(sessions.filter((session: { kind: string }) => session.kind === 'chat')).toHaveLength(0);
  } finally {
    release();
  }
});

for (const { name, prompt, teacherText, options } of cueScenarios) {
  test(`${name} cue survives PostgreSQL save/reload without a model request`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    let requests = 0;
    await page.addInitScript(
      (settings) => localStorage.setItem('maic:account:settings-storage', settings),
      createSettingsStorage({ autoPlayLecture: false, ttsMuted: true }),
    );
    await page.route('**/api/chat/pi', async (route) => {
      requests++;
      const events = [
        {
          type: 'agent_start',
          data: { messageId: 'open-question', agentId: 'default-1', agentName: 'Teacher' },
        },
        ...(teacherText
          ? [{ type: 'text_delta', data: { messageId: 'open-question', content: teacherText } }]
          : [
              {
                type: 'action',
                data: {
                  actionId: 'clear-board',
                  actionName: 'wb_clear',
                  params: {},
                  agentId: 'default-1',
                  messageId: 'open-question',
                },
              },
            ]),
        { type: 'agent_end', data: { messageId: 'open-question', agentId: 'default-1' } },
        {
          type: 'cue_user',
          data: { ...(prompt ? { prompt } : {}), ...(options ? { options } : {}) },
        },
        {
          type: 'done',
          data: {
            totalActions: teacherText ? 0 : 1,
            totalAgents: 1,
            agentHadContent: true,
            cueUserReceived: true,
          },
        },
      ];
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      });
    });
    await page.goto('/classroom/warmup-nonexistent');
    const stageId = uniqueStageId('open-ended-cue');
    const now = Date.now();
    await seedServerDocument(page, {
      stage: { id: stageId, name: 'Open-ended learner cue', createdAt: now, updatedAt: now },
      scenes: [
        {
          id: 'open-scene',
          stageId,
          type: 'slide',
          title: 'Open-ended question',
          order: 0,
          content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
          actions: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await setCurrentScene(page, stageId, 'open-scene');
    await page.goto(`/classroom/${stageId}`);
    await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 45_000 });
    await page.keyboard.press('T');
    const input = page.getByPlaceholder('Type your message...', { exact: true });
    await input.fill('Explain the example');
    await input.press('Enter');
    const user = page.locator('[data-bubble-role="user"]');
    await expect(user).toContainText('Your turn', {
      timeout: 20_000,
    });
    if (options)
      await expect(page.getByTestId('cue-user-options').locator('button')).toHaveCount(
        options.length,
      );
    else await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
    await expect(page.locator('[data-bubble-role="teacher"]')).toHaveCount(1);
    await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(
      teacherText ?? prompt!,
    );
    await expect(user).not.toContainText(prompt ?? teacherText!);
    const owner = await (await page.request.get('/api/persistence/learner-key')).json();
    await expect
      .poll(
        async () => {
          const sessions = await (
            await page.request.get(
              `/api/persistence/runtime/stages/${stageId}/learners/${encodeURIComponent(owner.learnerKey)}/sessions`,
            )
          ).json();
          for (const session of sessions) {
            if (session.kind !== 'chat') continue;
            const response = await page.request.get(
              `/api/persistence/runtime/sessions/${encodeURIComponent(session.id)}/records`,
            );
            if (response.status() === 404) continue;
            const records = await response.json();
            const state = records
              .filter(
                (record: { payload: { kind: string } }) =>
                  record.payload.kind === 'chat_session_state',
              )
              .at(-1)?.payload;
            if (state?.type === 'qa' && state.status === 'waiting-user') return state.cueUser;
          }
          return undefined;
        },
        { timeout: 20_000 },
      )
      .toEqual({
        ...(prompt ? { prompt } : {}),
        ...(options ? { options } : {}),
        parkedAt: expect.any(Number),
      });
    await page.reload();
    await expect(user).toContainText('Your turn', {
      timeout: 30_000,
    });
    await expect(page.getByTitle('Stop Discussion', { exact: true })).toBeVisible();
    await expect(page.locator('[data-bubble-role="teacher"]')).toHaveCount(1);
    await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(
      teacherText ?? prompt!,
    );
    await expect(user).not.toContainText(prompt ?? teacherText!);
    expect(requests).toBe(1);
    if (options?.length === 4) {
      await expect(page.locator('[data-bubble-role="teacher"]')).toContainText(prompt!);
      await page.screenshot({
        path: testInfo.outputPath('bounded-options-layout.png'),
        fullPage: true,
      });
      const bounds = await page
        .locator('[data-testid="roundtable-non-presentation-card"]')
        .evaluate((card) => {
          const parent = card.getBoundingClientRect();
          return Array.from(card.querySelectorAll('[data-bubble-role]')).map((bubble) => {
            const rect = bubble.getBoundingClientRect();
            return {
              role: bubble.getAttribute('data-bubble-role'),
              clipped: rect.top < parent.top || rect.bottom > parent.bottom,
            };
          });
        });
      expect(bounds).toHaveLength(2);
      expect(bounds.every((bubble) => !bubble.clipped)).toBe(true);
      const repliesVisible = await user.evaluate((bubble) => {
        const outer = bubble.getBoundingClientRect();
        return Array.from(bubble.querySelectorAll('p,button')).every((item) => {
          const rect = item.getBoundingClientRect();
          return rect.top >= outer.top && rect.bottom <= outer.bottom;
        });
      });
      expect(repliesVisible).toBe(true);
      for (const fullscreen of [false, true]) {
        if (fullscreen) await page.getByTitle('Fullscreen', { exact: true }).click();
        for (const dark of [false, true]) {
          await page.evaluate(
            (enabled) => document.documentElement.classList.toggle('dark', enabled),
            dark,
          );
          const variant = `${fullscreen ? 'fullscreen' : 'normal'}-${dark ? 'dark' : 'light'}`;
          await captureScreenshot(page, testInfo, `long-teacher-${variant}.png`);
          const layout = await assertParkedTeacherLayout(page);
          const buttonsVisible = await user.evaluate((bubble) => {
            const speech = bubble.querySelector('[data-bubble-speech]')!.getBoundingClientRect();
            return Array.from(bubble.querySelectorAll('button')).every((button) => {
              const bounds = button.getBoundingClientRect();
              return bounds.top >= speech.top && bounds.bottom <= speech.bottom;
            });
          });
          expect(buttonsVisible).toBe(true);
          await testInfo.attach(`long-teacher-${variant}-geometry`, {
            body: JSON.stringify(layout, null, 2),
            contentType: 'application/json',
          });
        }
      }
    }
    await captureScreenshot(page, testInfo, 'open-ended-restored.png');
    await page.getByTitle('Stop Discussion', { exact: true }).click();
    await expect(page.getByTitle('Stop Discussion', { exact: true })).toHaveCount(0);
    expect(requests).toBe(1);
  });
}
