/**
 * Largest box of the given aspect ratio that fits inside a container.
 * Used to keep 16:9 classroom canvases filled (no empty strip on one side)
 * when the host is a workbench panel or any non-16:9 studio frame.
 */
/** 16:9 as wide as the host. Taller than the host is clipped by the caller. */
export function fillWidthBox(
  containerWidth: number,
  ratio: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(ratio) ||
    containerWidth <= 0 ||
    ratio <= 0
  ) {
    return { width: 0, height: 0 };
  }
  return { width: containerWidth, height: containerWidth / ratio };
}

export function containBox(
  containerWidth: number,
  containerHeight: number,
  ratio: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(containerWidth) ||
    !Number.isFinite(containerHeight) ||
    !Number.isFinite(ratio) ||
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    ratio <= 0
  ) {
    return { width: 0, height: 0 };
  }
  if (containerWidth / containerHeight > ratio) {
    return { width: containerHeight * ratio, height: containerHeight };
  }
  return { width: containerWidth, height: containerWidth / ratio };
}

export const CLASSROOM_ASPECT_RATIO = 16 / 9;

/** Conversation column never shrinks below this in a side-by-side host. */
export const WORKBENCH_CHAT_MIN_PX = 400;
/** Classroom panel never shrinks below this while side-by-side. */
export const WORKBENCH_PANEL_MIN_PX = 560;

const PANEL_HEADER_PX = 48;
const STAGE_PAD_PX = 24;
const RAIL_PX = 72;
const EDIT_TOP_PX = 52;
/** Playback header + roundtable, when the hosted classroom is not in Pro. */
const PLAYBACK_CHROME_PX = 80 + 168;

/**
 * Workbench classroom width from the 16:9 stage, not a fraction of the
 * window. Extra ultrawide space goes to the conversation (Kimi / Cursor
 * split: the preview pane is as wide as its artifact, the chat grows).
 */
export function clampWorkbenchPanelWidth(hostWidth: number, desired: number): number {
  if (hostWidth <= 0) return 0;
  const max = Math.max(WORKBENCH_PANEL_MIN_PX, hostWidth - WORKBENCH_CHAT_MIN_PX);
  return Math.round(Math.max(WORKBENCH_PANEL_MIN_PX, Math.min(desired, max)));
}

export function idealWorkbenchPanelWidth(
  hostWidth: number,
  hostHeight: number,
  opts?: { readonly playback?: boolean },
): number {
  if (hostWidth <= 0 || hostHeight <= 0) return 0;
  const topChrome = opts?.playback ? PLAYBACK_CHROME_PX : EDIT_TOP_PX;
  const usableH = Math.max(1, hostHeight - PANEL_HEADER_PX - topChrome - STAGE_PAD_PX);
  const canvasW = usableH * CLASSROOM_ASPECT_RATIO;
  const ideal = canvasW + RAIL_PX + STAGE_PAD_PX;
  const max = Math.max(WORKBENCH_PANEL_MIN_PX, hostWidth - WORKBENCH_CHAT_MIN_PX);
  return Math.round(Math.max(WORKBENCH_PANEL_MIN_PX, Math.min(ideal, max)));
}
