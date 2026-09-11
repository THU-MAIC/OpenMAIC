/** Package installed skills for portable download. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { UserSkillError, validateUserSkillInput, type UserSkillFields } from '@openmaic/storage';

export const openClawSkillDir = join(process.cwd(), 'skills', 'openmaic');
export const builtinSkillsDir = join(process.cwd(), 'skills', 'agent-runtime');

/** A download id may name only one entry below a known skill root. */
export function isSafeSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const dirZipCache = new Map<string, Buffer | null>();

/** Zip a deployment-immutable skill directory verbatim below its root folder. */
export async function buildSkillDirZip(dir: string, root: string): Promise<Buffer | null> {
  if (dirZipCache.has(dir)) return dirZipCache.get(dir)!;
  let zip: Buffer | null = null;
  try {
    await stat(dir);
    const bundle = new JSZip();
    for (const file of await walk(dir)) {
      bundle.file(`${root}/${relative(dir, file)}`, await readFile(file));
    }
    zip = await bundle.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  } catch {
    zip = null;
  }
  dirZipCache.set(dir, zip);
  return zip;
}

export function buildOpenClawSkillZip(): Promise<Buffer | null> {
  return buildSkillDirZip(openClawSkillDir, 'openmaic');
}

export function buildBuiltinSkillZip(id: string): Promise<Buffer | null> {
  return buildSkillDirZip(join(builtinSkillsDir, id), id);
}

export interface UserSkillContent {
  name: string;
  title: string;
  description: string;
  content: string;
}

export type UserSkillUpload = UserSkillFields & { name: string };

export class UserSkillUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserSkillUploadError';
  }
}

/**
 * Parse the canonical SKILL.md shape produced by `buildUserSkillZip` and run
 * it through the exact same package-owned validation used by `create_skill`.
 */
export function parseUserSkillMarkdown(markdown: string): UserSkillUpload {
  try {
    const text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!text.startsWith('---\n')) {
      throw new UserSkillUploadError('SKILL.md must begin with YAML frontmatter.');
    }
    const end = text.indexOf('\n---\n', 4);
    if (end === -1) throw new UserSkillUploadError('SKILL.md frontmatter is not closed.');

    const loaded = loadYaml(text.slice(4, end));
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new UserSkillUploadError('SKILL.md frontmatter must be a YAML object.');
    }
    const frontmatter = loaded as Record<string, unknown>;
    if (
      typeof frontmatter.name !== 'string' ||
      typeof frontmatter.title !== 'string' ||
      typeof frontmatter.description !== 'string'
    ) {
      throw new UserSkillUploadError(
        'SKILL.md frontmatter requires string name, title, and description fields.',
      );
    }
    return validateUserSkillInput({
      name: frontmatter.name,
      title: frontmatter.title,
      description: frontmatter.description,
      content: text.slice(end + 5),
    });
  } catch (error) {
    if (error instanceof UserSkillError || error instanceof UserSkillUploadError) throw error;
    throw new UserSkillUploadError('SKILL.md frontmatter is not valid YAML.');
  }
}

/** SKILL.md byte ceiling: the 64 KiB content column plus frontmatter headroom. */
const maxSkillMdBytes = 70_000;

/**
 * The JSZip internals surface of one loaded entry — the same surface the
 * declared-size check below reads. `loadAsync` trusts the central directory
 * only (the local header's size copies are skipped) and eagerly slices the
 * entry's compressed bytes into `compressedContent` (jszip 3.10.1
 * `zipEntry.js`/`compressedObject.js`), so the raw stream is available without
 * inflating it. In a hand-built zip every field here is attacker controlled.
 */
type LoadedZipEntryData = {
  uncompressedSize?: number;
  compression?: { magic?: string };
  compressedContent?: Uint8Array;
};

/**
 * Decode the SKILL.md entry with a hard output cap instead of `async()`.
 * `uncompressedSize` is a declaration, not a measurement: a malicious zip
 * states a tiny size while its deflate stream expands arbitrarily, and JSZip
 * inflates the real stream first (its own length comparison fires only on the
 * stream's end event, after the memory is spent). The upload route caps the
 * archive at 1 MiB and deflate expands up to ~1032:1, so one request could
 * otherwise grow ~1 GiB in the server process. `maxOutputLength` makes zlib
 * abort the moment output crosses the cap, bounding expansion no matter what
 * the headers claim. STORE entries (the only other method JSZip registers,
 * magic `\x00\x00`) carry the content verbatim in `compressedContent`, so they
 * are length checked directly, never inflated.
 */
function decodeSkillMdEntry(entry: JSZip.JSZipObject): string {
  const data = (entry as unknown as { _data?: LoadedZipEntryData })._data;
  const compressed = data?.compressedContent;
  if (!compressed) throw new UserSkillUploadError('The skill archive is not a valid zip file.');
  if (data.compression?.magic === '\u0008\u0000') {
    try {
      return inflateRawSync(compressed, { maxOutputLength: maxSkillMdBytes }).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new UserSkillUploadError('The archive SKILL.md is too large.');
      }
      throw error; // corrupt stream — the caller reports it as an invalid zip
    }
  }
  if (compressed.byteLength > maxSkillMdBytes) {
    throw new UserSkillUploadError('The archive SKILL.md is too large.');
  }
  return Buffer.from(compressed).toString('utf8');
}

/** Read the single SKILL.md from an exported owner-skill zip. */
export async function parseUserSkillZip(bytes: Buffer): Promise<UserSkillUpload> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const skillFiles = Object.values(zip.files).filter(
      (entry) => !entry.dir && /(^|\/)SKILL\.md$/.test(entry.name),
    );
    if (skillFiles.length !== 1) {
      throw new UserSkillUploadError('The archive must contain exactly one SKILL.md file.');
    }
    const metadata = (skillFiles[0] as unknown as { _data?: LoadedZipEntryData })._data;
    // Honest zips are refused here without inflating; the decode below bounds
    // the ones whose declared size lies.
    if ((metadata?.uncompressedSize ?? 0) > maxSkillMdBytes) {
      throw new UserSkillUploadError('The archive SKILL.md is too large.');
    }
    return parseUserSkillMarkdown(decodeSkillMdEntry(skillFiles[0]!));
  } catch (error) {
    if (error instanceof UserSkillError || error instanceof UserSkillUploadError) throw error;
    throw new UserSkillUploadError('The skill archive is not a valid zip file.');
  }
}

/** Reconstruct the canonical SKILL.md shape from the package-owned row fields. */
export async function buildUserSkillZip(skill: UserSkillContent): Promise<Buffer> {
  const zip = new JSZip();
  const frontmatter = dumpYaml(
    { name: skill.name, title: skill.title, description: skill.description },
    { lineWidth: -1 },
  ).trimEnd();
  zip.file(`${skill.name}/SKILL.md`, `---\n${frontmatter}\n---\n\n${skill.content}\n`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
