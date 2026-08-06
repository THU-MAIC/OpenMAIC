/** Pure pass that promotes prepared interactive HTML to a first-class scene base. */
import type { CompilerScene, InteractiveHtmlMeta, InteractiveHtmlSource } from '../deps';
import { INTERACTIVE_READY_TIMEOUT_MS, INTERACTIVE_SETTLE_MS } from '../interactive-static';
import type { Diagnostic, DiagnosticCode, VideoTimelineScene } from '../ir';

export interface InteractiveResult {
  scenes: VideoTimelineScene[];
  diagnostics: Diagnostic[];
}

function failureCode(meta: InteractiveHtmlMeta | null): DiagnosticCode {
  if (!meta || meta.failure === 'missing-html') return 'missing-interactive-html';
  if (meta.failure === 'unresolved-resource') return 'unresolved-interactive-resource';
  return 'interactive-html-packaging';
}

function failureReason(meta: InteractiveHtmlMeta | null): string {
  if (!meta || meta.failure === 'missing-html') {
    return 'missing-interactive-html';
  }
  return meta.message || 'interactive-html-packaging';
}

export function applyInteractiveHtml(
  timelineScenes: readonly VideoTimelineScene[],
  sourceScenes: readonly CompilerScene[],
  source?: InteractiveHtmlSource,
): InteractiveResult {
  const diagnostics: Diagnostic[] = [];
  const scenes = timelineScenes.map((timeline, index): VideoTimelineScene => {
    const scene = sourceScenes[index];
    if (!scene || scene.type !== 'interactive') return timeline;

    const hasEmbeddedHtml =
      typeof scene.content?.html === 'string' && scene.content.html.trim() !== '';
    const meta = hasEmbeddedHtml ? (source?.html(scene) ?? null) : null;
    if (!hasEmbeddedHtml || !meta?.present || !meta.contentHash) {
      const reason = failureReason(
        hasEmbeddedHtml
          ? (meta ?? {
              id: `interactive:${scene.id}`,
              present: false,
              failure: 'packaging-failed',
              message: 'interactive-html-packaging',
            })
          : null,
      );
      diagnostics.push({
        severity: 'warn',
        code: hasEmbeddedHtml ? failureCode(meta) : 'missing-interactive-html',
        sceneId: timeline.id,
        message: reason,
      });
      return { ...timeline, base: { kind: 'placeholder', reason } };
    }

    diagnostics.push({
      severity: 'info',
      code: 'interactive-static-html',
      sceneId: timeline.id,
      message: 'interactive-static-html',
    });
    return {
      ...timeline,
      supported: true,
      base: {
        kind: 'interactive-html',
        assetId: meta.id,
        contentHash: meta.contentHash,
        readyTimeoutMs: INTERACTIVE_READY_TIMEOUT_MS,
        settleMs: INTERACTIVE_SETTLE_MS,
      },
    };
  });

  return { scenes, diagnostics };
}
