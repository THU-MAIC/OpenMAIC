import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { TEST_STAGE_ID, seedDatabase } from '../fixtures/interactive-state';

test.setTimeout(120_000);

test('selects a panned/zoomed whiteboard element, sends its identity, and retains a question after clear', async ({
  page,
}) => {
  let posts = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chat/pi') {
      posts++;
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'X-OpenMAIC-Element-Reference-Accepted': '1',
        },
        body:
          'data: ' +
          JSON.stringify({ type: 'done', data: { totalActions: 0, totalAgents: 0 } }) +
          '\n\n',
      });
    }
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await seedDatabase(page, {
    whiteboard: [
      {
        id: 'board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          {
            id: 'board-fact',
            type: 'text',
            left: 200,
            top: 180,
            width: 400,
            height: 70,
            rotate: 0,
            content: '<p>Buoyancy equals displaced liquid weight.</p>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
        ],
      },
    ],
  });
  const classroom = new ClassroomPage(page);
  await classroom.goto(TEST_STAGE_ID);
  await classroom.waitForLoaded();
  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  const fact = page.locator('[id="screen-element-board-fact"] > div').first();
  await expect(fact).toBeVisible();
  await fact.hover();
  await page.mouse.wheel(0, -150);
  const before = (await fact.boundingBox())!;
  await page.mouse.move(before.x + 30, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 90, before.y + 50, { steps: 5 });
  await page.mouse.up();
  const referenceButton = page.getByRole('button', { name: 'Reference content', exact: true });
  await referenceButton.click();
  await expect(page.getByTestId('whiteboard-element-pick-overlay')).toBeVisible();
  const box = (await fact.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pill = page.getByTestId('slide-element-reference-pill');
  await expect(pill).toContainText('Whiteboard');
  await expect(pill).toContainText('Buoyancy equals');
  await expect(page.getByTestId('whiteboard-element-pick-overlay')).toBeHidden();
  const outline = page.getByTestId('whiteboard-element-reference-outline');
  await expect(outline).toHaveCount(1);
  await expect(outline).toHaveAttribute('data-element-id', 'board-fact');
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(input).toBeVisible();
  await expect(outline).toBeVisible();
  await input.fill('Why is this true?');
  const pending = page.waitForRequest('**/api/chat/pi');
  await input.press('Enter');
  expect((await pending).postDataJSON().elementReference).toEqual({
    kind: 'whiteboard_element',
    whiteboardId: 'board',
    elementId: 'board-fact',
  });
  await expect(pill).toBeHidden();
  await expect(outline).toHaveCount(0);

  await referenceButton.click();
  const nextBox = (await fact.boundingBox())!;
  await page.mouse.click(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2);
  await expect(pill).toBeVisible();
  await expect(outline).toBeVisible();
  await page.getByTitle('Clear Whiteboard', { exact: true }).click();
  await expect(outline).toHaveCount(0);
  await expect(fact).toBeHidden();
  if (!(await input.isVisible())) await page.keyboard.press('T');
  await expect(input).toBeVisible();
  await input.fill('Explain this again');
  await input.press('Enter');
  await expect(input).toHaveValue('Explain this again');
  await expect(
    page.getByText(
      'The referenced whiteboard element has changed or is no longer available. Select it again or remove the reference before sending.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(posts).toBe(1);
});
