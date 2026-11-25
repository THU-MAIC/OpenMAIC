import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import type { Scene, Stage } from '@/lib/types/stage';
import { abortable } from './abortable';
import { prepareInteractiveScenePreview } from './scene-preview-content';

// The render service allows 5 seconds for parsing, slot wait, and Chromium work.
// Leave time for scene preparation, the HTTP round trip, and browser cleanup.
const CHECK_TIMEOUT_MS = 6_000;
const MAX_REPORTED_ERRORS = 4;
const MAX_REPORTED_CHARS = 180;

type InteractiveScene = Extract<Scene, { type: 'interactive' }>;
type StageContext = Pick<Stage, 'id' | 'name'>;
type RuntimeError = { message: string } & (
  | { phase: 'load' }
  | { phase: 'action'; actionIndex: number; actionType: string }
);

export type InteractiveRuntimeClient = (
  scene: InteractiveScene,
  stage: StageContext,
  signal: AbortSignal,
) => Promise<RuntimeError[]>;

export function createInteractiveRuntimeClient(
  ownerId: string,
): InteractiveRuntimeClient | undefined {
  const service = resolveRenderServiceUrl();
  if ('error' in service) return undefined;

  return async (scene, stage, signal) => {
    const prepared = await prepareInteractiveScenePreview(scene, { signal });
    if (!prepared.ok) throw new Error(prepared.reason);
    const response = await proxyFetch(`${service.url}/interactive-runtime-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openmaic-client': ownerId },
      body: JSON.stringify({
        version: 1,
        scene: prepared.scene,
        stage: { id: stage.id, name: stage.name },
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Runtime check returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { errors?: RuntimeError[] } | null;
    if (!Array.isArray(body?.errors)) throw new Error('Invalid runtime check response');
    return body.errors;
  };
}

/** Return a best-effort diagnostic for the authoring tool's successful write. */
export async function interactiveRuntimeFeedback(
  check: InteractiveRuntimeClient | undefined,
  scene: Scene,
  stage: StageContext,
  signal?: AbortSignal,
): Promise<string> {
  if (!check || scene.type !== 'interactive' || signal?.aborted) return '';
  const deadline = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const checkSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const errors = await abortable(check(scene, stage, checkSignal), checkSignal);
    checkSignal.throwIfAborted();
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const error of errors) {
      const message = error.message.replace(/\s+/g, ' ').trim();
      if (!message || seen.has(message)) continue;
      seen.add(message);
      const source =
        error.phase === 'load'
          ? 'load'
          : `actions[${error.actionIndex}] (${error.actionType.slice(0, 32)})`;
      const excerpt =
        message.length > MAX_REPORTED_CHARS
          ? `${message.slice(0, MAX_REPORTED_CHARS - 3)}...`
          : message;
      lines.push(`- ${source} ${JSON.stringify(excerpt)}`);
      if (lines.length >= MAX_REPORTED_ERRORS) break;
    }
    if (lines.length === 0) return '';
    return `\nInteractive page throws at runtime. Fix it with patch_stage, which checks again after the edit.\n${lines.join('\n')}`;
  } catch {
    return '\nInteractive page runtime was not checked.';
  }
}
