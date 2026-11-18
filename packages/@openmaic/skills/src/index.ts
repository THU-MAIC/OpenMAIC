import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { load, dump } from 'js-yaml';
import JSZip from 'jszip';

export const SKILL_LIMITS = Object.freeze({
  files: 256,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  archiveBytes: 10 * 1024 * 1024,
});
export type SkillFile = Readonly<{ path: string; bytes: Uint8Array }>;
export type SkillManifest = Readonly<{
  format: 1;
  name: string;
  description: string;
  title?: string;
  files: readonly Readonly<{ path: string; hash: string; bytes: number }>[];
  revision: string;
}>;
export class SkillPackageError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PACKAGE'
      | 'LIMIT_EXCEEDED'
      | 'REVISION_CONFLICT'
      | 'FILE_NOT_FOUND',
  ) {
    super(code);
  }
}
function fail(code: SkillPackageError['code'] = 'INVALID_PACKAGE'): never {
  throw new SkillPackageError(code);
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function validateSkillPath(path: string): string {
  if (
    !path ||
    new TextDecoder().decode(new TextEncoder().encode(path)) !== path ||
    path.length > 512 ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          Buffer.byteLength(p, 'utf8') > 255 ||
          p === '.' ||
          p === '..' ||
          /[<>:"|?*]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?: *\.|$)/i.test(p),
      )
  )
    fail();
  return path;
}
const decode = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
};

// Close uppercase expansion and lowercase mapping to a stable key (including
// capital sharp-s, sharp-s/ss and final sigma). This locale-independent key is
// conservative: portability checks may reject additional case variants.
function portablePathKey(path: string): string {
  let key = path.normalize('NFC');
  for (;;) {
    const folded = key.toUpperCase().toLowerCase().normalize('NFC');
    if (folded === key) return key;
    key = folded;
  }
}

/** An owned byte snapshot; callers never receive the mutable internal buffers. */
export class SkillPackage {
  readonly manifest: SkillManifest;
  #files = new Map<string, Uint8Array>();
  constructor(input: readonly SkillFile[]) {
    if (!input.length || input.length > SKILL_LIMITS.files) fail('LIMIT_EXCEEDED');
    let total = 0;
    const portablePaths = new Set<string>();
    const portablePrefixes = new Map<string, string>();
    for (const file of input) {
      validateSkillPath(file.path);
      const parts = file.path.split('/');
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join('/');
        const key = portablePathKey(prefix);
        const spelling = portablePrefixes.get(key);
        if (spelling !== undefined && spelling !== prefix) fail();
        portablePrefixes.set(key, prefix);
      }
      const portablePath = portablePathKey(file.path);
      if (portablePaths.has(portablePath)) fail();
      portablePaths.add(portablePath);
      total += file.bytes.byteLength;
      if (file.bytes.byteLength > SKILL_LIMITS.fileBytes || total > SKILL_LIMITS.totalBytes)
        fail('LIMIT_EXCEEDED');
      this.#files.set(file.path, Uint8Array.from(file.bytes));
    }
    const paths = [...this.#files.keys()].sort();
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.length > 1) {
        parts.pop();
        if (portablePaths.has(portablePathKey(parts.join('/')))) fail();
      }
    }
    const entry = this.#files.get('SKILL.md');
    if (!entry) fail();
    const markdown = decode(entry).replace(/\r\n?/g, '\n');
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(markdown);
    if (!match || !match[2].trim()) fail();
    let metadata: unknown;
    try {
      metadata = load(match[1]);
    } catch {
      fail();
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail();
    const fields = metadata as Record<string, unknown>;
    if (
      typeof fields.name !== 'string' ||
      fields.name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name)
    )
      fail();
    validateSkillPath(fields.name);
    if (
      typeof fields.description !== 'string' ||
      !fields.description.trim() ||
      fields.description.length > 1024
    )
      fail();
    const extra =
      fields.metadata && typeof fields.metadata === 'object'
        ? (fields.metadata as Record<string, unknown>)
        : {};
    const title =
      typeof fields.title === 'string'
        ? fields.title
        : typeof extra.title === 'string'
          ? extra.title
          : undefined;
    const files = paths.map((path) =>
      Object.freeze({
        path,
        hash: hash(this.#files.get(path)!),
        bytes: this.#files.get(path)!.byteLength,
      }),
    );
    const identity = { format: 1 as const, files };
    this.manifest = Object.freeze({
      ...identity,
      files: Object.freeze(files),
      name: fields.name,
      description: fields.description,
      ...(title ? { title } : {}),
      revision: hash(JSON.stringify(identity)),
    });
    Object.freeze(this);
  }
  read(path: string): Uint8Array {
    validateSkillPath(path);
    const bytes = this.#files.get(path);
    if (!bytes) fail('FILE_NOT_FOUND');
    return Uint8Array.from(bytes);
  }
  entries(): SkillFile[] {
    return this.manifest.files.map((f) => ({ path: f.path, bytes: this.read(f.path) }));
  }
}
export type SkillFilePatch = Readonly<{ path: string; bytes: Uint8Array | null }>;
/** Pure transformation. The store must also compare expectedRevision atomically at commit. */
export function patchSkillPackage(
  current: SkillPackage,
  expectedRevision: string,
  changes: readonly SkillFilePatch[],
): SkillPackage {
  if (current.manifest.revision !== expectedRevision) fail('REVISION_CONFLICT');
  const files = new Map(current.entries().map((f) => [f.path, f.bytes]));
  const seen = new Set<string>();
  for (const change of changes) {
    validateSkillPath(change.path);
    if (seen.has(change.path)) fail();
    seen.add(change.path);
    if (change.bytes === null) {
      if (!files.delete(change.path)) fail('FILE_NOT_FOUND');
    } else files.set(change.path, change.bytes);
  }
  return new SkillPackage([...files].map(([path, bytes]) => ({ path, bytes })));
}
export async function exportSkillPackage(skill: SkillPackage): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of skill.entries())
    zip.file(`${skill.manifest.name}/${file.path}`, file.bytes, {
      date: new Date('1980-01-01T00:00:00Z'),
      createFolders: false,
    });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
export async function importSkillPackage(bytes: Uint8Array): Promise<SkillPackage> {
  if (bytes.byteLength > SKILL_LIMITS.archiveBytes) fail('LIMIT_EXCEEDED');
  try {
    validateZipDirectory(bytes);
    const zip = await JSZip.loadAsync(bytes, {
      createFolders: false,
      decodeFileName: decodeLegacyZipName,
    });
    const files: SkillFile[] = [];
    let total = 0;
    let root: string | undefined;
    for (const entry of Object.values(zip.files)) {
      const original =
        (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ??
        entry.name;
      if (original !== entry.name) fail();
      validateSkillPath(entry.dir ? original.replace(/\/$/, '') : original);
      const mode =
        typeof entry.unixPermissions === 'number'
          ? entry.unixPermissions
          : parseInt(entry.unixPermissions ?? '0', 8);
      if (mode & 0xf000 && (mode & 0xf000) !== (entry.dir ? 0x4000 : 0x8000)) fail();
      const slash = original.indexOf('/');
      const directory = slash < 0 ? original : original.slice(0, slash);
      if (root && root !== directory) fail();
      root = directory;
      if (entry.dir) continue;
      if (slash < 0) fail();
      if (files.length >= SKILL_LIMITS.files) fail('LIMIT_EXCEEDED');
      // Bound real decompression, not the archive's attacker-controlled size declaration.
      const data = (
        entry as unknown as {
          _data: { compressedContent: Uint8Array; crc32: number; compression: { magic: string } };
        }
      )._data;
      let content: Uint8Array;
      if (data.compression.magic === '\x08\x00')
        content = inflateRawSync(data.compressedContent, {
          maxOutputLength: Math.min(SKILL_LIMITS.fileBytes, SKILL_LIMITS.totalBytes - total) + 1,
        });
      else if (data.compression.magic === '\x00\x00') content = data.compressedContent;
      else return fail();
      if (data.crc32 >>> 0 !== crc32(content)) fail();
      total += content.byteLength;
      if (content.byteLength > SKILL_LIMITS.fileBytes || total > SKILL_LIMITS.totalBytes)
        fail('LIMIT_EXCEEDED');
      files.push({ path: original.slice(slash + 1), bytes: content });
    }
    const skill = new SkillPackage(files);
    if (root !== skill.manifest.name) fail();
    return skill;
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
      return fail('LIMIT_EXCEEDED');
    return fail();
  }
}

/** Inspect names before JSZip can overwrite duplicate entries or normalize paths. */
function validateZipDirectory(input: Uint8Array): void {
  const bytes = Buffer.from(input);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail();
  const count = bytes.readUInt16LE(end + 10);
  if (count !== bytes.readUInt16LE(end + 8) || count > SKILL_LIMITS.files * 8)
    fail('LIMIT_EXCEEDED');
  let offset = bytes.readUInt32LE(end + 16);
  const stop = offset + bytes.readUInt32LE(end + 12);
  if (stop !== end) fail();
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > stop || bytes.readUInt32LE(offset) !== 0x02014b50) fail();
    const length = bytes.readUInt16LE(offset + 28);
    const next =
      offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > stop || bytes.readUInt16LE(offset + 34) || bytes.readUInt16LE(offset + 8) & 1)
      fail();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + length);
    const name =
      bytes.readUInt16LE(offset + 8) & 0x800 ? decode(nameBytes) : decodeLegacyZipName(nameBytes);
    validatePathExtras(bytes, offset + 46 + length, bytes.readUInt16LE(offset + 30), name);
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(local) !== 0x04034b50)
      fail();
    const localLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localLength + bytes.readUInt16LE(local + 28);
    validatePathExtras(bytes, local + 30 + localLength, bytes.readUInt16LE(local + 28), name);
    if (
      dataStart + bytes.readUInt32LE(offset + 20) > bytes.readUInt32LE(end + 16) ||
      !nameBytes.equals(bytes.subarray(local + 30, local + 30 + localLength)) ||
      bytes.readUInt16LE(local + 6) !== bytes.readUInt16LE(offset + 8) ||
      bytes.readUInt16LE(local + 8) !== bytes.readUInt16LE(offset + 10)
    )
      fail();
    validateSkillPath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (seen.has(name)) fail();
    seen.add(name);
    offset = next;
  }
  if (offset !== stop) fail();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePathExtras(bytes: Buffer, start: number, length: number, name: string): void {
  const end = start + length;
  if (end > bytes.length) fail();
  for (let at = start; at < end; ) {
    if (at + 4 > end) fail();
    const type = bytes.readUInt16LE(at);
    const size = bytes.readUInt16LE(at + 2);
    const next = at + 4 + size;
    if (next > end) fail();
    // A Unicode path must agree with the original UTF-8 name; aliases can
    // otherwise collapse distinct central-directory entries inside JSZip.
    if (
      type === 0x7075 &&
      (size < 5 || bytes[at + 4] !== 1 || decode(bytes.subarray(at + 9, next)) !== name)
    )
      fail();
    if (type === 0x0001) fail(); // ZIP64 is outside the bounded archive profile.
    at = next;
  }
}

/** Read-only text projection for progressive disclosure, with an explicit coverage receipt. */
export function readSkillResource(
  skill: SkillPackage,
  path = 'SKILL.md',
  offset = 0,
  limit = 12000,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 12000
  )
    fail();
  const text = decode(skill.read(path));
  // Byte cursors cannot split multibyte UTF-8; character cursors count code points.
  const characters = Array.from(text);
  if (offset > characters.length) fail();
  const next = Math.min(characters.length, offset + limit);
  return Object.freeze({
    path,
    revision: skill.manifest.revision,
    hash: hash(skill.read(path)),
    text: characters.slice(offset, next).join(''),
    offset,
    nextOffset: next < characters.length ? next : null,
    totalCharacters: characters.length,
    complete: offset === 0 && next === characters.length,
  });
}

/** Adapt a legacy user Skill body without changing the existing storage format. */
export function skillPackageFromLegacyContent(input: {
  name: string;
  description: string;
  title?: string;
  content: string;
}): SkillPackage {
  const { content, ...metadata } = input;
  return new SkillPackage([
    {
      path: 'SKILL.md',
      bytes: new TextEncoder().encode(`---\n${dump(metadata, { lineWidth: -1 })}---\n${content}`),
    },
  ]);
}

// ZIP legacy names use CP437 when the UTF-8 flag is clear.
// Mapping: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP437.TXT
const cp437High =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeLegacyZipName(bytes: Uint8Array | number[] | string[]): string {
  let result = '';
  for (const value of bytes) {
    const byte = typeof value === 'string' ? value.charCodeAt(0) : value;
    result += byte < 128 ? String.fromCharCode(byte) : cp437High[byte - 128];
  }
  return result;
}
