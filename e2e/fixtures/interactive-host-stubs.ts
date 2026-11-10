/**
 * Stand-ins for what `InteractiveIframeHost` reads besides geometry: editor
 * picking, element references and translations. A spec aliases these modules
 * here so it can mount the real placeholder, keep-alive pool and host without
 * the classroom around them. Values are stable so the host's effects run once.
 */
const canvasState = { pickTarget: null, setPickTarget() {} };
export const useCanvasStore = Object.assign(() => canvasState, {
  use: { pickTarget: () => null },
  getState: () => canvasState,
});

const NO_REFS: readonly never[] = [];
const refsState = { ownerSessionId: null, toggle() {} };
export const useElementRefsStore = Object.assign(() => refsState, {
  use: { refs: () => NO_REFS },
  getState: () => refsState,
});

const t = (key: string) => key;
export const useI18n = () => ({ t });
