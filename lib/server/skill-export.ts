/** Package installed skills for portable download. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { dump as dumpYaml } from 'js-yaml';

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
