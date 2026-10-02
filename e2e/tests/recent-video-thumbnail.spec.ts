import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/scene-content';
import { seedServerAsset, seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const POSTER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const VIDEO_BYTES = new Uint8Array([
  0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105, 115, 111,
  109,
]);

/**
 * A course whose first slide is a generated video: the bytes and the poster
 * are in the owner's asset pool, and the slide holds the allocated ids, exactly
 * as generation leaves it.
 */
async function seedVideoThumbnailStage(page: Page, courseName: string): Promise<string> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId('e2e-video-thumbnail-stage');
  const videoId = await seedServerAsset(page, VIDEO_BYTES, 'video/mp4');
  const posterId = await seedServerAsset(page, Buffer.from(POSTER_BASE64, 'base64'), 'image/png');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: courseName,
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: 'scene-video-thumbnail',
        stageId,
        type: 'slide',
        title: 'Video preview',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-video-thumbnail',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: '#111827' },
            elements: [
              {
                id: 'video-el',
                type: 'video',
                src: videoId,
                mediaRef: videoId,
                poster: posterId,
                left: 0,
                top: 0,
                width: 1000,
                height: 562.5,
                rotate: 0,
                autoplay: false,
              },
            ],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  return stageId;
}

test.describe('Home recent video thumbnails', () => {
  test('renders generated video thumbnails and opens the card from the preview area', async ({
    page,
  }) => {
    const stageId = await seedVideoThumbnailStage(page, 'Video Thumbnail Course');

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Video Thumbnail Course',
    });
    const video = card.locator('[data-video-element] video');

    await expect(video).toBeVisible({ timeout: 10_000 });
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect(video).toHaveAttribute('poster', /^blob:/);
    await expect(video).not.toHaveAttribute('controls', '');
    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();

    await card.click({ position: { x: 24, y: 24 } });
    await page.waitForURL(`**/classroom/${stageId}`);

    const classroomVideo = page.locator('[data-video-element] video[controls]');
    await expect(classroomVideo).toHaveCount(1);
    await expect(classroomVideo).toBeVisible({ timeout: 10_000 });
    await expect(classroomVideo).toHaveAttribute('src', /^blob:/);
  });
});
