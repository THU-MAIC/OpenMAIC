/**
 * The classroom side of a course a generation run produces, framework-free:
 * how scenes read from the server join the classroom's, and the reads that
 * keep them current (`useRunCourse` is the React face).
 */
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

import { isFinishedRunState, type RunView } from './types';
import type { RunFollowStatus } from './follower';

export interface CourseScenesState {
  scenes: Scene[];
  outlines: SceneOutline[];
  currentSceneId: string | null;
  generationComplete: boolean;
}

/**
 * Scenes read from the server joined to the classroom's, by id, in order. A
 * scene this browser has changed and not saved yet is kept as it is (the
 * learner's change is written once the run completes). A classroom waiting on
 * the generating page moves to the first scene that arrived, as it did when the
 * browser added scenes itself. Null when nothing changes.
 */
export function mergeServerScenes(
  state: CourseScenesState,
  fetched: readonly Scene[],
  stageId: string,
  locallyChanged: (sceneId: string) => boolean,
):
  | (Pick<CourseScenesState, 'scenes' | 'currentSceneId'> & {
      generatingOutlines: SceneOutline[];
    })
  | null {
  const fresh = fetched.filter((scene) => scene.stageId === stageId && !locallyChanged(scene.id));
  if (fresh.length === 0) return null;
  const known = new Set(state.scenes.map((scene) => scene.id));
  const byId = new Map(state.scenes.map((scene) => [scene.id, scene]));
  for (const scene of fresh) byId.set(scene.id, scene);
  const scenes = [...byId.values()].sort((a, b) => a.order - b.order);
  const orders = new Set(scenes.map((scene) => scene.order));
  const arrived = fresh.filter((scene) => !known.has(scene.id)).sort((a, b) => a.order - b.order);
  let currentSceneId = state.currentSceneId;
  if (currentSceneId === PENDING_SCENE_ID && arrived.length > 0) currentSceneId = arrived[0]!.id;
  if (currentSceneId === null) currentSceneId = scenes[0]?.id ?? null;
  return {
    scenes,
    currentSceneId,
    generatingOutlines: state.generationComplete
      ? []
      : state.outlines.filter((outline) => !orders.has(outline.order)),
  };
}

/**
 * Whether the course is read-only here: while its run is not over, and while
 * whether it is over is not known (the run is being read, or cannot be read
 * now). A finished run lifts it once the classroom holds the run's last writes.
 */
export function courseFenced(input: {
  runId: string | null;
  status: RunFollowStatus;
  view: Pick<RunView, 'state'> | null;
  reconciled: boolean;
}): boolean {
  if (!input.runId || input.status === 'missing') return false;
  if (!input.view) return true;
  return !(isFinishedRunState(input.view.state) && input.reconciled);
}

export type ManifestRead =
  | { status: 'ok'; manifest: { scenes: Array<{ id: string }> } }
  | { status: 'missing' }
  | { status: 'transient' };

export interface SceneSyncDeps {
  fetchManifest: (stageId: string) => Promise<ManifestRead>;
  /** The scenes read (a scene that could not be read is left out). */
  fetchScenes: (stageId: string, ids: readonly string[]) => Promise<Scene[]>;
  knownSceneIds: () => string[];
  apply: (scenes: Scene[]) => void;
  onWarn?: (message: string, error: unknown) => void;
  retryBaseMs?: number;
}

const MAX_RETRY_MS = 30_000;
/** Passes whose manifest read but whose scenes did not, before the final reconciliation gives up. */
const MAX_UNREADABLE_PASSES = 5;

/**
 * Reads the scenes the run appended or changed. A scene id stays wanted until
 * it is read (a failed read is tried again with a backoff), and reads never
 * overlap.
 */
export class RunCourseSceneSync {
  private readonly wanted = new Set<string>();
  private running: Promise<boolean> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private closed = false;
  /** Whether the last pass read the manifest (its scenes may still have failed). */
  private manifestRead = false;

  constructor(
    private readonly stageId: string,
    private readonly deps: SceneSyncDeps,
  ) {}

  /** Read these scenes again at the next sync. */
  markChanged(ids: Iterable<string>): void {
    for (const id of ids) this.wanted.add(id);
  }

  /** Read what is new or changed; true when every wanted scene was read. */
  sync(): Promise<boolean> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let ok = true;
      do {
        this.again = false;
        ok = await this.pass();
      } while (this.again && ok && !this.closed);
      return ok;
    })().finally(() => {
      this.running = null;
    });
    void this.running.then((ok) => {
      if (ok) {
        this.failures = 0;
        return;
      }
      this.failures += 1;
      this.retryLater();
    });
    return this.running;
  }

  /**
   * Read every scene again until it succeeds: the run's last writes. A scene
   * the manifest names but that never reads (after a few tries with the
   * manifest read fine) is given up on, so the course is not read-only for
   * good over it.
   */
  async reconcile(): Promise<void> {
    this.markChanged(this.deps.knownSceneIds());
    let unreadable = 0;
    while (!this.closed) {
      if (await this.sync()) return;
      if (this.manifestRead) {
        unreadable += 1;
        if (unreadable >= MAX_UNREADABLE_PASSES) {
          this.deps.onWarn?.(
            `Scenes ${[...this.wanted].join(', ')} of ${this.stageId} could not be read; going on without them`,
            null,
          );
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay()));
    }
  }

  private retryDelay(): number {
    const base = this.deps.retryBaseMs ?? 1_000;
    return Math.min(base * 2 ** Math.max(0, this.failures - 1), MAX_RETRY_MS);
  }

  private retryLater(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, this.retryDelay());
  }

  private async pass(): Promise<boolean> {
    this.manifestRead = false;
    let manifest: ManifestRead;
    try {
      manifest = await this.deps.fetchManifest(this.stageId);
    } catch (error) {
      this.deps.onWarn?.('Reading the course manifest failed', error);
      return false;
    }
    if (manifest.status === 'missing') return true;
    if (manifest.status !== 'ok') return false;
    this.manifestRead = true;
    const present = new Set(manifest.manifest.scenes.map((scene) => scene.id));
    const known = new Set(this.deps.knownSceneIds());
    // Scenes the course no longer has are not wanted any more.
    for (const id of [...this.wanted]) if (!present.has(id)) this.wanted.delete(id);
    const ids = new Set(this.wanted);
    for (const id of present) if (!known.has(id)) ids.add(id);
    if (ids.size === 0) return true;
    let scenes: Scene[];
    try {
      scenes = await this.deps.fetchScenes(this.stageId, [...ids]);
    } catch (error) {
      this.deps.onWarn?.('Reading the generated scenes failed', error);
      return false;
    }
    if (this.closed) return false;
    this.deps.apply(scenes);
    const read = new Set(scenes.map((scene) => scene.id));
    for (const id of read) this.wanted.delete(id);
    // A scene the manifest names that did not come back is read again.
    let complete = true;
    for (const id of ids) {
      if (!read.has(id)) {
        this.wanted.add(id);
        complete = false;
      }
    }
    return complete;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
