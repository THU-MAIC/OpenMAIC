'use client';

/**
 * A chip outside the input: the composer's token as a sent message shows it, on
 * the same class and icons as the node ProseMirror draws (`composer-input.css`),
 * so nothing changes when a message leaves the box.
 */
import { createElement } from 'react';

import { composerChipIconNodes, type ComposerChipIcon } from '@/lib/workbench/composer-chip-icons';
import type { ComposerChipAttrs } from '@/lib/workbench/composer-doc';
import type { InlineMention } from '@/lib/workbench/composer-mentions';
import { materialKind } from './material-kind';

const MENTION_ICONS: Record<ReturnType<typeof materialKind>, ComposerChipIcon> = {
  pdf: 'file-text',
  document: 'file-text',
  text: 'file-text',
  slides: 'slides',
  sheet: 'sheet',
  image: 'image',
  audio: 'audio',
  video: 'video',
  other: 'file',
};

/** A mention's glyph, from what it is and its file name. */
export function composerMentionIcon(mention: InlineMention): ComposerChipIcon {
  return mention.kind === 'course'
    ? 'course'
    : MENTION_ICONS[materialKind(undefined, mention.name)];
}

export function ComposerChip({
  chip,
  testId,
}: {
  readonly chip: ComposerChipAttrs;
  readonly testId?: string;
}) {
  return (
    <span
      className="composer-chip"
      data-chip={chip.kind}
      data-surface="bubble"
      data-plain={chip.text}
      data-testid={testId}
      title={chip.label}
    >
      <svg
        className="composer-chip-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {composerChipIconNodes(chip.icon).map(([tag, attrs], index) =>
          createElement(tag, { ...attrs, key: index }),
        )}
      </svg>
      <span className="composer-chip-label">{chip.label}</span>
    </span>
  );
}
