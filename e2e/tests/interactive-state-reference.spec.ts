import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { TEST_STAGE_ID, SCENE_ID, IFRAME_TITLE, seedDatabase } from '../fixtures/interactive-state';
test.setTimeout(120_000);

test('actual classroom component reference samples declared area state on send without changing activity', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chat/pi') {
      await route.fulfill({
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
      return;
    }
    // Keep this isolated test away from every provider/model endpoint.
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(TEST_STAGE_ID);
  await classroom.waitForLoaded();
  const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
  await expect(frame.locator('#value')).toBeVisible({ timeout: 30000 });
  await frame.locator('#pause').check();
  await frame.locator('#value').press('End');
  const before = await frame.locator('script[data-maic-observation]').textContent();

  // Arming must still present the component picker; a declared state interface
  // never replaces per-component selection with a whole-area reference.
  const referenceButton = page.getByRole('button', { name: 'Reference courseware' });
  await referenceButton.click();
  await expect(referenceButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('slide-element-reference-pill')).toBeHidden();

  const iframe = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
  const [iframeBox, logical, targetRect] = await Promise.all([
    iframe.boundingBox(),
    iframe.evaluate((element) => ({
      width: (element as HTMLIFrameElement).clientWidth,
      height: (element as HTMLIFrameElement).clientHeight,
    })),
    frame.locator('#result').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }),
  ]);
  expect(iframeBox).not.toBeNull();
  const scaleX = iframeBox!.width / logical.width;
  const scaleY = iframeBox!.height / logical.height;
  await page.mouse.click(
    iframeBox!.x + (targetRect.left + targetRect.width / 2) * scaleX,
    iframeBox!.y + (targetRect.top + targetRect.height / 2) * scaleY,
  );

  const pill = page.getByTestId('slide-element-reference-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('#result');
  await expect(referenceButton).toHaveAttribute('aria-pressed', 'false');

  // The persistent outline binds to the clicked component, not to the whole area.
  const outline = frame.locator('[data-maic-picker-selected]');
  await expect(outline).toBeVisible();
  const [outlineBox, resultBox] = await Promise.all([
    outline.boundingBox(),
    frame.locator('#result').boundingBox(),
  ]);
  expect(outlineBox).not.toBeNull();
  expect(resultBox).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(outlineBox![key]).toBeCloseTo(resultBox![key], 0);

  // Referencing changes no courseware parameter and draws nothing.
  expect(await frame.locator('script[data-maic-observation]').textContent()).toBe(before);
  await expect(frame.locator('#result')).toHaveText('1');
  // Change after reference selection: request must sample 0, not selection-time 10.
  await frame.locator('#value').press('Home');
  const sending = await frame.locator('script[data-maic-observation]').textContent();
  await page.getByRole('heading', { name: 'Slider experiment' }).click();
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await expect(input).toBeVisible();
  await input.fill('What is the current value and last drawn value?');
  const requestPromise = page.waitForRequest('**/api/chat/pi');
  await input.press('Enter');
  const body = (await requestPromise).postDataJSON();
  // Reference identity stays the picked component; state scope stays the declared area.
  expect(body.elementReference).toEqual({
    kind: 'interactive_component',
    sceneId: SCENE_ID,
    selector: '#result',
  });
  expect(body.interactiveState.snapshot.identity.scopeId).toBe('experiment');
  expect(body.interactiveState.snapshot.status).toBe('available');
  expect(body.interactiveState.snapshot.observation.current.graph.objects[0].facts[0].value).toBe(
    0,
  );
  expect(body.interactiveState.snapshot.observation.rendered.graph.objects[0].facts[0].value).toBe(
    1,
  );
  expect(await frame.locator('script[data-maic-observation]').textContent()).toBe(sending);
  await expect(frame.locator('#result')).toHaveText('1');
  // An accepted receipt clears both projections, so the next question starts unreferenced.
  await expect(pill).toBeHidden();
  await expect(outline).toBeHidden();
  // Follow-up with no new reference: the identity is gone, the facts are fresh.
  await frame.locator('#value').press('End');
  // An accepted answer may close the composer, so reopen it the same way the
  // first question did before asserting the unreferenced follow-up.
  if (!(await input.isVisible())) {
    await page.getByRole('heading', { name: 'Slider experiment' }).click();
    await page.keyboard.press('T');
    await expect(input).toBeVisible();
  }
  await input.fill('And now?');
  const followUpPromise = page.waitForRequest('**/api/chat/pi');
  await input.press('Enter');
  const followUp = (await followUpPromise).postDataJSON();
  expect(followUp.elementReference).toBeUndefined();
  expect(followUp.interactiveState.snapshot.status).toBe('available');
  expect(followUp.interactiveState.snapshot.identity.scopeId).toBe('experiment');
  expect(
    followUp.interactiveState.snapshot.observation.current.graph.objects[0].facts[0].value,
  ).toBe(10);
  // Sampling alone never re-creates a component reference or its outline.
  await expect(pill).toBeHidden();
  await expect(outline).toBeHidden();

  await test.info().attach('send-time-state', {
    body: JSON.stringify(
      { elementReference: body.elementReference, interactiveState: body.interactiveState },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('missing AbortSignal.any still sends the classroom question without state', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chat/pi')
      return route.fulfill({
        contentType: 'text/event-stream',
        body:
          'data: ' +
          JSON.stringify({ type: 'done', data: { totalActions: 0, totalAgents: 0 } }) +
          '\n\n',
      });
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(TEST_STAGE_ID);
  await classroom.waitForLoaded();
  await expect(
    page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`).locator('#value'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      any: typeof AbortSignal.any,
      uuid: typeof crypto.randomUUID,
      digest: typeof crypto.subtle.digest,
    })),
  ).toEqual({ any: 'undefined', uuid: 'function', digest: 'function' });
  await page.getByRole('heading', { name: 'Slider experiment' }).click();
  await page.keyboard.press('T');
  const input = page.getByPlaceholder('Type your message...', { exact: true });
  await input.fill('What is the current value?');
  const request = page.waitForRequest('**/api/chat/pi', { timeout: 10000 });
  await input.press('Enter');
  const body = (await request).postDataJSON();
  expect(body.interactiveState).toBeUndefined();
  expect(body.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
  );
});
