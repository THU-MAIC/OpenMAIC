import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { TINY_MP4_BASE64 } from '../fixtures/test-data/tiny-video';
import { seedServerAsset, seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

const POSTER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
/**
 * A course whose first slide is a generated video: the bytes and the poster
 * are in the owner's asset pool, and the slide holds the allocated ids, exactly
 * as generation leaves it.
 */
async function seedVideoThumbnailStage(
  page: Page,
  courseName: string,
  withPoster: boolean,
): Promise<string> {
  const stageId = uniqueStageId('e2e-video-thumbnail-stage');
  const videoId = await seedServerAsset(
    page,
    new Uint8Array(Buffer.from(TINY_MP4_BASE64, 'base64')),
    'video/mp4',
  );
  const posterId = withPoster
    ? await seedServerAsset(page, Buffer.from(POSTER_BASE64, 'base64'), 'image/png')
    : undefined;
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
                ...(posterId ? { poster: posterId } : {}),
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
  return stageId;
}

test('renders poster and opening-frame thumbnails without media requests and opens the preview', async ({
  page,
}) => {
  await page.goto('/');
  const prefix = `Video Thumbnail ${crypto.randomUUID().slice(0, 6)}`;
  const stageId = await seedVideoThumbnailStage(page, `${prefix} poster`, true);
  await seedVideoThumbnailStage(page, `${prefix} frame`, false);
  const failed: string[] = [];
  const mediaLoads: string[] = [];
  page.on('requestfailed', (request) => {
    // Next may abort a fully received RSC prefetch stream.
    if (new URL(request.url()).searchParams.has('_rsc')) return;
    failed.push(`${request.resourceType()} ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on('request', (request) => {
    if (request.resourceType() === 'media') mediaLoads.push(request.url());
  });
  const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });
  const shown = async () => {
    await expect(cards).toHaveCount(2);
    const posters = cards.locator('[data-video-element] [data-thumbnail-video-poster]');
    await expect(posters).toHaveCount(2, { timeout: 15_000 });
    for (const poster of await posters.all()) {
      await expect(poster).toBeVisible();
      await expect(poster).toHaveAttribute('src', /^blob:/);
      await expect
        .poll(() => poster.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
    }
    await expect(cards.locator('video')).toHaveCount(0);
    await expect(cards.getByTestId('thumbnail-video-indicator')).toHaveCount(2);
  };
  await page.goto('/');
  await shown();
  await page.reload();
  await shown();
  expect(mediaLoads).toEqual([]);
  expect(failed).toEqual([]);

  const card = cards.filter({ hasText: `${prefix} poster` });
  await expect(card.getByTestId('thumbnail-video-indicator')).toBeVisible();
  await card.click({ position: { x: 24, y: 24 } });
  await page.waitForURL(`**/classroom/${stageId}`);
  const classroomVideo = page.locator('[data-video-element] video[controls]');
  await expect(classroomVideo).toHaveCount(1);
  await expect(classroomVideo).toBeVisible({ timeout: 10_000 });
  await expect(classroomVideo).toHaveAttribute('src', /^blob:/);
});
