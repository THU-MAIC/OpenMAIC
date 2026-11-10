/** Provider paths and kept-image keys, shared by the worker and its caller. */
export function isProviderPath(target) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/');
}

export function normalizePath(target) {
  let path = target.replace(/^\.\//, '');
  try {
    path = decodeURI(path);
  } catch {
    // Keep it as written.
  }
  return path;
}

export function basename(path) {
  return path.split('/').pop() ?? path;
}

export function keyOf(index, target) {
  const path = normalizePath(target);
  return index.exact.get(path) ?? index.byBasename.get(basename(path));
}

/**
 * The link target a provider's reference becomes: the key of the kept image it
 * names, `null` for a provider file not kept (its alt text replaces it), or
 * `undefined` to keep it as written. A URL is a kept image's only when that
 * image was downloaded from it (or the provider named the image by it).
 */
export function derivativeTarget(index, target) {
  if (!isProviderPath(target)) {
    const key = index.remote?.get(target);
    return key ? `openmaic-derivative:${key}` : undefined;
  }
  const key = keyOf(index, target);
  return key ? `openmaic-derivative:${key}` : null;
}
