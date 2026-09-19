export const TASK_DIVIDER_PREFIX = '[TASK_DIVIDER]';
export const MILESTONE_DIVIDER_PREFIX = '[MILESTONE_DIVIDER]';

const DIVIDER_MARKER_PATTERN = /[^\S\r\n]*(?:\[TASK_DIVIDER\]|\[MILESTONE_DIVIDER\])[^\r\n]*/g;

export function stripEmbeddedDividerMarkers(text: string): string {
  return text.replace(DIVIDER_MARKER_PATTERN, '').trim();
}

export function isStandaloneDividerMessage(content: string): boolean {
  return content.startsWith(TASK_DIVIDER_PREFIX) || content.startsWith(MILESTONE_DIVIDER_PREFIX);
}
