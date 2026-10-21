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
