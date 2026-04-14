import { useStageStore } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { ActionEngine } from '@/lib/action/engine';
import type { Action } from '@/lib/types/action';
import type { PPTElement } from '@/lib/types/slides';
import type { Stage, Scene } from '@/lib/types/stage';

interface InitialState {
  stage: Stage | null;
  scenes: Scene[];
  currentSceneId: string | null;
  whiteboardElements?: PPTElement[];
}

/**
 * Manages headless Zustand stores + ActionEngine for eval.
 *
 * Zustand stores are singletons (module-level). We reset them
 * for each scenario via setState(). ActionEngine reads/writes
 * these same stores — no simulation drift.
 */
export class EvalStateManager {
  private actionEngine: ActionEngine;

  constructor(initial: InitialState) {
    // Reset stores to clean state
    useCanvasStore.setState({
      whiteboardOpen: false,
      whiteboardClearing: false,
    });
    useWhiteboardHistoryStore.setState({ snapshots: [] });

    // Build stage with optional pre-existing whiteboard elements
    const now = Date.now();
    const stage: Stage = initial.stage ?? {
      id: 'eval-stage',
      name: 'Eval Stage',
      languageDirective: 'en-US',
      createdAt: now,
      updatedAt: now,
    };

    // If pre-existing whiteboard elements provided, seed the whiteboard
    if (initial.whiteboardElements && initial.whiteboardElements.length > 0) {
      stage.whiteboard = [
        {
          id: 'eval-whiteboard',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: initial.whiteboardElements,
          background: { type: 'solid', color: '#ffffff' },
          animations: [],
        },
      ];
    }

    useStageStore.setState({
      stage,
      scenes: initial.scenes,
      currentSceneId: initial.currentSceneId,
      mode: 'autonomous',
    });

    // ActionEngine takes the store module as its StageStore argument
    this.actionEngine = new ActionEngine(useStageStore);
  }

  async executeAction(action: Action): Promise<void> {
    await this.actionEngine.execute(action);
  }

  getStoreState(): {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    mode: string;
    whiteboardOpen: boolean;
  } {
    const s = useStageStore.getState();
    return {
      stage: s.stage,
      scenes: s.scenes,
      currentSceneId: s.currentSceneId,
      mode: s.mode,
      whiteboardOpen: useCanvasStore.getState().whiteboardOpen,
    };
  }

  getWhiteboardElements(): PPTElement[] {
    const stage = useStageStore.getState().stage;
    if (!stage?.whiteboard || stage.whiteboard.length === 0) return [];
    const lastWb = stage.whiteboard[stage.whiteboard.length - 1];
    return lastWb.elements ?? [];
  }

  dispose(): void {
    this.actionEngine.dispose();
  }
}
