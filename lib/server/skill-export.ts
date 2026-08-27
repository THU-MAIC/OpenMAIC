/** Package installed skills for portable download. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
    const metadata = (skillFiles[0] as unknown as { _data?: { uncompressedSize?: number } })._data;
    if ((metadata?.uncompressedSize ?? 0) > 70_000) {
      throw new UserSkillUploadError('The archive SKILL.md is too large.');
    }
    return parseUserSkillMarkdown(await skillFiles[0]!.async('string'));
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
