import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { TINY_MP4_BASE64 } from '../fixtures/test-data/tiny-video';
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
async function seedVideoThumbnailStage(
  page: Page,
  courseName: string,
  video: { bytes: Uint8Array; withPoster: boolean } = { bytes: VIDEO_BYTES, withPoster: true },
): Promise<string> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const stageId = uniqueStageId('e2e-video-thumbnail-stage');
  const videoId = await seedServerAsset(page, video.bytes, 'video/mp4');
  const posterId = video.withPoster
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
    const poster = card.locator('[data-video-element] [data-thumbnail-video-poster]');

    // The thumbnail draws the video by its poster and never loads the video.
    await expect(poster).toBeVisible({ timeout: 10_000 });
    await expect(poster).toHaveAttribute('src', /^blob:/);
    await expect(card.locator('video')).toHaveCount(0);
    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();

    await card.click({ position: { x: 24, y: 24 } });
    await page.waitForURL(`**/classroom/${stageId}`);

    const classroomVideo = page.locator('[data-video-element] video[controls]');
    await expect(classroomVideo).toHaveCount(1);
    await expect(classroomVideo).toBeVisible({ timeout: 10_000 });
    await expect(classroomVideo).toHaveAttribute('src', /^blob:/);
  });

  test('draws video thumbnails without loading the videos, so the page has no failed requests', async ({
    page,
  }) => {
    const prefix = `No Abort ${crypto.randomUUID().slice(0, 6)}`;
    const decodable = new Uint8Array(Buffer.from(TINY_MP4_BASE64, 'base64'));
    await seedVideoThumbnailStage(page, `${prefix} poster`, { bytes: decodable, withPoster: true });
    // Generated videos usually come without a poster: the opening frame stands in.
    await seedVideoThumbnailStage(page, `${prefix} frame`, { bytes: decodable, withPoster: false });

    const failed: string[] = [];
    const mediaLoads: string[] = [];
    page.on('requestfailed', (request) => {
      // Next.js may release an RSC prefetch stream it has fully received before
      // the browser sees its end, which the browser reports as aborted.
      if (new URL(request.url()).searchParams.has('_rsc')) return;
      failed.push(`${request.resourceType()} ${request.url()} ${request.failure()?.errorText}`);
    });
    page.on('request', (request) => {
      if (request.resourceType() === 'media') mediaLoads.push(request.url());
    });

    const cards = page.locator('.group.cursor-pointer').filter({ hasText: prefix });
    const posters = cards.locator('[data-video-element] [data-thumbnail-video-poster]');
    const shown = async () => {
      await expect(cards).toHaveCount(2);
      await expect(posters).toHaveCount(2, { timeout: 15_000 });
      for (const poster of await posters.all()) {
        await expect(poster).toHaveAttribute('src', /^blob:/);
        await expect
          .poll(() => poster.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
      }
      await expect(cards.locator('video')).toHaveCount(0);
    };

    await page.goto('/');
    await shown();
    // And from the device cache.
    await page.reload();
    await shown();

    expect(mediaLoads).toEqual([]);
    expect(failed).toEqual([]);
  });
});
