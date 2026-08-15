const GENERATED_MEDIA_REFERENCE = /(?:^|[^A-Za-z0-9_-])(gen_(?:img|vid)_[A-Za-z0-9_-]+)/g;

export function normalizedMediaPath(path: string): string | null {
  const forward = path.replace(/\\/g, '/');
  if (!forward || forward.startsWith('/') || /^[a-zA-Z]:\//.test(forward)) return null;
  const parts = forward.split('/');
  if (parts.some((part) => part === '..')) return null;
  return parts.filter((part) => part && part !== '.').join('/');
}

/**
 * Recover the element placeholder encoded by OpenMAIC's portable media path.
 * Posters intentionally resolve to the same element as their source video.
 */
export function mediaElementIdFromPath(path: string): string | null {
  const normalized = normalizedMediaPath(path);
  if (!normalized) return null;
  const filename = normalized.split('/').pop();
  if (!filename) return null;
  const elementId = filename.replace(/\.poster\.[^.]+$/i, '').replace(/\.[^.]+$/, '');
  return elementId || null;
}

export interface GeneratedMediaReference {
  elementId: string;
  referencedBy: string;
}

/** Collect generated-media placeholders without assuming a particular slide schema version. */
export function collectGeneratedMediaReferences(
  value: unknown,
  rootPath: string,
): GeneratedMediaReference[] {
  const references = new Map<string, GeneratedMediaReference>();

  const visit = (candidate: unknown, path: string) => {
    if (typeof candidate === 'string') {
      for (const match of candidate.matchAll(GENERATED_MEDIA_REFERENCE)) {
        const elementId = match[1];
        references.set(`${elementId}\0${path}`, { elementId, referencedBy: path });
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      visit(child, `${path}.${key}`);
    }
  };

  visit(value, rootPath);
  return [...references.values()];
}

function stablePathHash(value: string): string {
  // FNV-1a (32 bit) is deterministic in every supported browser and produces
  // compact, ID-safe suffixes. It is not used for security.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Build stable element IDs for imported media. The conventional first path
 * keeps its basename so `gen_img_*`/`gen_vid_*` scene placeholders still
 * resolve, while same-basename files in other directories receive a stable
 * path-derived suffix instead of colliding in IndexedDB.
 */
export function buildMediaElementIdMap(paths: readonly string[]): ReadonlyMap<string, string> {
  const candidates = paths
    .map((rawPath) => {
      const normalizedPath = normalizedMediaPath(rawPath);
      const baseId = mediaElementIdFromPath(rawPath);
      return normalizedPath && baseId ? { rawPath, normalizedPath, baseId } : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => {
      const leftCanonical = left.normalizedPath.startsWith('media/') ? 0 : 1;
      const rightCanonical = right.normalizedPath.startsWith('media/') ? 0 : 1;
      return (
        left.baseId.localeCompare(right.baseId) ||
        leftCanonical - rightCanonical ||
        left.normalizedPath.localeCompare(right.normalizedPath) ||
        left.rawPath.localeCompare(right.rawPath)
      );
    });

  const result = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const candidate of candidates) {
    let elementId = candidate.baseId;
    if (usedIds.has(elementId)) {
      const suffix = stablePathHash(`${candidate.normalizedPath}\0${candidate.rawPath}`);
      elementId = `${candidate.baseId}__${suffix}`;
      let disambiguator = 2;
      while (usedIds.has(elementId)) {
        elementId = `${candidate.baseId}__${suffix}_${disambiguator}`;
        disambiguator += 1;
      }
    }
    usedIds.add(elementId);
    result.set(candidate.rawPath, elementId);
  }
  return result;
}
