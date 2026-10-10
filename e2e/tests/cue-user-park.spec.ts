import { test, expect } from '../fixtures/base';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';
import { createSettingsStorage } from '../fixtures/test-data/settings';

test('interrupt, quick reply, server save/reload and manual stop preserve the learner park', async ({
  page,
}) => {
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
            options: ['Show an example', 'Let me practice', '不用，继续课程'],
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
  await page.screenshot({ path: '../ui-cue-before-reload.png', fullPage: true });

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
  await expect(page.locator('[data-bubble-role="user"]')).toContainText(
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
  await expect(page.locator('[data-bubble-role="user"]')).toContainText(
    'Would you like another example?',
  );
  expect(requests).toHaveLength(2);
  await page.screenshot({ path: '../ui-cue-restored.png', fullPage: true });
  await page.getByTitle('Fullscreen', { exact: true }).click();
  await expect(cue).toBeVisible();
  await expect(cue.locator('button')).toHaveCount(3);
  await page.screenshot({ path: '../ui-cue-presentation.png', fullPage: true });
  await cue
    .getByRole('button', { name: '不用，继续课程', exact: true })
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
  await page.screenshot({ path: '../ui-cue-stopped-paused.png', fullPage: true });
  await play.click();
  await expect(page.locator('[data-bubble-role="teacher"]').first()).toContainText(
    'interrupted lecture sentence',
  );
  expect(requests).toHaveLength(2);
  expect(errors).toEqual([]);
});
