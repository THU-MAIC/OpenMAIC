import { devices, type Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { createMockScene } from '../fixtures/test-data/generated-scene';

const question = 'Would you like an example or the explanation?';
const options = ['Show an example', 'Continue the explanation'];

test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium', locale: 'en-US' });

async function seedWhiteboardProjection(page: Page, stageId: string) {
  const learner = await page.request.get('/api/persistence/learner-key');
  await expect(learner).toBeOK();
  const { learnerKey } = await learner.json();
  const sessionId = `whiteboard:${encodeURIComponent(stageId)}:${encodeURIComponent(learnerKey)}`;
  const now = new Date().toISOString();
  const session = await page.request.post('/api/persistence/runtime/sessions', {
    data: {
      id: sessionId,
      kind: 'whiteboard',
      stageId,
      learnerKey,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  });
  await expect(session).toBeOK();
  const record = await page.request.post(
    `/api/persistence/runtime/sessions/${encodeURIComponent(sessionId)}/records`,
    {
      data: {
        id: 'teacher-drawing',
        sessionId,
        createdAt: now,
        expectedLastSeq: null,
        payload: {
          payloadVersion: 1,
          operationId: 'teacher-drawing',
          operation: {
            kind: 'element_added',
            element: {
              id: 'drawing',
              type: 'text',
              left: 40,
              top: 50,
              width: 240,
              height: 60,
              rotate: 0,
              content: 'Example on the board',
              defaultFontName: 'Inter',
              defaultColor: '#000000',
            },
          },
        },
      },
    },
  );
  await expect(record).toBeOK();
}

async function startQuestion(
  page: Page,
  teacherQuestion: string | { kind: 'laser' | 'projection' },
  answer: string,
) {
  await page.addInitScript(() => {
    localStorage.setItem('locale', 'en-US');
    localStorage.setItem('lastSeenVersion', '999.0.0');
  });
  await page.goto('/');
  const stageId = uniqueStageId('mobile-replies');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Suggested replies', createdAt: now, updatedAt: now },
    scenes: [createMockScene(stageId)],
  });
  if (typeof teacherQuestion !== 'string' && teacherQuestion.kind === 'projection') {
    await seedWhiteboardProjection(page, stageId);
  }

  const submissions: string[] = [];
  await page.route('**/api/chat/pi', async (route) => {
    const request = route.request().postDataJSON();
    submissions.push(request.messages.at(-1)?.parts[0]?.text);
    const first = submissions.length === 1;
    const messageId = `reply-${submissions.length}`;
    const agentId = 'default-1';
    const content = first ? teacherQuestion : answer;
    const output =
      typeof content === 'string'
        ? { type: 'text_delta', data: { messageId, content } }
        : content.kind === 'laser'
          ? {
              type: 'action',
              data: {
                actionId: 'laser-title',
                actionName: 'laser',
                agentId,
                messageId,
                params: { elementId: 'title-el' },
              },
            }
          : { type: 'whiteboard', data: { kind: 'projection', stageId, lastSeq: 0 } };
    const events = [
      { type: 'agent_start', data: { agentId, messageId, agentName: 'Teacher' } },
      output,
      { type: 'agent_end', data: { agentId, messageId } },
      { type: 'cue_user', data: { fromAgentId: agentId, ...(first ? { options } : {}) } },
      {
        type: 'done',
        data: {
          totalActions: typeof content === 'string' ? 0 : 1,
          totalAgents: 1,
          agentHadContent: true,
          cueUserReceived: true,
        },
      },
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    });
  });

  await page.goto(`/classroom/${stageId}`);
  await page.getByRole('textbox', { name: /ask the teacher/i }).fill('Give me two choices');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  return submissions;
}

test('keeps mobile suggested replies with their question when chat is closed and reopened', async ({
  page,
}) => {
  const submissions = await startQuestion(page, question, 'Here is an example.');
  const chat = page.getByTestId('mobile-classroom-lecture');
  const questionBubble = chat.locator('[data-chat-bubble="agent"]').filter({ hasText: question });
  await expect(questionBubble).toBeVisible();
  const reply = questionBubble.locator('..').getByRole('button', { name: options[0], exact: true });
  await expect(reply).toBeVisible();
  await expect(page.getByTestId('mobile-roundtable').getByTestId('cue-user-options')).toHaveCount(
    0,
  );

  await page.getByTestId('mobile-nav-classroom').first().click();
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
  await page.getByTestId('mobile-nav-chat').first().click();
  await expect(reply).toBeVisible();

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(reply).toBeVisible();
  await page.getByTestId('mobile-panel-close').click();
  await expect(questionBubble).toBeHidden();
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);

  await page.getByTestId('mobile-nav-chat').first().click();
  await expect(reply).toBeVisible();
  await reply.click();
  await expect(chat.getByText('Here is an example.')).toBeVisible();
  expect(submissions).toEqual(['Give me two choices', options[0]]);
  await expect(page.getByTestId('cue-user-options')).toHaveCount(0);
});

test('shows suggested replies under an action-only teacher message', async ({ page }) => {
  await startQuestion(page, { kind: 'laser' }, 'Here is an example.');
  const actionBubble = page.locator('[data-chat-bubble="agent"]').filter({ hasText: 'Laser' });
  await expect(actionBubble).toBeVisible();
  await expect(
    actionBubble.locator('..').getByRole('button', { name: options[0], exact: true }),
  ).toBeVisible();
});

test('keeps suggested replies in chat when a whiteboard projection has no message bubble', async ({
  page,
}) => {
  await startQuestion(page, { kind: 'projection' }, 'Here is an example.');
  const session = page.getByTestId('mobile-classroom-lecture').locator('[data-chat-session]');
  await expect(session.getByRole('button', { name: options[0], exact: true })).toBeVisible();
  await expect(session.locator('[data-chat-bubble="agent"]')).toHaveCount(0);
});

for (const orientation of ['portrait', 'landscape'] as const) {
  test(`follows the latest chat messages after picking a reply in ${orientation}`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    const finalLine = 'End of the example.';
    await startQuestion(
      page,
      `${'•\n\n'.repeat(14)}${question}`,
      `${'•\n\n'.repeat(10)}${finalLine}`,
    );
    const chat = page.getByTestId('mobile-classroom-lecture');
    const scrollPanel = chat.locator('[role="tabpanel"] > .overflow-y-auto');
    const reply = chat.getByRole('button', { name: options[0], exact: true });
    await expect(reply).toBeVisible({ timeout: 12_000 });
    if (orientation === 'landscape') await page.setViewportSize({ width: 844, height: 390 });
    await expect(reply).toBeVisible();
    const distanceFromBottom = () =>
      scrollPanel.evaluate((panel) => panel.scrollHeight - panel.clientHeight - panel.scrollTop);
    await scrollPanel.evaluate((panel) => {
      panel.scrollTop = panel.scrollHeight - panel.clientHeight - 10;
    });
    await expect.poll(distanceFromBottom).toBeGreaterThan(3);
    await expect(reply).toBeInViewport();

    await reply.click();
    await expect(chat.getByText(finalLine)).toBeVisible();
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(3);
  });
}
