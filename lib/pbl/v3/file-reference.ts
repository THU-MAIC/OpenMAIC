export interface FileReference {
  path: string;
  line?: number;
  end?: number;
}

/** Fragment links stay inside this workbench, never opening an OS or server path. */
export function fileReferenceHref(path: string, line?: number, end?: number) {
  const params = new URLSearchParams({ 'pbl-file': path });
  if (line !== undefined) params.set('line', String(line));
  if (end !== undefined) params.set('end', String(end));
  return `#${params}`;
}

export function parseFileReference(href: string): FileReference | null {
  // Tutors sometimes repeat the project path before the tool's fragment.
  const hash = href.indexOf('#pbl-file=');
  if (hash < 0) return null;
  const prefix = href.slice(0, hash);
  const params = new URLSearchParams(href.slice(hash + 1));
  const path = params.get('pbl-file');
  if (
    !path ||
    (prefix !== '' && prefix !== path) ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    return null;
  if ([...params.keys()].some((key) => !['pbl-file', 'line', 'end'].includes(key))) return null;
  const line = params.get('line'),
    end = params.get('end');
  const valid = (value: string | null) => value === null || /^[1-9]\d{0,6}$/.test(value);
  if (!valid(line) || !valid(end) || (end && (!line || Number(end) < Number(line)))) return null;
  return { path, ...(line ? { line: Number(line) } : {}), ...(end ? { end: Number(end) } : {}) };
}

export interface FileChangeRange {
  start: number;
  end: number;
  kind: 'added' | 'modified' | 'deleted';
}
