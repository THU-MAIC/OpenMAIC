import { test, expect } from '../fixtures/base';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';
import guide from '../../public/guide-course/zh.json';

test.use({ isMobile: true, hasTouch: true });

for (const locale of ['en-US', 'de-DE', 'fr-FR']) {
  for (const softClosing of [false, true]) {
    test(`phone discussion actions fit without overlapping navigation (${locale}, ${softClosing ? 'closing' : 'active'})`, async ({
      page,
    }, testInfo) => {
      await page
        .context()
        .addCookies([{ name: 'locale', value: locale, url: 'http://localhost:3002' }]);
      await page.addInitScript((language) => localStorage.setItem('locale', language), locale);
      await page.setViewportSize({ width: 390, height: 844 });
      const id = uniqueStageId('phone-discussion-toolbar');
      await page.goto('/');
      await seedServerDocument(page, {
        ...guide,
        stage: { ...guide.stage, id },
        scenes: guide.scenes.map((scene) => ({ ...scene, stageId: id })),
      });
      await setCurrentScene(page, id, guide.scenes[0].id);
      await page.route('**/api/chat/pi', async (route) => {
        const events = [
          {
            type: 'agent_start',
            data: { messageId: 'answer', agentId: 'default-1', agentName: 'Teacher' },
          },
          {
            type: 'text_delta',
            data: { messageId: 'answer', content: 'Consider the signal at each point in time.' },
          },
          { type: 'agent_end', data: { messageId: 'answer', agentId: 'default-1' } },
          ...(!softClosing
            ? [
                {
                  type: 'cue_user',
                  data: { fromAgentId: 'default-1', prompt: 'What should we explore next?' },
                },
              ]
            : []),
          {
            type: 'done',
            data: {
              totalActions: 0,
              totalAgents: 1,
              agentHadContent: true,
              cueUserReceived: !softClosing,
              sessionClosed: softClosing,
              directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
            },
          },
        ];
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        });
      });
      await page.goto(`/classroom/${id}`);
      const composer = page.locator('.mobile-roundtable-input');
      await composer.getByRole('textbox').fill('Could you explain this signal?');
      await composer.locator('button[type="submit"]').click();
      const discussion = page.locator('[data-mobile-toolbar] [data-toolbar-control="discussion"]');
      await expect(discussion).toBeVisible();
      await expect(discussion.getByRole('button')).toHaveCount(softClosing ? 2 : 1);
      await expect(
        page.locator('[data-mobile-toolbar] [data-toolbar-control="previous"]'),
      ).not.toBeVisible();
      await expect(
        page.locator('[data-mobile-toolbar] [data-toolbar-control="next"]'),
      ).not.toBeVisible();
      for (const size of [
        { width: 320, height: 844 },
        { width: 360, height: 844 },
        { width: 390, height: 844 },
        { width: 568, height: 320 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size);
        const buttons = await discussion.getByRole('button').all();
        const speed = (await page
          .locator('[data-mobile-toolbar] [data-toolbar-control="speed"]')
          .boundingBox())!;
        for (const button of buttons) {
          const r = (await button.boundingBox())!;
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.width).toBeLessThanOrEqual(speed.x);
          expect(r.height).toBeGreaterThanOrEqual(44);
          expect(r.width).toBeGreaterThanOrEqual(44);
          expect(
            await button.evaluate(
              (el) =>
                el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
            ),
          ).toBe(true);
        }
        if (buttons.length === 2) {
          const left = (await buttons[0].boundingBox())!;
          const right = (await buttons[1].boundingBox())!;
          expect(left.x + left.width).toBeLessThanOrEqual(right.x);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (locale === 'en-US' && softClosing && [390, 844].includes(size.width)) {
          await page.screenshot({ path: testInfo.outputPath(`discussion-${size.width}.png`) });
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.locator('[data-toolbar-control="previous"]').first()).toBeVisible();
      await expect(page.locator('[data-toolbar-control="next"]').first()).toBeVisible();
      await page.locator('[data-toolbar-control="discussion"]').getByRole('button').first().click();
      await expect(page.locator('[data-toolbar-control="discussion"]')).not.toBeVisible();
    });
  }
}
