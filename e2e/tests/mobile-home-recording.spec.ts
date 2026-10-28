import { expect, test } from '@playwright/test';
import { modelSettingsViewFor } from '../../tests/helpers/model-settings-view';

test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
});

test.describe('active phone microphone', () => {
  for (const action of ['typing', 'example'] as const) {
    test(`keeps the stop control after ${action} and releases the microphone on stop`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.route('**/api/model-config', (route) =>
        route.fulfill({
          json: modelSettingsViewFor({
            llm: { registryId: 'openai', modelId: 'test-model' },
            asr: { registryId: 'openai-whisper', modelId: 'compatible-asr' },
          }),
        }),
      );
      let uploads = 0;
      await page.route('**/api/transcription', (route) => {
        uploads++;
        return route.fulfill({ json: { text: 'spoken words' } });
      });
      await page.addInitScript(() => {
        const state = window as typeof window & { __speechStreams: MediaStream[] };
        state.__speechStreams = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await original(constraints);
          state.__speechStreams.push(stream);
          return stream;
        };
      });
      await page.goto('/');
      const mic = page.locator('.home-speech');
      await mic.click();
      await page.waitForFunction(
        () =>
          (window as typeof window & { __speechStreams: MediaStream[] }).__speechStreams.length > 0,
      );
      await expect(mic).toHaveAttribute('data-state', 'active');
      if (action === 'typing') await page.getByTestId('home-requirement').fill('Learn waves');
      else {
        await page.getByTestId('home-options-open').click();
        await page.getByRole('button', { name: 'Learn Python from scratch', exact: true }).click();
      }
      await expect(mic).toBeVisible();
      await expect(mic).toHaveAccessibleName('Stop recording');
      expect(uploads).toBe(0);
      await mic.click();
      await expect(page.getByTestId('home-requirement')).toHaveValue(/spoken words$/);
      await expect(mic).not.toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as typeof window & { __speechStreams: MediaStream[] }).__speechStreams
              .flatMap((s) => s.getTracks())
              .every((t) => t.readyState === 'ended'),
          ),
        )
        .toBe(true);
      expect(uploads).toBe(1);
    });
  }
});
