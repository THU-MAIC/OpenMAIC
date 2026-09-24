import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  buildAgent: vi.fn(),
  persistenceProvider: vi.fn(),
  streamLLM: vi.fn(),
  resolveModel: vi.fn(),
  legacyChildPrompts: [] as string[],
  nativeChildPrompts: [] as string[],
  directorPrompts: [] as string[],
  callAgentExecutions: 0,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.persistenceProvider,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...actual, isProviderKeyRequired: () => false };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeBody() {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Explain the selected fact.' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Lesson', whiteboard: [] },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          title: 'Grounded slide',
          order: 0,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'text-1',
                  type: 'text',
                  content: '<p>Evaporation removes heat.</p>',
                  defaultFontName: 'Arial',
                  defaultColor: '#111111',
                  left: 10,
                  top: 20,
                  width: 180,
                  height: 40,
                  rotate: 0,
                },
              ],
            },
          },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['teacher-1'],
      agentConfigs: [
        {
          id: 'teacher-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Teach only from supplied evidence.',
          priority: 10,
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
        },
      ],
    },
    elementReference: {
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'text-1',
    },
    apiKey: '',
    model: 'test:model',
  };
}

function makeInteractiveBody() {
  const body = makeBody();
  return {
    ...body,
    messages: [
      {
        ...body.messages[0],
        parts: [
          {
            ...body.messages[0].parts[0],
            text: 'What does this slider control and what is its source default?',
          },
        ],
      },
    ],
    storeState: {
      ...body.storeState,
      scenes: [
        {
          id: 'scene-interactive',
          stageId: 'stage-1',
          title: 'Projectile simulation',
          order: 0,
          type: 'interactive',
          content: {
            type: 'interactive',
            widgetType: 'simulation',
            html: `<!doctype html><label for="angle-slider">Launch angle (degrees)</label>
              <input id="angle-slider" name="angle" type="range" min="0" max="90" step="5" value="45">
              <script>document.querySelector('#angle-slider').value = '70'</script>`,
          },
        },
      ],
      currentSceneId: 'scene-interactive',
    },
    elementReference: {
      kind: 'interactive_component',
      sceneId: 'scene-interactive',
      selector: '#angle-slider',
    },
  };
}

function installAgentShell(
  legacyAnswer: string,
  nativeAnswer = 'Native grounded answer.',
  shellOptions: { delegations?: number; failFirstLegacy?: boolean; instruction?: string } = {},
) {
  let legacyChildRuns = 0;
  mocks.buildAgent.mockImplementation((options: Record<string, unknown>) => {
    const tools = (options.tools ?? []) as Array<{
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
      ) => Promise<{
        content: unknown[];
        details?: unknown;
        isError?: boolean;
      }>;
    }>;
    const callAgent = tools.find((tool) => tool.name === 'call_agent');
    if (callAgent) {
      return {
        prompt: async (prompt: string) => {
          mocks.directorPrompts.push(prompt);
        },
        waitForIdle: async () => {
          for (let index = 0; index < (shellOptions.delegations ?? 1); index += 1) {
            mocks.callAgentExecutions += 1;
            const args = {
              agentId: 'teacher-1',
              instruction:
                shellOptions.instruction ??
                (index === 0
                  ? 'Answer from the selected element.'
                  : 'Retry from the same selected element.'),
            };
            const result = await callAgent.execute(`delegate-grounded-${index + 1}`, args);
            await (
              options.afterToolCall as ((context: Record<string, unknown>) => unknown) | undefined
            )?.({
              toolCall: { name: 'call_agent' },
              args,
              result,
              isError: result.isError === true,
            });
          }
        },
        state: { messages: [] },
      };
    }

    if (tools.length > 0) {
      let subscriber: ((event: unknown, signal: AbortSignal) => unknown) | undefined;
      const state = { messages: [] as Array<Record<string, unknown>> };
      return {
        subscribe: (handler: (event: unknown, signal: AbortSignal) => unknown) => {
          subscriber = handler;
          return () => {};
        },
        prompt: async (prompt: string) => {
          mocks.nativeChildPrompts.push(prompt);
        },
        waitForIdle: async () => {
          const signal = new AbortController().signal;
          await subscriber?.(
            {
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: nativeAnswer },
            },
            signal,
          );
          state.messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: nativeAnswer }],
            stopReason: 'stop',
          });
          await subscriber?.({ type: 'agent_end' }, signal);
        },
        abort: vi.fn(),
        state,
      };
    }

    const childRun = legacyChildRuns;
    legacyChildRuns += 1;
    let subscriber: ((event: unknown) => unknown) | undefined;
    return {
      subscribe: (handler: (event: unknown) => unknown) => {
        subscriber = handler;
        return () => {};
      },
      prompt: async (prompt: string) => {
        mocks.legacyChildPrompts.push(prompt);
      },
      waitForIdle: async () => {
        if (shellOptions.failFirstLegacy && childRun === 0) {
          throw new Error('first Legacy Child failed');
        }
        await subscriber?.({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify([{ type: 'text', content: legacyAnswer }]),
          },
        });
      },
      state: {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify([{ type: 'text', content: legacyAnswer }]),
              },
            ],
          },
        ],
      },
    };
  });
}

describe('PPT element reference Route → Director → real call_agent L2', () => {
  const piFlag = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
  const coursewareReferenceFlag = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
  const nativeFlag = 'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME';
  let originalPiFlag: string | undefined;
  let originalCoursewareReferenceFlag: string | undefined;
  let originalNativeFlag: string | undefined;

  beforeEach(() => {
    originalPiFlag = process.env[piFlag];
    originalCoursewareReferenceFlag = process.env[coursewareReferenceFlag];
    originalNativeFlag = process.env[nativeFlag];
    process.env[piFlag] = 'true';
    process.env[coursewareReferenceFlag] = 'true';
    delete process.env[nativeFlag];
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '0');
    mocks.persistenceProvider.mockReset().mockResolvedValue({ runtimeStore: {} });
    mocks.buildAgent.mockReset();
    mocks.streamLLM.mockReset();
    mocks.resolveModel.mockReset();
    mocks.legacyChildPrompts.length = 0;
    mocks.nativeChildPrompts.length = 0;
    mocks.directorPrompts.length = 0;
    mocks.callAgentExecutions = 0;
    mocks.resolveModel.mockResolvedValue({
      model: { provider: 'test', modelId: 'shared-model' },
      apiKey: '',
      providerId: 'test',
      modelInfo: { outputWindow: 1024, contextWindow: 8192 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalPiFlag === undefined) delete process.env[piFlag];
    else process.env[piFlag] = originalPiFlag;
    if (originalCoursewareReferenceFlag === undefined) delete process.env[coursewareReferenceFlag];
    else process.env[coursewareReferenceFlag] = originalCoursewareReferenceFlag;
    if (originalNativeFlag === undefined) delete process.env[nativeFlag];
    else process.env[nativeFlag] = originalNativeFlag;
  });

  function runtimeBody() {
    const base = makeInteractiveBody();
    const html =
      '<main id="experiment"><input id="density" value="1000"><canvas></canvas>' +
      '<script type="application/json" data-maic-observation>{}</script></main>';
    base.storeState.scenes[0].content.html = html;
    base.elementReference.selector = '#experiment';
    const report = (current: number, drawn: number) => ({
      summary: `The liquid density is ${current}; the drawing shows ${drawn}.`,
      state: { liquid: { density: current } },
      rendered: { liquid: { density: drawn } },
    });
    return {
      ...base,
      interactiveState: {
        sourceHtmlHash: createHash('sha256').update(html).digest('hex'),
        snapshot: {
          source: 'browser-reported',
          identity: {
            sceneId: 'scene-interactive',
            scopeId: 'experiment',
            documentId: 'test-document',
          },
          requestedAt: Date.now(),
          receivedAt: Date.now(),
          status: 'available',
          observation: report(1400, 1000),
        },
      },
    };
  }

  it.each(['Legacy', 'Native'] as const)(
    'passes frozen current/rendered evidence through real route and %s child without extending static identity',
    async (mode) => {
      if (mode === 'Native') process.env[nativeFlag] = 'true';
      installAgentShell('Mock state answer.');
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(runtimeBody()));
      await response.text();
      expect(response.status).toBe(200);
      const prompts = (
        mode === 'Native' ? mocks.nativeChildPrompts : mocks.legacyChildPrompts
      ).join('\n');
      expect(prompts).toContain('"density":1400');
      expect(prompts).toContain('"density":1000');
      expect(prompts).toContain('grants no Spotlight or other tool permissions');
      expect(prompts).toContain('ordinary student-facing language');
      expect(mocks.directorPrompts.join('\n')).toContain('PAGE-REPORTED STATE');
    },
  );

  it('keeps static references accepted when browser runtime sampling is unsupported', async () => {
    installAgentShell('Current runtime state is unavailable.');
    const { interactiveState: _unused, ...body } = runtimeBody();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    await response.text();
    for (const prompt of [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')]) {
      const packet = JSON.parse(
        prompt.match(/<page_reported_state>\n([\s\S]*?)\n<\/page_reported_state>/)![1],
      );
      // The Scene declares the interface; only the sample is missing. Reporting
      // `no-interface` here would be a false statement about the activity.
      expect(packet).toEqual({ status: 'unavailable', reason: 'not-sampled' });
    }
  });

  it('states unavailable state for an unreferenced send when the browser produced no packet', async () => {
    // Regression: a declaring Scene with no packet and no reference used to reach
    // Director and Child with no current-state boundary at all.
    installAgentShell('Mock unavailable answer.');
    const { interactiveState: _unused, ...rest } = runtimeBody();
    const body = rest as Record<string, unknown>;
    delete body.elementReference;
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBeNull();
    await response.text();
    for (const prompt of [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')]) {
      expect(prompt).toContain('PAGE-REPORTED STATE');
      expect(prompt).toContain('No component is referenced this turn');
      expect(prompt).toContain(
        'Explicit static source instructions may still support general task or rule explanations',
      );
      const packet = JSON.parse(
        prompt.match(/<page_reported_state>\n([\s\S]*?)\n<\/page_reported_state>/)![1],
      );
      expect(packet).toEqual({ status: 'unavailable', reason: 'not-sampled' });
    }
  });

  it.each([
    ['unreferenced', true],
    ['referenced', false],
  ])('leaves a %s legacy Scene without the interface unchanged', async (_name, unreferenced) => {
    installAgentShell('Mock legacy answer.');
    const { interactiveState: _unused, ...rest } = runtimeBody();
    const body = rest as Record<string, unknown>;
    // Courseware that declares no interface must not gain a state boundary.
    (body.storeState as { scenes: { content: { html: string } }[] }).scenes[0].content.html =
      '<main id="experiment">Legacy 1000</main>';
    if (unreferenced) delete body.elementReference;
    else (body.elementReference as { selector: string }).selector = '#experiment';
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    await response.text();
    const prompts = [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')];
    for (const prompt of prompts) {
      if (unreferenced) {
        expect(prompt).not.toContain('PAGE-REPORTED STATE');
      } else {
        const packet = JSON.parse(
          prompt.match(/<page_reported_state>\n([\s\S]*?)\n<\/page_reported_state>/)![1],
        );
        expect(packet).toEqual({ status: 'unavailable', reason: 'no-interface' });
      }
    }
  });

  it('drops stale runtime facts instead of using defaults or older snapshots', async () => {
    installAgentShell('Mock unknown answer.');
    const body = runtimeBody();
    body.interactiveState.snapshot.requestedAt -= 60000;
    body.interactiveState.snapshot.receivedAt -= 60000;
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    await response.text();
    expect(response.status).toBe(200);
    expect(mocks.legacyChildPrompts.join('\n')).toContain('stale-sample');
    expect(mocks.legacyChildPrompts.join('\n')).not.toContain('"density":1400');
  });

  it.each(['Legacy', 'Native'] as const)(
    'keeps component identity while attaching declared area state for %s Child',
    async (mode) => {
      if (mode === 'Native') process.env[nativeFlag] = 'true';
      installAgentShell('Mock component answer.');
      const body = runtimeBody();
      // The student picked one component; the declared scope is still the whole area.
      body.elementReference.selector = '#density';
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(body));
      await response.text();

      expect(response.status).toBe(200);
      const child = (mode === 'Native' ? mocks.nativeChildPrompts : mocks.legacyChildPrompts).join(
        '\n',
      );
      for (const prompt of [mocks.directorPrompts.join('\n'), child]) {
        // Area facts still arrive for a component reference.
        expect(prompt).toContain('"density":1400');
        // Reference identity and state scope are named separately.
        expect(prompt).toContain('referenced component "#density"');
        expect(prompt).toContain('whole declared activity area "experiment"');
        expect(prompt).toContain('Area facts are not properties of that component');
        expect(prompt).toContain('grants no Spotlight or other tool permissions');
      }
      // Static identity is untouched: the resolved component is still the picked one.
      expect(child).toContain('"id":"density"');
    },
  );

  it.each(['Legacy', 'Native'] as const)(
    'grounds an unreferenced follow-up on freshly sampled area state for %s Child',
    async (mode) => {
      if (mode === 'Native') process.env[nativeFlag] = 'true';
      installAgentShell('Mock follow-up answer.');
      const body = runtimeBody() as Record<string, unknown>;
      // The follow-up carries no reference at all, exactly like the observed failure.
      delete body.elementReference;
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(body));
      await response.text();

      expect(response.status).toBe(200);
      // Auto-sampling must not look like an accepted component reference.
      expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBeNull();
      const child = (mode === 'Native' ? mocks.nativeChildPrompts : mocks.legacyChildPrompts).join(
        '\n',
      );
      for (const prompt of [mocks.directorPrompts.join('\n'), child]) {
        expect(prompt).toContain('"density":1400');
        expect(prompt).toContain('No component is referenced this turn');
        expect(prompt).not.toContain('referenced component');
        expect(prompt).toContain('grants no Spotlight or other tool permissions');
      }
    },
  );

  it('states that current state cannot be determined when an unreferenced sample is unavailable', async () => {
    installAgentShell('Mock unknown answer.');
    const body = runtimeBody() as Record<string, unknown>;
    delete body.elementReference;
    const state = body.interactiveState as Record<string, unknown>;
    state.snapshot = {
      source: 'browser-reported',
      identity: {
        sceneId: 'scene-interactive',
        scopeId: 'experiment',
        documentId: 'test-document',
      },
      requestedAt: Date.now(),
      receivedAt: Date.now(),
      status: 'unavailable',
      reason: 'timeout',
    };
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    await response.text();

    expect(response.status).toBe(200);
    for (const prompt of [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')]) {
      expect(prompt).toContain('"reason":"timeout"');
      // No value may be supplied from defaults, history or general expectation.
      expect(prompt).not.toContain('"density":1400');
      expect(prompt).toContain(
        'neither Director nor Teacher may supply a current value, a current direction of change, or a current outcome',
      );
      expect(prompt).toContain('say the current state cannot be determined');
    }
  });

  it('keeps a valid current-Scene sample when the reference points at another Scene', async () => {
    installAgentShell('Mock cross-scene answer.');
    const body = runtimeBody();
    // The student referenced a component on an earlier Scene and then moved on.
    // The sample still describes the Scene they are on now, so it is not stale:
    // reference and area state are independent evidence items.
    body.storeState.scenes = [
      {
        id: 'scene-other',
        stageId: 'stage-1',
        title: 'Earlier activity',
        order: 0,
        type: 'interactive',
        content: {
          type: 'interactive',
          widgetType: 'simulation',
          html: '<!doctype html><input id="angle-slider" type="range" value="45">',
        },
      },
      body.storeState.scenes[0],
    ];
    body.elementReference = {
      kind: 'interactive_component',
      sceneId: 'scene-other',
      selector: '#angle-slider',
    };
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    await response.text();
    expect(response.status).toBe(200);
    const prompts = mocks.legacyChildPrompts.join('\n');
    expect(prompts).not.toContain('stale-sample');
    expect(prompts).toContain('"density":1400');
    // Both identities must stay legible once the two can disagree on Scene.
    expect(prompts).toContain('#angle-slider');
    expect(prompts).toContain('come from different Scenes');
  });

  it.each([
    ['a referenced component', true],
    ['an unreferenced send', false],
  ])('degrades oversized state to an explicit unavailable statement for %s', async (_n, refer) => {
    installAgentShell('Mock oversized answer.');
    const body = runtimeBody();
    if (!refer) delete (body as { elementReference?: unknown }).elementReference;
    // Legal content the schema accepts: `<` is allowed in a label and in a fact
    // value, and escaping it for the prompt expands one code point into six.
    const bulky = Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => [`object-${i}`, '<'.repeat(540)]),
    );
    body.interactiveState.snapshot.observation = {
      summary: 'A legal report whose escaped body would exceed the output budget.',
      state: bulky,
      rendered: bulky,
    } as never;
    // The observation stays inside the Host's 32,768-byte input cap, so this is a
    // packet the Host accepts; only the escaped assembly downstream would have
    // exceeded the output budget.
    expect(
      Buffer.byteLength(JSON.stringify(body.interactiveState.snapshot.observation), 'utf8'),
    ).toBeLessThan(32768);
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    await response.text();
    expect(response.status).toBe(200);
    const prompts = mocks.legacyChildPrompts.join('\n');
    expect(prompts).toContain('too-large');
    // Not truncated: no fragment of the oversized body survives.
    expect(prompts).not.toContain('object-17');
    // Nothing of the oversized body survives alongside the unavailable statement.
    expect(prompts).not.toContain('object-1');
    expect(prompts).toContain('the current state cannot be determined');
  });

  it.each(['Legacy', 'Native'] as const)(
    'keeps a slide reference independent of current activity state for %s Child',
    async (mode) => {
      if (mode === 'Native') process.env[nativeFlag] = 'true';
      installAgentShell('Mock mixed-scene answer.', 'Mock mixed-scene answer.');
      const activity = runtimeBody();
      const slide = makeBody();
      const body = {
        ...activity,
        storeState: {
          ...activity.storeState,
          scenes: [...slide.storeState.scenes, ...activity.storeState.scenes],
        },
        elementReference: slide.elementReference,
      };
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(body));
      const stream = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
      expect(stream).toContain('Mock mixed-scene answer.');
      const child = (mode === 'Native' ? mocks.nativeChildPrompts : mocks.legacyChildPrompts).join(
        '\n',
      );
      for (const prompt of [mocks.directorPrompts.join('\n'), child]) {
        expect(prompt).toContain('Evaporation removes heat.');
        expect(prompt).toContain('"density":1400');
        expect(prompt).toContain('come from different Scenes');
        expect(prompt).toContain('not properties of the referenced slide element');
        expect(prompt).not.toContain('No component is referenced this turn');
        expect(prompt).not.toContain('stale-sample');
        expect(prompt).toContain('grants no Spotlight or other tool permissions');
      }
      expect(child).toContain('"elementId":"text-1"');
    },
  );

  it.each(['no-interface', 'document-changed'])(
    'ignores a %s packet from a legacy Scene on an unreferenced send',
    async (reason) => {
      // The reader now lives in every pooled document, so a legacy Scene can
      // answer. An unreferenced question on it must still be byte-for-byte what
      // it was before this feature existed.
      installAgentShell('Mock legacy answer.');
      const legacyHtml = '<main id="experiment">Legacy 1000</main>';
      const body = runtimeBody();
      (body.storeState as { scenes: { content: { html: string } }[] }).scenes[0].content.html =
        legacyHtml;
      delete (body as { elementReference?: unknown }).elementReference;
      body.interactiveState = {
        sourceHtmlHash: createHash('sha256').update(legacyHtml).digest('hex'),
        snapshot: {
          source: 'browser-reported',
          identity: { sceneId: 'scene-interactive', scopeId: 'experiment', documentId: 'd' },
          requestedAt: Date.now(),
          receivedAt: Date.now(),
          status: 'unavailable',
          reason,
        },
      } as never;
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(body));
      expect(response.status).toBe(200);
      await response.text();
      for (const prompt of [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')])
        expect(prompt).not.toContain('PAGE-REPORTED STATE');
    },
  );

  it('rejects a nonexistent slide reference even with valid current activity state', async () => {
    const body = runtimeBody() as Record<string, unknown>;
    body.elementReference = { kind: 'slide_element', sceneId: 'scene-1', elementId: 'element-1' };
    const { POST } = await import('@/app/api/chat/pi/route');
    expect((await POST(makeRequest(body))).status).toBe(400);
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('keeps malformed null content on the SSE path rather than returning HTTP 500', async () => {
    installAgentShell('Mock answer.');
    const body = makeInteractiveBody() as Record<string, unknown>;
    delete body.elementReference;
    (body.storeState as { scenes: { content: unknown }[] }).scenes[0].content = null;
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.text();
  });

  it('injects no state constraints while the courseware-reference feature is disabled', async () => {
    // Regression: the Host used to add the full page-state block to an ordinary
    // question whenever the current Scene declared the interface, even with the
    // feature off and nothing to sample.
    delete process.env[coursewareReferenceFlag];
    installAgentShell('Mock ungated answer.');
    const { interactiveState: _unused, ...rest } = runtimeBody();
    const body = rest as Record<string, unknown>;
    delete body.elementReference;
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(body));
    expect(response.status).toBe(200);
    await response.text();
    for (const prompt of [mocks.directorPrompts.join('\n'), mocks.legacyChildPrompts.join('\n')]) {
      expect(prompt).not.toContain('PAGE-REPORTED STATE');
      expect(prompt).not.toContain('page_reported_state');
      expect(prompt).not.toContain('No component is referenced this turn');
    }
  });

  it.each(['dynamic-selector', 'wrong-source', 'wrong-scope', 'wrong-scene'] as const)(
    'rejects %s before any model call',
    async (kind) => {
      const body = runtimeBody();
      if (kind === 'dynamic-selector') body.elementReference.selector = '#runtime-canvas-object';
      if (kind === 'wrong-source') body.interactiveState.sourceHtmlHash = '0'.repeat(64);
      if (kind === 'wrong-scope') body.interactiveState.snapshot.identity.scopeId = 'density';
      if (kind === 'wrong-scene') body.interactiveState.snapshot.identity.sceneId = 'scene-other';
      const { POST } = await import('@/app/api/chat/pi/route');
      expect((await POST(makeRequest(body))).status).toBe(400);
      expect(mocks.resolveModel).not.toHaveBeenCalled();
    },
  );

  function whiteboardBody() {
    const base = makeBody();
    return {
      ...base,
      storeState: {
        ...base.storeState,
        stage: {
          ...base.storeState.stage,
          whiteboard: [
            {
              id: 'board',
              elements: [
                {
                  ...base.storeState.scenes[0].content.canvas.elements[0],
                  content: '<p>Whiteboard-only fact.</p>',
                },
              ],
            },
          ],
        },
      },
      elementReference: {
        kind: 'whiteboard_element',
        whiteboardId: 'board',
        elementId: 'text-1',
      },
    };
  }

  it.each(['Legacy', 'Native'] as const)(
    'passes whiteboard evidence through the real route and call_agent to %s Teacher',
    async (mode) => {
      if (mode === 'Native') process.env[nativeFlag] = 'true';
      installAgentShell('Whiteboard answer.');
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(whiteboardBody()));
      await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
      const prompts = mode === 'Native' ? mocks.nativeChildPrompts : mocks.legacyChildPrompts;
      expect(prompts.join('\n')).toContain('Whiteboard-only fact.');
      expect(prompts.join('\n')).toContain('Selected whiteboard element evidence');
      expect(mocks.directorPrompts.join('\n')).toContain('Selected whiteboard reference');
      expect(mocks.persistenceProvider).not.toHaveBeenCalled();
    },
  );

  it('resolves the request snapshot without accessing persistence even when enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    installAgentShell('Snapshot answer.');
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(whiteboardBody()));
    await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.legacyChildPrompts.join('\n')).toContain('Whiteboard-only fact.');
    expect(mocks.legacyChildPrompts.join('\n')).toContain('request_start_snapshot');
    expect(mocks.persistenceProvider).not.toHaveBeenCalled();
  });

  it.each(['wrong-board', 'runtime-id', 'extra-stageId', 'extra-source', 'flag-off'])(
    'rejects a whiteboard reference before model resolution on %s',
    async (scenario) => {
      const body = whiteboardBody();
      if (scenario === 'wrong-board') body.elementReference.whiteboardId = 'other-board';
      if (scenario === 'runtime-id')
        body.elementReference.whiteboardId = 'runtime-whiteboard:stage-1';
      if (scenario === 'extra-stageId')
        Object.assign(body.elementReference, { stageId: 'stage-1' });
      if (scenario === 'extra-source')
        Object.assign(body.elementReference, { source: 'stage_snapshot' });
      if (scenario === 'flag-off') process.env[coursewareReferenceFlag] = 'false';
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest(body));
      expect(response.status).toBe(400);
      if (scenario !== 'flag-off')
        expect(await response.json()).toMatchObject({ reason: 'whiteboard_reference_changed' });
      expect(response.headers.has('X-OpenMAIC-Element-Reference-Accepted')).toBe(false);
      expect(mocks.resolveModel).not.toHaveBeenCalled();
      expect(mocks.buildAgent).not.toHaveBeenCalled();
      expect(mocks.persistenceProvider).not.toHaveBeenCalled();
    },
  );

  it('grounds the Legacy Child through the full server orchestration chain', async () => {
    installAgentShell('Legacy grounded answer.');
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(1);
    expect(mocks.directorPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(mocks.legacyChildPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(stream).toContain('Legacy grounded answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);

  it('grounds the Native Child through the same full server orchestration chain', async () => {
    process.env[nativeFlag] = 'true';
    installAgentShell('unused legacy answer');
    const { isPiNativeChildRuntimeEnabled } = await import('@/lib/config/feature-flags');
    expect(isPiNativeChildRuntimeEnabled()).toBe(true);
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(1);
    expect(mocks.nativeChildPrompts.join('\n')).toContain('Evaporation removes heat.');
    expect(stream).toContain('Native grounded answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);

  it('keeps request-scoped evidence across a failed Legacy Child and retry', async () => {
    installAgentShell('Legacy grounded retry answer.', 'unused native answer', {
      delegations: 2,
      failFirstLegacy: true,
    });
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(2);
    expect(mocks.legacyChildPrompts).toHaveLength(2);
    expect(mocks.legacyChildPrompts[0]).toContain('Evaporation removes heat.');
    expect(mocks.legacyChildPrompts[1]).toContain('Evaporation removes heat.');
    expect(stream).toContain('Legacy grounded retry answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);

  it('shares request-scoped evidence with every Native Child delegation', async () => {
    process.env[nativeFlag] = 'true';
    installAgentShell('unused legacy answer', 'Native grounded answer.', { delegations: 2 });
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(makeRequest(makeBody()));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
    expect(mocks.callAgentExecutions).toBe(2);
    expect(mocks.nativeChildPrompts).toHaveLength(2);
    expect(mocks.nativeChildPrompts[0]).toContain('Evaporation removes heat.');
    expect(mocks.nativeChildPrompts[1]).toContain('Evaporation removes heat.');
    expect(stream).toContain('Native grounded answer.');
    expect(stream).toContain('"type":"done"');
    expect(stream).not.toContain('"type":"error"');
  }, 15_000);

  it.each([
    { runtime: 'Legacy', native: false },
    { runtime: 'Native', native: true },
  ])(
    'grounds one source-static Interactive component across repeated $runtime Child delegations',
    async ({ native }) => {
      if (native) process.env[nativeFlag] = 'true';
      const answer = 'The slider source default is 45 degrees; current runtime state is unknown.';
      installAgentShell(answer, answer, { delegations: 2 });
      const { POST } = await import('@/app/api/chat/pi/route');

      const response = await POST(makeRequest(makeInteractiveBody()));
      const stream = await response.text();
      const childPrompts = native ? mocks.nativeChildPrompts : mocks.legacyChildPrompts;

      expect(response.status).toBe(200);
      expect(response.headers.get('X-OpenMAIC-Element-Reference-Accepted')).toBe('1');
      expect(mocks.callAgentExecutions).toBe(2);
      expect(mocks.directorPrompts.join('\n')).toContain('Launch angle (degrees)');
      expect(mocks.directorPrompts.join('\n')).toContain('45');
      expect(mocks.directorPrompts.join('\n')).not.toContain("value = '70'");
      expect(childPrompts).toHaveLength(2);
      for (const prompt of childPrompts) {
        expect(prompt).toContain('"selector":"#angle-slider"');
        expect(prompt).toContain('{"name":"value","value":"45"}');
        expect(prompt).not.toContain("value = '70'");
      }
      expect(stream).toContain('source default is 45 degrees');
      expect(stream).toContain('"type":"done"');
      expect(stream).not.toContain('"type":"error"');
    },
    15_000,
  );

  it('routes Chart series values through the Director summary and real Child evidence', async () => {
    installAgentShell('The values decrease from 180 to 88.');
    const { POST } = await import('@/app/api/chat/pi/route');
    const chart = {
      id: 'chart-1',
      type: 'chart',
      chartType: 'line',
      data: {
        labels: ['第1次', '第2次', '第3次', '第4次'],
        legends: ['测量值'],
        series: [[180, 145, 112, 88]],
      },
      themeColors: ['#7c3aed'],
      left: 10,
      top: 20,
      width: 640,
      height: 320,
      rotate: 0,
    };
    const body = makeBody();
    body.messages[0].parts[0].text = 'What are the four values and the overall trend?';
    body.storeState.scenes[0].content.canvas.elements[0] = chart as never;
    body.elementReference.elementId = chart.id;

    const response = await POST(makeRequest(body));
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.callAgentExecutions).toBe(1);
    expect(mocks.directorPrompts.join('\n')).toContain('180');
    expect(mocks.directorPrompts.join('\n')).toContain('88');
    expect(mocks.legacyChildPrompts.join('\n')).toContain('"series":[[180,145,112,88]]');
    expect(stream).toContain('The values decrease from 180 to 88.');
  }, 15_000);
});
