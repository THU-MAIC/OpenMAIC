import type { Page, Route } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { seedServerDocument, uniqueStageId } from './server-seed';
import { createMockScene } from './test-data/generated-scene';
import {
  createModelSettingsView,
  DEFAULT_MODEL_SETTINGS,
  type ModelSettingsOptions,
} from './test-data/model-settings';

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /**
   * Answer the workspace model settings (`/api/model-config`): the view the
   * app reads, and a PUT that sets the course model (the toolbar picker). The
   * one-time import of browser settings finds nothing to do (404).
   */
  async mockModelSettings(options: ModelSettingsOptions = DEFAULT_MODEL_SETTINGS) {
    let current = { ...options };
    await this.page.route('**/api/model-config/import', (route) =>
      route.fulfill({ status: 404, body: 'Not found' }),
    );
    await this.page.route('**/api/model-config', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as {
          change?: { kind?: string; set?: Record<string, unknown> };
        };
        const llm = body.change?.kind === 'slots' ? body.change.set?.llm : undefined;
        if (typeof llm === 'string') current = { ...current, llm };
      }
      await route.fulfill({ json: createModelSettingsView(current) });
    });
  }

  /**
   * A scripted server-side generation run behind `/api/generation-runs/**`
   * (see {@link MockGenerationRun}).
   */
  async mockGenerationRun(options: MockRunOptions = {}): Promise<MockGenerationRun> {
    const run = new MockGenerationRun(this.page, options);
    await run.install();
    return run;
  }

  /**
   * The owner's material library (`/api/materials/**`) and the material
   * policy: an upload answers `extracting`, and a material is `ready` after
   * `pollsUntilReady` reads (or `failed` with `failWith`).
   */
  async mockMaterials(options: { pollsUntilReady?: number; failWith?: string } = {}) {
    const materials = new Map<
      string,
      { name: string; mime: string; bytes: number; polls: number }
    >();
    const deleted: string[] = [];
    const view = (id: string) => {
      const material = materials.get(id)!;
      const settled = material.polls >= (options.pollsUntilReady ?? 2);
      return {
        materialId: id,
        originalName: material.name,
        bytes: material.bytes,
        mime: material.mime,
        mediaKind: 'document',
        extraction: !settled
          ? { status: 'extracting' }
          : options.failWith
            ? { status: 'failed', error: options.failWith, errorCode: 'EXTRACTION_FAILED' }
            : { status: 'ready', textChars: 1200, pageCount: 3, imageCount: 0 },
      };
    };
    await this.page.route('**/api/generate-classroom/capabilities', (route) =>
      route.fulfill({
        json: {
          success: true,
          materials: {
            formats: [
              { mime: 'text/plain', extensions: ['.txt'] },
              { mime: 'application/pdf', extensions: ['.pdf'] },
            ],
            maxCount: 5,
            maxTotalBytes: 150 * 1024 * 1024,
            maxDocumentBytes: 50 * 1024 * 1024,
            maxMediaBytes: 200 * 1024 * 1024,
          },
        },
      }),
    );
    await this.page.route('**/api/materials**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/materials' && request.method() === 'POST') {
        const id = `mat_${Array.from({ length: 26 }, () => 'abcdefghjkmnpqrstvwxyz0123456789'[Math.floor(Math.random() * 32)]).join('')}`;
        materials.set(id, {
          name: decodeURIComponent(request.headers()['x-material-filename'] ?? 'file'),
          mime: request.headers()['content-type'] ?? 'application/octet-stream',
          bytes: request.postDataBuffer()?.byteLength ?? 0,
          polls: 0,
        });
        return route.fulfill({ status: 201, json: view(id) });
      }
      const id = path.split('/')[3] ?? '';
      if (!materials.has(id)) return route.fulfill({ status: 404, body: 'Not found' });
      if (request.method() === 'DELETE') {
        materials.delete(id);
        deleted.push(id);
        return route.fulfill({ json: { materialId: id, deleted: true } });
      }
      materials.get(id)!.polls += 1;
      return route.fulfill({ json: { material: view(id) } });
    });
    return { materials, deleted };
  }

  /** Set up API mocks for the generation flow. Note: model settings are already mocked by the base fixture. */
  async setupGenerationMocks(options: MockRunOptions = {}) {
    return this.mockGenerationRun(options);
  }
}

type RunEventFrame = { seq: number; type: string; data: Record<string, unknown> };

export interface MockRunOptions {
  outlines?: typeof mockOutlines;
  /** The first scene fails after confirmation: the run pauses until Retry. */
  failFirstScene?: boolean;
  /** The owner is at the limit on active runs: a start is refused. */
  atRunLimit?: boolean;
  /** How long the run takes between its scripted steps (ms). */
  stepMs?: number;
}

/** The body of the start request a run was created from. */
export type MockRunInput = Record<string, unknown>;

/**
 * A run as the server keeps it, scripted: starting it streams the outline
 * item by item after the page attached and waits for confirmation;
 * confirming (checked against the outline revision, idempotent by
 * `commandId`) writes the first scene's course (produced by the run, so the
 * classroom follows it), then the second scene while the classroom is open,
 * then completes. The event stream answers from its cursor (`after` /
 * `Last-Event-ID`) and the owner list and stream show the run while it is
 * active.
 */
export class MockGenerationRun {
  readonly id = `run-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  readonly stageId = uniqueStageId('e2e-run');
  started = false;
  confirmations: Array<Record<string, unknown>> = [];
  retries: Array<Record<string, unknown>> = [];
  private readonly answered = new Map<string, { status: number; body: unknown }>();
  private events: RunEventFrame[] = [];
  private state = 'preparing';
  private step: string | null = null;
  private outline: Record<string, unknown> | null = null;
  private revision = 0;
  private courseStageId: string | null = null;
  private scenesDone = 0;
  private error: Record<string, unknown> | null = null;
  input: MockRunInput = {};
  private readonly outlines: typeof mockOutlines;
  private readonly stepMs: number;

  constructor(
    private readonly page: Page,
    private readonly options: MockRunOptions = {},
  ) {
    this.outlines = options.outlines ?? mockOutlines;
    this.stepMs = options.stepMs ?? 150;
  }

  private push(type: string, data: Record<string, unknown> = {}) {
    this.events.push({ seq: this.events.length + 1, type, data });
    if (type === 'state') {
      this.state = data.state as string;
      this.step = (data.step as string | null) ?? null;
    }
    if (type === 'step_started') this.step = data.step as string;
  }

  private later(steps: Array<() => void | Promise<void>>) {
    void (async () => {
      for (const step of steps) {
        await new Promise((resolve) => setTimeout(resolve, this.stepMs));
        // The test is over: its run stops with it.
        if (this.page.isClosed()) return;
        try {
          await step();
        } catch (error) {
          if (this.page.isClosed()) return;
          throw error;
        }
      }
    })().catch((error) => {
      console.error('Scripted run step failed:', error);
    });
  }

  /** Move the outline to a new revision, as an edit confirmed in another tab would. */
  confirmElsewhere() {
    this.revision += 1;
    this.push('outline_confirmed', { revision: this.revision, edited: true });
    this.push('state', { state: 'generating', step: null });
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      step: this.step,
      seq: this.events.length,
      input: this.input,
      outline: this.outline ? { ...this.outline, revision: this.revision } : null,
      agents: null,
      stageId: this.courseStageId,
      progress: {
        scenesTotal: this.outline ? this.outlines.length : 0,
        scenesCompleted: this.scenesDone,
      },
      error: this.error,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      media: {},
    };
  }

  private active() {
    return this.started && this.state !== 'completed' && this.state !== 'ended';
  }

  async install() {
    await this.attach(this.page);
  }

  /** Serve this run to another page too (a second tab of the same owner). */
  async attach(page: Page) {
    await page.route('**/api/generation-runs**', (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const sse = (body: string) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        body,
      });
    const limits = { maxActive: 2, maxWaiting: 10 };

    if (path === '/api/generation-runs' && method === 'POST') {
      if (this.options.atRunLimit) {
        return json(
          {
            success: false,
            errorCode: 'ACTIVE_RUN_LIMIT',
            error: 'At most 2 courses may be generated at once',
          },
          429,
        );
      }
      this.input = {
        outlineReview: 'wait',
        ...(request.postDataJSON() as Record<string, unknown>),
      };
      this.started = true;
      this.push('state', { state: 'preparing', step: null });
      // The outline streams after the page attached, item by item.
      this.later([
        () => {
          this.push('state', { state: 'outlining', step: 'outline' });
          this.push('step_started', { step: 'outline' });
        },
        ...this.outlines.map((outline, index) => () => {
          this.push('outline_item', { index, outline });
        }),
        () => {
          this.revision = 1;
          this.outline = {
            outlines: this.outlines,
            languageDirective: 'Use Chinese for the generated course.',
            courseTitle: 'Mock Course',
            taskEngineMode: false,
          };
          this.push('step_completed', { step: 'outline' });
          this.push('outline_ready', { revision: 1, outline: { ...this.outline, revision: 1 } });
          if (this.input.outlineReview === 'auto') {
            // The run confirms its own outline, in the same commit.
            this.push('outline_confirmed', { revision: 1, edited: false, automatic: true });
            this.generate();
          } else {
            this.push('state', { state: 'awaiting_outline_confirmation', step: null });
          }
        },
      ]);
      return json({ success: true, run: this.snapshot() }, 202);
    }
    if (path === '/api/generation-runs' && method === 'GET') {
      return json({ success: true, runs: this.active() ? [this.snapshot()] : [], limits });
    }
    if (path === '/api/generation-runs/events') {
      const frame = `event: runs\ndata: ${JSON.stringify({ type: 'runs', runs: this.active() ? [this.snapshot()] : [] })}\n\n`;
      return sse(`retry: 1000\n${frame}`);
    }
    if (
      path !== `/api/generation-runs/${this.id}` &&
      !path.startsWith(`/api/generation-runs/${this.id}/`)
    ) {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
    if (path.endsWith('/events')) {
      const cursor = Number(
        request.headers()['last-event-id'] ?? url.searchParams.get('after') ?? 0,
      );
      const frames = this.events
        .filter((event) => event.seq > cursor)
        .map(
          (event) =>
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: this.id, ts: 0, ...event })}\n\n`,
        )
        .join('');
      const caughtUp = `event: caught_up\ndata: ${JSON.stringify({ type: 'caught_up', seq: this.events.length })}\n\n`;
      return sse(`retry: 200\n${frames}${caughtUp}`);
    }
    if (method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      const commandId = String(body.commandId ?? '');
      const repeated = this.answered.get(commandId);
      if (repeated) return json(repeated.body, repeated.status);
      const answer = path.endsWith('/confirm-outline')
        ? await this.confirm(body)
        : path.endsWith('/retry')
          ? this.retry(body)
          : { status: 404, body: 'Not found' };
      this.answered.set(commandId, answer);
      return json(answer.body, answer.status);
    }
    if (method === 'GET') return json({ success: true, run: this.snapshot() });
    return route.fulfill({ status: 404, body: 'Not found' });
  }

  private conflict(message: string) {
    return {
      status: 409,
      body: { success: false, errorCode: 'RUN_STATE_CONFLICT', error: message },
    };
  }

  private async confirm(body: Record<string, unknown>) {
    this.confirmations.push(body);
    if (this.state !== 'awaiting_outline_confirmation') {
      return this.conflict(`The run is ${this.state}, not waiting for its outline`);
    }
    if (body.outlineRevision !== this.revision) {
      return this.conflict(`The outline is at revision ${this.revision}`);
    }
    const outlines = (body.outlines as typeof mockOutlines | undefined) ?? this.outlines;
    if (body.outlines) this.revision += 1;
    this.outline = { ...this.outline!, outlines };
    this.push('outline_confirmed', { revision: this.revision, edited: !!body.outlines });
    this.generate();
    return {
      status: 200,
      body: {
        success: true,
        state: this.state,
        seq: this.events.length,
        outlineRevision: this.revision,
      },
    };
  }

  /** The confirmed outline goes on to the scenes. */
  private generate() {
    this.push('state', { state: 'generating', step: null });
    this.push('step_started', { step: 'scene:0:content' });
    if (this.options.failFirstScene) {
      this.later([() => this.pause('scene:0:content')]);
    } else {
      this.later(this.sceneSteps());
    }
  }

  private pause(step: string) {
    this.error = {
      step,
      message: 'injected',
      errorCode: 'UPSTREAM_ERROR',
      statusCode: 503,
      failureSeq: this.events.length + 1,
    };
    this.push('step_failed', {
      step,
      message: 'injected',
      errorCode: 'UPSTREAM_ERROR',
      statusCode: 503,
    });
    this.push('state', { state: 'paused', step });
  }

  private retry(body: Record<string, unknown>) {
    this.retries.push(body);
    if (this.state !== 'paused') return this.conflict(`The run is ${this.state}, not paused`);
    this.error = null;
    this.push('state', { state: 'generating', step: this.step });
    this.later([
      () => this.push('step_started', { step: 'scene:0:content' }),
      ...this.sceneSteps(),
    ]);
    return { status: 200, body: { success: true, state: this.state, seq: this.events.length } };
  }

  /** The first scene's course, then the second scene while the classroom is open, then completion. */
  private sceneSteps(): Array<() => Promise<void> | void> {
    return [
      async () => {
        await this.storeCourse(1);
        this.push('course_created', { stageId: this.stageId });
        this.push('scene_ready', { index: 0, sceneId: 'scene-0', order: 0 });
      },
      // Long enough for the classroom to mount while the run still generates.
      () => new Promise((resolve) => setTimeout(resolve, 1_500)),
      async () => {
        this.push('step_started', { step: 'scene:1:content' });
        await this.storeCourse(2);
        this.push('scene_ready', { index: 1, sceneId: 'scene-1', order: 1 });
      },
      () => new Promise((resolve) => setTimeout(resolve, 500)),
      () => {
        this.push('completed', { stageId: this.stageId });
        this.push('state', { state: 'completed', step: null });
      },
    ];
  }

  /** The course as the run writes it: produced by the run, growing scene by scene. */
  private async storeCourse(sceneCount: number) {
    const scene = createMockScene(this.stageId);
    const scenes = Array.from({ length: sceneCount }, (_, index) => ({
      ...scene,
      id: `scene-${index}`,
      order: index,
      title: index === 0 ? scene.title : `${scene.title} (${index + 1})`,
    }));
    await seedServerDocument(this.page, {
      stage: {
        id: this.stageId,
        name: 'Mock Course',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      scenes,
      outline: {
        outlines: this.outline?.outlines ?? this.outlines,
        generationComplete: false,
        producer: 'server-job',
        producerRef: this.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    this.courseStageId = this.stageId;
    this.scenesDone = sceneCount;
  }
}
