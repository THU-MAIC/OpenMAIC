import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const TEST_STAGE_ID = 'e2e-video-thumbnail-stage';
const VIDEO_MEDIA_REF = 'gen_vid_thumbnail';
const LEGACY_STAGE_ID = 'e2e-legacy-video-ref-stage';
const LEGACY_VIDEO_REF = 'gen_vid_1';
const UNIQUE_VIDEO_REF = 'gen_vid_unique_legacy';
const FAILED_EXACT_STAGE_ID = 'e2e-failed-exact-video-ref-stage';
const OTHER_VIDEO_REF = 'gen_vid_other_success';
const POSTER_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function seedVideoThumbnailStage({
  page,
  stageId = TEST_STAGE_ID,
  courseName = 'Video Thumbnail Course',
  slideMediaRef = VIDEO_MEDIA_REF,
  storedMediaRef = slideMediaRef,
  storedError,
  extraStoredMediaRefs = [],
}: {
  page: Page;
  stageId?: string;
  courseName?: string;
  slideMediaRef?: string;
  storedMediaRef?: string;
  storedError?: string;
  extraStoredMediaRefs?: string[];
}) {
  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({
      stageId,
      courseName,
      slideMediaRef,
      storedMediaRef,
      storedError,
      extraStoredMediaRefs,
      posterBase64,
      theme,
    }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(
            ['stages', 'scenes', 'stageOutlines', 'mediaFiles'],
            'readwrite',
          );
          const now = Date.now();
          const videoBytes = new Uint8Array([
            0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 0, 0, 0, 0, 109, 112, 52, 50, 105,
            115, 111, 109,
          ]);
          const posterBytes = Uint8Array.from(atob(posterBase64), (char) => char.charCodeAt(0));
          const videoBlob = new Blob([videoBytes], { type: 'video/mp4' });
          const posterBlob = new Blob([posterBytes], { type: 'image/png' });
          const failedVideoBlob = new Blob([], { type: 'video/mp4' });

          const putVideoRecord = (mediaRef: string, error?: string) => {
            const blob = error ? failedVideoBlob : videoBlob;
            tx.objectStore('mediaFiles').put({
              id: `${stageId}:${mediaRef}`,
              stageId,
              type: 'video',
              blob,
              mimeType: 'video/mp4',
              size: blob.size,
              poster: error ? undefined : posterBlob,
              prompt: 'A generated classroom video preview',
              params: '{}',
              error,
              createdAt: now,
            });
          };

          tx.objectStore('stages').put({
            id: stageId,
            name: courseName,
            description: '',
            language: 'en-US',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });

          tx.objectStore('scenes').put({
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
                theme,
                background: { type: 'solid', color: '#111827' },
                elements: [
                  {
                    id: 'video-el',
                    type: 'video',
                    src: slideMediaRef,
                    mediaRef: slideMediaRef,
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
          });

          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });

          putVideoRecord(storedMediaRef, storedError);
          for (const mediaRef of extraStoredMediaRefs) {
            putVideoRecord(mediaRef);
          }

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
      });
    },
    {
      stageId,
      courseName,
      slideMediaRef,
      storedMediaRef,
      storedError,
      extraStoredMediaRefs,
      posterBase64: POSTER_BASE64,
      theme: defaultTheme,
    },
  );

  await page.goto('/', { waitUntil: 'networkidle' });
}

test.describe('Home recent video thumbnails', () => {
  test('renders generated video thumbnails and opens the card from the preview area', async ({
    page,
  }) => {
    await seedVideoThumbnailStage({ page });

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
    await page.waitForURL(`**/classroom/${TEST_STAGE_ID}`);

    const classroomVideo = page.locator('[data-video-element] video[controls]');
    await expect(classroomVideo).toHaveCount(1);
    await expect(classroomVideo).toBeVisible({ timeout: 10_000 });
    await expect(classroomVideo).toHaveAttribute('src', /^blob:/);
  });

  test('falls back from legacy gen_vid_1 refs to the single stored video media file', async ({
    page,
  }) => {
    await seedVideoThumbnailStage({
      page,
      stageId: LEGACY_STAGE_ID,
      courseName: 'Legacy Video Ref Course',
      slideMediaRef: LEGACY_VIDEO_REF,
      storedMediaRef: UNIQUE_VIDEO_REF,
    });

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Legacy Video Ref Course',
    });
    const thumbnailVideo = card.locator('[data-video-element] video');

    await expect(thumbnailVideo).toBeVisible({ timeout: 10_000 });
    await expect(thumbnailVideo).toHaveAttribute('src', /^blob:/);
    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();

    await card.click({ position: { x: 24, y: 24 } });
    await page.waitForURL(`**/classroom/${LEGACY_STAGE_ID}`);

    const classroomVideo = page.locator('[data-video-element] video[controls]');
    await expect(classroomVideo).toHaveCount(1);
    await expect(classroomVideo).toBeVisible({ timeout: 10_000 });
    await expect(classroomVideo).toHaveAttribute('src', /^blob:/);
  });

  test('does not fall back to another video when the exact legacy ref failed', async ({ page }) => {
    await seedVideoThumbnailStage({
      page,
      stageId: FAILED_EXACT_STAGE_ID,
      courseName: 'Failed Exact Video Ref Course',
      slideMediaRef: LEGACY_VIDEO_REF,
      storedMediaRef: LEGACY_VIDEO_REF,
      storedError: 'Generation failed',
      extraStoredMediaRefs: [OTHER_VIDEO_REF],
    });

    const card = page.locator('.group.cursor-pointer').filter({
      hasText: 'Failed Exact Video Ref Course',
    });

    await expect(card.locator('[data-testid="thumbnail-video-indicator"]')).toBeVisible();
    await expect(card.locator('[data-video-element] video')).toHaveCount(0);
  });
});
