/**
 * Shared narration walk for the export family.
 *
 * The script (.md/.docx) exporter and the PPTX speaker-notes exporter each
 * used to hand-roll "iterate `scene.actions`, keep `type === 'speech'`,
 * join the text" — two copies of the same domain traversal that could drift on
 * what counts as narration (issue #1142). Both now delegate here.
 *
 * The two callers genuinely differ in two knobs, both preserved explicitly:
 *
 * - `keepWhitespaceOnly` — the script exporter drops whitespace-only speech
 *   (no empty paragraphs in the document); the PPTX exporter historically kept
 *   it. Defaults to `true` so the PPTX path is unchanged.
 * - `trim` — the script exporter trims each kept part before joining; the PPTX
 *   exporter does not. Defaults to `false` so the PPTX path is unchanged.
 *
 * Defaults therefore reproduce the PPTX behaviour, and the script exporter opts
 * into its stricter behaviour at its call site.
 *
 * Unlike the script exporter's previous inline walk, a `speech` action with a
 * missing `text` field is tolerated instead of throwing (the old code called
 * `.trim()` on `undefined`). Well-typed scenes are unaffected.
 */
export interface SpeechTextOptions {
  /** Keep speech actions whose `text` is empty or whitespace-only. */
  readonly keepWhitespaceOnly?: boolean;
  /** Trim each kept speech text before joining. */
  readonly trim?: boolean;
}

/** Minimal structural shape of a speech action for the walk. */
interface SpeechLike {
  readonly type: string;
  readonly text?: string;
}

/** Minimal structural shape of a scene for the walk. */
interface SceneLike {
  readonly actions?: readonly SpeechLike[] | undefined;
}

/**
 * Concatenate a scene's speech text in playback order, one part per speech
 * action, joined with `\n`.
 *
 * Single source of truth for "what counts as narration" — see #1142.
 */
export function collectSpeechText(
  scene: SceneLike | null | undefined,
  options: SpeechTextOptions = {},
): string {
  const { keepWhitespaceOnly = true, trim = false } = options;
  const actions = scene?.actions;
  if (!actions || actions.length === 0) return '';

  const parts: string[] = [];
  for (const action of actions) {
    if (action.type !== 'speech') continue;
    const text = action.text ?? '';
    if (!keepWhitespaceOnly && !text.trim()) continue;
    parts.push(trim ? text.trim() : text);
  }
  return parts.join('\n');
}
