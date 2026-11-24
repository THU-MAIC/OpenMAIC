import { test, expect, type Page } from '../fixtures/base';

/**
 * #2283: the asking scene after `ask_user` must follow the `user_question`
 * frame, not a later re-render. The workspace runs for real (real React,
 * real Motion — no AnimatePresence mock), and the agent session's API is
 * scripted: the create and meta reads answer at once, and the event stream
 * answers one batch per connection, so the test decides when the queued run
 * starts and when the question lands.
 *
 * Three moments are timed from the question frame:
 *   scene — the section's `data-scene` attribute flips (React committed the
 *           asking view);
 *   card  — the question card is in the DOM;
 *   form  — the answer form is in the DOM.
 * A gap between `scene` and `card` means the card waited on an animation.
 *
 * Runs only against a server started with the workbench entry on, named by
 * `E2E_WORKBENCH_BASE` (the default e2e server has the entry off):
 *   NEXT_PUBLIC_WORKBENCH_ENABLED=true OPENMAIC_AGENT_RUNTIME_ENABLED=true \
 *   DATABASE_URL=… PORT=3100 pnpm dev
 *   E2E_WORKBENCH_BASE=http://localhost:3100 pnpm exec playwright test <this file>
 * The data APIs are all routed below; nothing reaches the database.
 */
const BASE = process.env.E2E_WORKBENCH_BASE;
const SESSION_ID = 's-e2e-asking';
const STAGE_ID = 'st-e2e-asking';
const PROMPT = 'Make a course about photosynthesis';

type Frame = ReturnType<typeof frame>;

/** One durable frame, as the events route would write it on the live tail. */
const frame = (id: number, ts: number, type: string, data: Record<string, unknown>) => ({
  id,
  ts,
  attempt: 1,
  type,
  data,
  phase: 'live',
});

/** The scripted run: picked up from the queue, and the agent asks at once. */
function runAndAsk(): Frame[] {
  const t = Date.now();
  return [
    frame(1, t, 'session_start', { prompt: PROMPT }),
    frame(2, t + 300, 'message_start', { message: { role: 'assistant', content: [] } }),
    frame(3, t + 400, 'tool_execution_start', {
      toolCallId: 'ask1',
      toolName: 'ask_user',
      args: {},
    }),
    frame(4, t + 500, 'user_question', {
      question: 'Build this plan?',
      details: '1. Light and dark reactions\n2. A quiz',
      options: [
        { id: 'go', label: 'Go ahead', recommended: true },
        { id: 'change', label: 'Change it' },
      ],
    }),
    frame(5, t + 600, 'tool_execution_end', {
      toolCallId: 'ask1',
      toolName: 'ask_user',
      result: {},
    }),
    frame(6, t + 700, 'agent_end', {}),
  ];
}

/**
 * The agent session as the test scripts it. A connection answers at once
 * with whatever its cursor has not seen and a `caught_up` — as the real route
 * does for the queued session's empty backlog — or, with nothing new, is held
 * until the test releases the next batch.
 */
class ScriptedSession {
  private log: Frame[] = [];
  private gates: Array<() => void> = [];
  private created = false;
  private attached = false;
  readonly answers: Array<{ text: string; at: number }> = [];

  release(...events: Frame[]) {
    this.log.push(...events);
    const gates = this.gates;
    this.gates = [];
    for (const open of gates) open();
  }

  private unseen(cursor: number) {
    return this.log.filter((event) => event.id > cursor);
  }

  async install(page: Page) {
    const json = (body: unknown) => ({ json: body });
    await page.route('**/api/agent/skills', (route) => route.fulfill(json([])));
    await page.route('**/api/agent/sessions', (route) => {
      if (route.request().method() === 'POST') {
        this.created = true;
        return route.fulfill(
          json({ id: SESSION_ID, stageId: STAGE_ID, status: 'queued', prompt: PROMPT }),
        );
      }
      return route.fulfill(
        json(
          this.created
            ? [
                {
                  id: SESSION_ID,
                  stageId: STAGE_ID,
                  prompt: PROMPT,
                  status: 'queued',
                  existingCourse: false,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              ]
            : [],
        ),
      );
    });
    await page.route(`**/api/agent/sessions/${SESSION_ID}`, (route) =>
      route.fulfill(
        json({ prompt: PROMPT, status: 'queued', stageId: STAGE_ID, existingCourse: false }),
      ),
    );
    await page.route(`**/api/agent/sessions/${SESSION_ID}/messages`, (route) => {
      const text = String(route.request().postDataJSON()?.text ?? '');
      this.answers.push({ text, at: Date.now() });
      return route.fulfill(json({ elementRefsAccepted: true, courseRefsAccepted: true }));
    });
    await page.route(`**/api/agent/sessions/${SESSION_ID}/events**`, async (route) => {
      const url = new URL(route.request().url());
      const headerId = route.request().headers()['last-event-id'];
      const cursor = Number(headerId ?? url.searchParams.get('lastEventId') ?? 0) || 0;
      // The attach's first connection always answers: the client sits on its
      // catch-up spinner (and the preview stays away) until `caught_up`.
      const first = !this.attached;
      this.attached = true;
      if (!first && this.unseen(cursor).length === 0) {
        await new Promise<void>((open) => this.gates.push(open));
      }
      const frames = this.unseen(cursor)
        .map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
      const caughtUp = `event: caught_up\ndata: ${JSON.stringify({ type: 'caught_up' })}\n\n`;
      await route
        .fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          body: `retry: 500\n${frames}${caughtUp}`,
        })
        .catch(() => {});
    });
  }
}

/**
 * Make the page's animation frames pausable, as a hidden or fully covered
 * window pauses them (and as a Motion frameloop that died on an exception
 * stops producing them). Installed before any app script, so Motion's
 * frameloop captures the pausable function.
 */
async function installPausableFrames(page: Page) {
  await page.addInitScript(() => {
    const native = window.requestAnimationFrame.bind(window);
    const cancelNative = window.cancelAnimationFrame.bind(window);
    const queued = new Map<number, FrameRequestCallback>();
    let paused = false;
    let nextId = 1_000_000_000;
    (window as unknown as { __framesPaused: (on: boolean) => void }).__framesPaused = (on) => {
      paused = on;
      if (on) return;
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) native(callback);
    };
    window.requestAnimationFrame = (callback) => {
      if (!paused) return native(callback);
      const id = nextId++;
      queued.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!queued.delete(id)) cancelNative(id);
    };
  });
}

const pauseFrames = (page: Page, on: boolean) =>
  page.evaluate((value) => {
    (window as unknown as { __framesPaused: (on: boolean) => void }).__framesPaused(value);
  }, on);

/** What the page shows right now, for the assertions. */
async function surfaces(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="workspace-request-activity"]');
    const card = document.querySelector('[data-testid="request-preview-question"]');
    const forms = [...document.querySelectorAll('[data-testid="workbench-question-form"]')];
    const chatCard = document.querySelector('[data-testid="workbench-question-card"]');
    return {
      previewCard: card !== null,
      forms: forms.length,
      formInPreview: forms.some((form) => section?.contains(form) ?? false),
      chatPointsToPreview: chatCard?.textContent?.includes('Answer it in the preview') ?? false,
    };
  });
}

async function startQueuedRequest(page: Page) {
  await page.goto(`${BASE}/workspace`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('[data-testid="pro-launch-panel"] [data-composer-input]');
  // The first visit compiles the route in dev.
  await composer.waitFor({ state: 'visible', timeout: 90_000 });
  await composer.click();
  await page.keyboard.type(PROMPT);
  await page.locator('[data-testid="pro-launch-start"]').click();
  // The request waits in the runner queue: the preview says so, and the
  // stream, caught up on an empty log, waits with nothing to say.
  const preview = page.locator('[data-testid="workspace-request-activity"]').first();
  await expect(preview).toHaveAttribute('data-scene', 'queued', { timeout: 30_000 });
  await page.waitForTimeout(1_500); // the queue holds a moment
  // Nothing hovers the preview: a hover pauses the auto-confirm countdown.
  await page.mouse.move(1, 1);
}

async function timeline(page: Page, t0: number, budgetMs: number) {
  const at = async (selectorOrScene: string) => {
    if (selectorOrScene === 'scene') {
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="workspace-request-activity"]')
            ?.getAttribute('data-scene') === 'asking',
        undefined,
        { timeout: budgetMs },
      );
    } else {
      await page.waitForSelector(selectorOrScene, { timeout: budgetMs, state: 'attached' });
    }
    return Date.now() - t0;
  };
  const scene = await at('scene');
  const card = await at('[data-testid="request-preview-question"]');
  const form = await at('[data-testid="workbench-question-form"]');
  return { scene, card, form };
}

test.describe('the asking scene follows the question frame (#2283)', () => {
  test.skip(!BASE, 'needs a server with the workbench entry on (E2E_WORKBENCH_BASE)');
  test.setTimeout(180_000);

  test('queued at send, then the question lands: scene, card and form in step', async ({
    page,
  }) => {
    const stream = new ScriptedSession();
    await stream.install(page);
    await startQueuedRequest(page);

    stream.release(...runAndAsk());
    const t0 = Date.now();
    const { scene, card, form } = await timeline(page, t0, 15_000);

    expect(scene).toBeLessThanOrEqual(2_000);
    // The question card mounts with the scene, not after the previous card's
    // exit animation (which alone takes about 0.8 s here).
    expect(card - scene).toBeLessThanOrEqual(300);
    expect(form - card).toBeLessThanOrEqual(1_500);

    // Auto-confirm (#2271): the recommended option goes out about 8 s after
    // the question was on screen, not minutes later.
    await expect.poll(() => stream.answers.length, { timeout: 25_000 }).toBeGreaterThan(0);
    const answeredAt = stream.answers[0]!.at - t0;
    expect(answeredAt).toBeGreaterThanOrEqual(6_000);
    expect(answeredAt).toBeLessThanOrEqual(15_000);
    expect(stream.answers[0]!.text).toBe('Go ahead');
  });

  test('the same under CPU pressure (the dev-amplified shape of the lag)', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const stream = new ScriptedSession();
    await stream.install(page);
    await startQueuedRequest(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

    stream.release(...runAndAsk());
    const t0 = Date.now();
    const { scene, card, form } = await timeline(page, t0, 30_000);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    expect(scene).toBeLessThanOrEqual(5_000);
    expect(card - scene).toBeLessThanOrEqual(500);
    expect(form - card).toBeLessThanOrEqual(3_000);
  });

  test('without animation frames the answer form is still reachable', async ({ page }) => {
    await installPausableFrames(page);
    const stream = new ScriptedSession();
    await stream.install(page);
    await startQueuedRequest(page);

    // The page stops producing frames (a covered window; a Motion frameloop
    // that died), then the question lands. Timers and the network go on.
    await pauseFrames(page, true);
    stream.release(...runAndAsk());
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="workspace-request-activity"]')
          ?.getAttribute('data-scene') === 'asking',
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(3_000);
    const stalled = await surfaces(page);

    // Frames come back: whatever the screen held catches up.
    await pauseFrames(page, false);
    await page.waitForSelector('[data-testid="request-preview-question"]', { timeout: 10_000 });

    // The answer must not wait on an animation: the question card is up with
    // its form, and the chat points at the preview only while that form is there.
    expect(stalled.previewCard).toBe(true);
    expect(stalled.forms).toBeGreaterThan(0);
    if (stalled.chatPointsToPreview) expect(stalled.formInPreview).toBe(true);
  });
});
