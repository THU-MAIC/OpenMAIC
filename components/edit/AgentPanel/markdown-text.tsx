'use client';

/**
 * Assistant text renderer — Streamdown via the official assistant-ui bridge.
 *
 * Used for its streaming-first RENDERING only: incomplete-markdown repair (no
 * mid-stream flicker on unclosed bold/links), memoized block rendering, and
 * Shiki code blocks. Deliberately NO library entrance animation and NO caret —
 * the tasteful mainstream streaming feel (Claude-style) is a steady, even
 * character reveal, which `smooth` (useSmooth interpolation over bursty SSE
 * deltas) provides on its own.
 */
import 'streamdown/styles.css';
import { StreamdownTextPrimitive } from '@assistant-ui/react-streamdown';
import { code } from '@streamdown/code';

export function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      className="text-[13.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]"
      smooth={{ maxCharIntervalMs: 18, drainMs: 320 }}
      plugins={{ code }}
    />
  );
}
