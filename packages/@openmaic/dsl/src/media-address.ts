/** Classify explicit media URLs/paths without treating opaque asset ids as URLs. */
export function isConcreteMediaAddress(value: string | undefined): boolean {
  const candidate = value?.trimStart();
  if (!candidate || /\s/.test(candidate)) return false;
  if (/^(https?:|data:|blob:|\/|\.\.?\/)/i.test(candidate)) return true;
  // User-inserted browser-relative media is concrete too. Keep this narrow
  // enough that allocated ids and other opaque document refs do not become a
  // network request merely because their pool entry is missing.
  return (
    /^(?:[^:?#]+\/)+[^?#]*(?:[?#].*)?$/.test(candidate) ||
    /^[^:?#]+[?#].*$/.test(candidate) ||
    /^(?:[^:?#]+\/)?[^/:?#]+\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(candidate)
  );
}
