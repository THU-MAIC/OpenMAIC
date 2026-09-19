/**
 * Serializer layer: converts PresentationData (and render context) into
 * pptxtojson/PPTist JSON using the same resolution flow as the reference renderer.
 */

export { createRenderContext, type RenderContext } from './RenderContext';
export { renderTextBody, type RenderTextBodyOptions } from './textSerializer';
export { lineStyleToBorder, dashArrayForKind, type BorderResult } from './borderMapper';
export { slideToSlide, nodeToElement } from './slideSerializer';
export {
  resolveSlideFill,
  renderBgPr as bgPrToFill,
  renderBgRef as bgRefToFill,
} from './backgroundSerializer';
export { renderShape, shapeToElement } from './shapeSerializer';
export { pictureToElement } from './imageSerializer';
export { tableToElement } from './tableSerializer';
export { chartToElement } from './chartSerializer';
export { groupToElement, type NodeToElement } from './groupSerializer';
export type { Slide as OutputSlide } from '../adapter/types';
