import type { SceneOutline } from '@/lib/types/generation';
import type { PPTVideoElement } from '@/lib/types/slides';
import type { Stage, VideoManifest, VideoManifestEntry } from '@/lib/types/stage';

function isGeneratedVideoRef(value: string): boolean {
  return /^gen_vid_[\w-]+$/i.test(value);
}

export function buildVideoManifestFromOutlines(outlines: SceneOutline[]): VideoManifest {
  const manifest: VideoManifest = {};

  for (const outline of outlines) {
    for (const request of outline.mediaGenerations ?? []) {
      if (request.type !== 'video') continue;
      manifest[request.elementId] = {
        type: 'video',
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
      };
    }
  }

  return manifest;
}

export function getVideoMediaRefForElement(element: PPTVideoElement): string | undefined {
  if (element.mediaRef) return element.mediaRef;
  if (element.src && isGeneratedVideoRef(element.src)) return element.src;
  return undefined;
}

export function resolveVideoManifestEntry(
  stage: Stage | null | undefined,
  element: PPTVideoElement,
): VideoManifestEntry | undefined {
  const mediaRef = getVideoMediaRefForElement(element);
  if (!mediaRef) return undefined;
  return stage?.videoManifest?.[mediaRef];
}
