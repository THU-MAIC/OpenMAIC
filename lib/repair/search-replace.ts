type Result = { ok: true; result: string } | { ok: false; error: string };

const BLOCK_RE = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function applySearchReplace(source: string, blocks: string): Result {
  const matches = [...blocks.matchAll(BLOCK_RE)];
  if (matches.length === 0) return { ok: false, error: 'no SEARCH/REPLACE blocks found' };
  let working = source;
  for (const m of matches) {
    const search = m[1];
    const replace = m[2];
    const n = countOccurrences(working, search);
    if (n === 0) return { ok: false, error: `SEARCH block not found:\n${search.slice(0, 120)}` };
    if (n > 1)
      return {
        ok: false,
        error: `SEARCH block ambiguous (${n} matches):\n${search.slice(0, 120)}`,
      };
    working = working.replace(search, () => replace);
  }
  return { ok: true, result: working };
}
