import { expect, test } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { ClassroomPage } from '../pages/classroom.page';

const TEST_STAGE_ID = 'e2e-interactive-component-reference';
const SCENE_ID = 'scene-interactive-slider';
const IFRAME_TITLE = `Interactive Scene ${SCENE_ID}`;
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

test.setTimeout(120_000);

const INTERACTIVE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif;display:grid;place-items:center;height:100vh;background:#f5f3ff">
  <label for="angle-slider" style="display:grid;gap:16px;font-size:24px;color:#312e81">
    Launch angle
    <input id="angle-slider" name="angle" type="range" min="0" max="90" step="5" value="45" style="width:420px">
  </label>
  <script>document.getElementById('angle-slider').value = '70';</script>
</body></html>`;

async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ stageId, sceneId, html }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('maic-documents', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('stages', { keyPath: 'id' });
          const scenes = db.createObjectStore('scenes', { keyPath: ['stageId', 'id'] });
          scenes.createIndex('by-stage', 'stageId');
          db.createObjectStore('outlines', { keyPath: 'stageId' });
        };
        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'outlines'], 'readwrite');
          const now = Date.now();
          tx.objectStore('stages').put({
            id: stageId,
            name: 'Interactive component reference',
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
            dslVersion: '0.1.0',
          });
          tx.objectStore('scenes').put({
            id: sceneId,
            stageId,
            type: 'interactive',
            title: 'Slider experiment',
            order: 0,
            content: { type: 'interactive', url: '', html },
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('outlines').put({
            stageId,
            outline: { outlines: [], createdAt: now, updatedAt: now },
          });
          localStorage.setItem(
            `maic:device:editor-current-scene:${stageId}`,
            JSON.stringify({ sceneId, updatedAt: new Date(now).toISOString() }),
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    { stageId: TEST_STAGE_ID, sceneId: SCENE_ID, html: INTERACTIVE_HTML },
  );
}

test('the global courseware entry selects one scaled source-authored component', async ({
  page,
}) => {
  await seedDatabase(page);
  const classroom = new ClassroomPage(page);
  await classroom.goto(TEST_STAGE_ID);
  await classroom.waitForLoaded();

  const iframe = page.locator(`iframe[title="${IFRAME_TITLE}"]`);
  const frame = page.frameLocator(`iframe[title="${IFRAME_TITLE}"]`);
  const slider = frame.locator('#angle-slider');
  await expect(iframe).toBeVisible({ timeout: 15_000 });
  await expect(slider).toBeVisible();
  await expect
    .poll(() =>
      slider.evaluate((element) => ({
        sourceValue: element.getAttribute('value'),
        liveValue: (element as HTMLInputElement).value,
      })),
    )
    .toEqual({ sourceValue: '45', liveValue: '70' });

  const referenceButton = page.getByRole('button', { name: 'Reference courseware' });
  await referenceButton.click();
  await expect(frame.locator('[data-maic-element-picker-overlay]')).toBeAttached();
  const [iframeBox, logicalViewport, sliderRect] = await Promise.all([
    iframe.boundingBox(),
    iframe.evaluate((element) => ({
      width: (element as HTMLIFrameElement).clientWidth,
      height: (element as HTMLIFrameElement).clientHeight,
    })),
    slider.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }),
  ]);
  expect(iframeBox).not.toBeNull();
  const scaleX = iframeBox!.width / logicalViewport.width;
  const scaleY = iframeBox!.height / logicalViewport.height;
  expect(scaleX).toBeCloseTo(scaleY, 2);
  expect(scaleX).toBeLessThan(0.95);
  expect(scaleY).toBeLessThan(0.95);
  await page.mouse.click(
    iframeBox!.x + (sliderRect.left + sliderRect.width / 2) * scaleX,
    iframeBox!.y + (sliderRect.top + sliderRect.height / 2) * scaleY,
  );

  const pill = page.getByTestId('slide-element-reference-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('Interactive');
  await expect(pill).toContainText('#angle-slider');
  await expect(referenceButton).toHaveAttribute('aria-pressed', 'false');

  const selectedOutline = frame.locator('[data-maic-picker-selected]');
  await expect(selectedOutline).toBeVisible();
  const [selectedBox, selectedSliderBox] = await Promise.all([
    selectedOutline.boundingBox(),
    slider.boundingBox(),
  ]);
  expect(selectedBox).not.toBeNull();
  expect(selectedSliderBox).not.toBeNull();
  expect(selectedBox!.x).toBeCloseTo(selectedSliderBox!.x, 0);
  expect(selectedBox!.y).toBeCloseTo(selectedSliderBox!.y, 0);
  expect(selectedBox!.width).toBeCloseTo(selectedSliderBox!.width, 0);
  expect(selectedBox!.height).toBeCloseTo(selectedSliderBox!.height, 0);

  await slider.evaluate((element) => {
    element.style.transform = 'translateX(80px)';
  });
  await expect
    .poll(async () => {
      const [outlineBox, sliderBox] = await Promise.all([
        selectedOutline.boundingBox(),
        slider.boundingBox(),
      ]);
      if (!outlineBox || !sliderBox) return null;
      return {
        alignedX: Math.abs(outlineBox.x - sliderBox.x) < 2,
        moved: outlineBox.x > selectedBox!.x + 20,
      };
    })
    .toEqual({ alignedX: true, moved: true });

  await page.getByRole('button', { name: 'Remove courseware reference' }).click();
  await expect(pill).toBeHidden();
  await expect(selectedOutline).toBeHidden();
});
