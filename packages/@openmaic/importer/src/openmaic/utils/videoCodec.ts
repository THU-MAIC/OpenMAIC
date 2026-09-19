/**
 * MP4 codec detection used by the PPTX import pipeline.
 *
 * STUB: returns no codec info and treats every video as supported. This
 * disables the "unsupported codec → fall back to placeholder icon" branch
 * inside `transformParsedToSlides`. The downside: an HEVC / unsupported
 * codec will produce a broken `<video>` element in the slide rather than
 * an explicit warning placeholder.
 *
 * To harden later: port the real MP4 box parser (reads `ftyp`, `moov` →
 * `trak` → `mdia` → `minf` → `stbl` → `stsd` and inspects the entry tag
 * + AVCC/HVCC config). Until then, browsers handle the failure gracefully
 * for the common H.264 / AAC case that covers the vast majority of PPTX
 * embedded media.
 */

export interface VideoCodecInfo {
  videoCodec?: string;
  audioCodec?: string;
}

export async function parseVideoCodec(_arrayBuffer: ArrayBuffer): Promise<VideoCodecInfo | null> {
  return null;
}

export function isVideoCodecSupported(_info: VideoCodecInfo | null): boolean {
  return true;
}
