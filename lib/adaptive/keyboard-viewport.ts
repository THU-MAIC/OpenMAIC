/** Keyboard estimate scoped to the current viewport width, so rotation resets the baseline. */
export interface KeyboardViewportState {
  width: number;
  height: number;
  keyboardOpen: boolean;
}

export function keyboardViewportState(
  previous: KeyboardViewportState | null,
  viewport: { width: number; height: number; scale: number },
): KeyboardViewportState {
  if (viewport.scale !== 1) {
    return { ...(previous ?? viewport), keyboardOpen: false };
  }
  const height =
    previous?.width === viewport.width
      ? Math.max(previous.height, viewport.height)
      : viewport.height;
  return { width: viewport.width, height, keyboardOpen: viewport.height < height * 0.78 };
}
