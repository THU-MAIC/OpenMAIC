/**
 * Picture node parser — handles images, video placeholders, and audio placeholders.
 */

import { SafeXmlNode } from '../../parser/XmlParser';
import { BaseNodeData, parseBaseProps } from './BaseNode';

export interface CropRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PicNodeData extends BaseNodeData {
  nodeType: 'picture';
  blipEmbed?: string;
  blipLink?: string;
  crop?: CropRect;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  fill?: SafeXmlNode;
  /** @internal Raw XML node — opaque to consumers. Use serializePresentation() for JSON-safe data. */
  line?: SafeXmlNode;
  isVideo?: boolean;
  isAudio?: boolean;
  mediaRId?: string;
}

/** OOXML encodes srcRect as 1/1000th of a percent; divide by 1000 to get percentage (0–100). */
const CROP_DIVISOR = 1000;

/**
 * Parse a picture XML node (`p:pic`) into PicNodeData.
 */
export function parsePicNode(picNode: SafeXmlNode): PicNodeData {
  const base = parseBaseProps(picNode);

  // --- Blip fill ---
  const blipFill = picNode.child('blipFill');
  const blip = blipFill.child('blip');

  // Try both namespaced and non-namespaced embed attribute
  const blipEmbed = blip.attr('embed') ?? blip.attr('r:embed');
  const blipLink = blip.attr('link') ?? blip.attr('r:link');

  // --- Crop (srcRect) ---
  const srcRect = blipFill.child('srcRect');
  let crop: CropRect | undefined;
  if (srcRect.exists()) {
    const t = srcRect.numAttr('t');
    const b = srcRect.numAttr('b');
    const l = srcRect.numAttr('l');
    const r = srcRect.numAttr('r');
    if (t !== undefined || b !== undefined || l !== undefined || r !== undefined) {
      crop = {
        top: (t ?? 0) / CROP_DIVISOR,
        bottom: (b ?? 0) / CROP_DIVISOR,
        left: (l ?? 0) / CROP_DIVISOR,
        right: (r ?? 0) / CROP_DIVISOR,
      };
    }
  }

  // --- Shape properties (fill + line) ---
  const spPr = picNode.child('spPr');
  const solidFill = spPr.child('solidFill');
  const gradFill = spPr.child('gradFill');
  const fill = solidFill.exists() ? solidFill : gradFill.exists() ? gradFill : undefined;

  const ln = spPr.child('ln');
  const line = ln.exists() ? ln : undefined;

  // --- Video / Audio detection ---
  const nvPicPr = picNode.child('nvPicPr');
  const nvPr = nvPicPr.child('nvPr');

  const videoFile = nvPr.child('videoFile');
  const audioFile = nvPr.child('audioFile');

  const isVideo = videoFile.exists();
  const isAudio = audioFile.exists();

  let mediaRId: string | undefined;
  if (isVideo) {
    mediaRId = videoFile.attr('link') ?? videoFile.attr('r:link');
  } else if (isAudio) {
    mediaRId = audioFile.attr('link') ?? audioFile.attr('r:link');
  }

  return {
    ...base,
    nodeType: 'picture',
    blipEmbed,
    blipLink,
    crop,
    fill,
    line,
    isVideo: isVideo || undefined,
    isAudio: isAudio || undefined,
    mediaRId,
  };
}
