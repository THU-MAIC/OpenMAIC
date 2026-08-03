/**
 * Security-boundary tests for archive extraction: the ZIP is untrusted input,
 * so `unzipProject` must reject bombs (entry count / entry size / total size /
 * compression ratio) *before* decompressing, reject path traversal, and require
 * an `index.html`. These are the guards standing between a hostile upload and
 * the render host.
 *
 * The size/ratio limits are read from env at config import, so each limit case
 * stubs a *tiny* limit and re-imports the module — that trips the guard with a
 * few KB instead of allocating hundreds of MB (which would blow the test timeout
 * and stress CI memory), while exercising the exact same code path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

let dest: string;

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), 'unzip-test-'));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Import `unzipProject` fresh so config picks up any stubbed env for this case. */
async function freshUnzip() {
  vi.resetModules();
  return import('../src/unzip.js');
}

/** Build a ZIP from a name→string map. */
function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

describe('unzipProject', () => {
  it('extracts a valid project with index.html', async () => {
    const { unzipProject } = await freshUnzip();
    const archive = zip({ 'index.html': '<!doctype html>', 'assets/app.js': 'console.log(1)' });
    await unzipProject(archive, dest);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toContain('<!doctype html>');
    expect(await readFile(join(dest, 'assets/app.js'), 'utf8')).toContain('console.log');
  });

  it('rejects an archive missing index.html', async () => {
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    const archive = zip({ 'assets/app.js': 'x' });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects path traversal outside the destination', async () => {
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    // fflate preserves the literal entry name; a `../` escape must be caught.
    const archive = zipSync({
      'index.html': strToU8('<!doctype html>'),
      '../escape.txt': strToU8('pwned'),
    });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
    await expect(readFile(join(dest, '..', 'escape.txt'), 'utf8')).rejects.toBeTruthy();
  });

  it('rejects too many entries', async () => {
    vi.stubEnv('RENDER_MAX_ENTRIES', '3');
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    const files: Record<string, string> = { 'index.html': '<!doctype html>' };
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = 'x';
    await expect(unzipProject(zip(files), dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects a single entry that expands beyond the per-entry cap', async () => {
    vi.stubEnv('RENDER_MAX_ENTRY_BYTES', '64');
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    // 2KB of random-ish text: exceeds the 64-byte cap and won't compress past
    // the ratio guard, so the per-entry-size guard is what trips.
    const body = Array.from({ length: 2048 }, (_, i) => String.fromCharCode(33 + (i % 90))).join(
      '',
    );
    const archive = zip({ 'index.html': '<!doctype html>', 'big.txt': body });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects total expansion beyond the aggregate cap', async () => {
    vi.stubEnv('RENDER_MAX_EXPANDED_BYTES', '32');
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    const body = Array.from({ length: 200 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('');
    const archive = zip({ 'index.html': '<!doctype html>', 'a.txt': body });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects an implausible compression ratio (zip bomb)', async () => {
    vi.stubEnv('RENDER_MAX_COMPRESSION_RATIO', '5');
    vi.stubEnv('RENDER_MAX_ENTRY_BYTES', String(1024 * 1024 * 1024)); // don't let size trip first
    const { unzipProject, InvalidProjectError } = await freshUnzip();
    // Highly repetitive content deflates far past a 5:1 ratio.
    const bomb = 'a'.repeat(200 * 1024);
    const archive = zip({ 'index.html': '<!doctype html>', 'bomb.txt': bomb });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });
});
