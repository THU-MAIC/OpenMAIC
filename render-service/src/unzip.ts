/**
 * unzip — expand the app's export ZIP into a project directory the producer can
 * render. The archive layout is exactly what `packageVideoZip` produces:
 * `index.html` + `assets/**` + the vendored GSAP, all project-relative.
 *
 * The archive is untrusted input, so extraction is bounded *before* any bytes
 * are decompressed: fflate's `filter` runs per entry with the entry's declared
 * compressed (`size`) and expanded (`originalSize`) sizes, letting us reject
 * ZIP bombs (too many entries, an oversized entry, oversized total, or an
 * implausible compression ratio) without ever materializing them. Path
 * traversal (`../`) is rejected too.
 *
 * Decompression uses fflate's **async** `unzip`, which offloads the actual
 * inflate to a worker thread instead of blocking the service's event loop (so
 * `/health` and poll requests stay responsive during a large expansion). The
 * `filter` still runs synchronously in the initial pass — that's the cheap,
 * declared-size security gate — and a limit breach throws straight out of the
 * `unzip()` call, which we translate into a rejected promise.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { unzip, type Unzipped, type UnzipFileInfo } from 'fflate';
import { config } from './config.js';

export class InvalidProjectError extends Error {}

/**
 * Expand `zip` into `destDir`. Throws {@link InvalidProjectError} if the archive
 * escapes `destDir`, trips a size/entry limit, or lacks an `index.html` entry.
 */
export async function unzipProject(zip: Uint8Array, destDir: string): Promise<void> {
  let entryCount = 0;
  let expandedTotal = 0;

  // The filter is the security boundary: it runs for every entry using only the
  // ZIP's declared sizes, before fflate decompresses anything. Throwing here
  // aborts the whole unzip. Directory entries carry no data.
  const filter = (file: UnzipFileInfo): boolean => {
    if (file.name.endsWith('/')) return false;

    entryCount += 1;
    if (entryCount > config.maxEntries) {
      throw new InvalidProjectError(`Archive has too many entries (> ${config.maxEntries})`);
    }
    if (file.originalSize > config.maxEntryBytes) {
      throw new InvalidProjectError(`Archive entry too large: ${file.name}`);
    }
    // Ratio guard catches deeply-compressed bombs (a tiny entry claiming a
    // huge expansion). Ignore tiny entries where the ratio is meaningless.
    if (file.size > 0 && file.originalSize / file.size > config.maxCompressionRatio) {
      throw new InvalidProjectError(`Archive entry compression ratio too high: ${file.name}`);
    }
    expandedTotal += file.originalSize;
    if (expandedTotal > config.maxExpandedBytes) {
      throw new InvalidProjectError('Archive expands beyond the allowed total size');
    }
    return true;
  };

  // Promisify the async (worker-offloaded) unzip. A filter breach throws
  // synchronously out of unzip(); the decompression itself reports via callback.
  const entries = await new Promise<Unzipped>((resolvePromise, rejectPromise) => {
    try {
      unzip(zip, { filter }, (err, data) => {
        if (err) rejectPromise(err);
        else resolvePromise(data);
      });
    } catch (err) {
      rejectPromise(err);
    }
  });

  const names = Object.keys(entries);
  if (!names.some((n) => n === 'index.html' || n.endsWith('/index.html'))) {
    throw new InvalidProjectError('Export archive is missing index.html');
  }

  const destRoot = resolve(destDir);
  for (const [name, bytes] of Object.entries(entries)) {
    const target = resolve(destRoot, name);
    const rel = relative(destRoot, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new InvalidProjectError(`Unsafe path in archive: ${name}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}
