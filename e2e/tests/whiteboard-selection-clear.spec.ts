import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedDatabase } from '../fixtures/interactive-state';

test('clears whiteboard selection on canvas click, pan and double-click reset while preserving selection and zoom', async ({
  page,
}, testInfo) => {
  const stageId = await seedDatabase(page, {
    whiteboard: [
      {
        id: 'selection-board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          {
            id: 'selection-text',
            type: 'text',
            left: 100,
            top: 80,
            width: 600,
            height: 70,
            rotate: 0,
            content: '<p style="font-size: 28px">Selectable whiteboard text</p>',
            defaultFontName: 'Arial',
            defaultColor: '#111111',
          },
          {
            id: 'selection-code',
            type: 'code',
            left: 100,
            top: 200,
            width: 600,
            height: 150,
            rotate: 0,
            language: 'javascript',
            fontSize: 24,
            showLineNumbers: true,
            lines: [{ id: 'line-1', content: 'const answer = 42;' }],
          },
        ],
      },
    ],
  });
  const classroom = new ClassroomPage(page);
  await classroom.goto(stageId);
  await classroom.waitForLoaded();
  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  const text = page.locator('#screen-element-selection-text .ProseMirror-static p');
  const code = page
    .locator('#screen-element-selection-code')
    .getByText('const answer = 42;', { exact: true })
    .last();
  await expect(text).toBeVisible();
  const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
  const canvas = (await page.locator('.whiteboard-screen-canvas').boundingBox())!;
  const empty = { x: canvas.x + canvas.width * 0.8, y: canvas.y + canvas.height * 0.8 };

  await text.dblclick({ position: { x: 5, y: 5 } });
  await expect.poll(selection).toBe('Selectable');
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(selection).toBe('');
  await page.screenshot({ path: testInfo.outputPath('whiteboard-selection-cleared.png') });
  await testInfo.attach('selection-cleared', {
    path: testInfo.outputPath('whiteboard-selection-cleared.png'),
    contentType: 'image/png',
  });

  await code.dblclick({ position: { x: 5, y: 5 } });
  await expect.poll(selection).toBe('const');
  const beforePan = (await text.boundingBox())!;
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await expect.poll(selection).toBe('');
  await page.mouse.move(empty.x + 50, empty.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await text.boundingBox())!.x).toBeGreaterThan(beforePan.x + 30);

  const beforeZoom = (await text.boundingBox())!;
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => (await text.boundingBox())!.width)
    .toBeGreaterThan(beforeZoom.width);
  await text.dblclick({ position: { x: 5, y: 5 } });
  await expect.poll(selection).toBe('Selectable');

  await page.mouse.dblclick(empty.x, empty.y);
  await expect.poll(selection).toBe('');
  await expect.poll(async () => (await text.boundingBox())!.x).toBeCloseTo(beforePan.x, 0);
  await expect.poll(async () => (await text.boundingBox())!.width).toBeCloseTo(beforePan.width, 0);
  await text.dblclick({ position: { x: 5, y: 5 } });
  await expect.poll(selection).toBe('Selectable');
});
