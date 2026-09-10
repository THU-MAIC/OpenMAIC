import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  buildBuiltinSkillZip,
  buildOpenClawSkillZip,
  buildUserSkillZip,
  isSafeSkillId,
  openClawSkillDir,
  parseUserSkillMarkdown,
  parseUserSkillZip,
} from '@/lib/server/skill-export';

function walkRelative(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRelative(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/**
 * Offset of `name`'s record in the zip central directory. JSZip reads entry
 * sizes only from there (never from the local header), so tests forge declared
 * sizes at this offset to simulate the lying-header attack.
 */
function centralDirectoryEntry(bytes: Buffer, name: string): number {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('test zip has no end-of-central-directory record');
  let offset = bytes.readUInt32LE(eocd + 16);
  const count = bytes.readUInt16LE(eocd + 10);
  for (let entry = 0; entry < count; entry += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('test zip has a broken central directory');
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    if (bytes.toString('utf8', offset + 46, offset + 46 + nameLength) === name) return offset;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`test zip has no central-directory entry for ${name}`);
}

function skillMarkdown(body: string): string {
  return `---\nname: my-skill\ntitle: Title\ndescription: Description\n---\n\n${body}`;
}

describe('skill export zips', () => {
  it('packages the shipped OpenMAIC skill verbatim under openmaic/', async () => {
    const zip = await buildOpenClawSkillZip();
    expect(zip).not.toBeNull();
    const loaded = await JSZip.loadAsync(zip!);
    const onDisk = walkRelative(openClawSkillDir);
    const entries = Object.values(loaded.files)
      .filter((file) => !file.dir)
      .map((file) => file.name);
    expect(new Set(entries)).toEqual(new Set(onDisk.map((path) => `openmaic/${path}`)));
    for (const path of onDisk) {
      expect(await loaded.file(`openmaic/${path}`)!.async('string')).toBe(
        readFileSync(join(openClawSkillDir, path), 'utf8'),
      );
    }
  });

  it('packages builtin constraints and returns null for an unknown builtin', async () => {
    const loaded = await JSZip.loadAsync((await buildBuiltinSkillZip('lecture-style'))!);
    expect(await loaded.file('lecture-style/SKILL.md')!.async('string')).toContain(
      'name: lecture-style',
    );
    expect(loaded.file('lecture-style/outline-constraints.json')).not.toBeNull();
    expect(await buildBuiltinSkillZip('no-such-skill')).toBeNull();
  });

  it('rejects traversal ids', () => {
    expect(isSafeSkillId('my-skill.2')).toBe(true);
    for (const value of ['../openmaic', 'a/b', '..', '']) expect(isSafeSkillId(value)).toBe(false);
  });

  it('round-trips owner skill fields through valid YAML', async () => {
    const fields = {
      name: 'my-teaching-style',
      title: 'Teaching style "quoted"',
      description: 'One-line description',
      content: '# Body\n\nStored instructions.',
    };
    const zip = await buildUserSkillZip(fields);
    const skillMd = await (await JSZip.loadAsync(zip))
      .file('my-teaching-style/SKILL.md')!
      .async('string');
    const end = skillMd.indexOf('\n---', 3);
    expect(loadYaml(skillMd.slice(4, end))).toEqual({
      name: 'my-teaching-style',
      title: 'Teaching style "quoted"',
      description: 'One-line description',
    });
    expect(skillMd).toContain('Stored instructions.');
    await expect(parseUserSkillZip(zip)).resolves.toEqual(fields);
    expect(parseUserSkillMarkdown(skillMd)).toEqual(fields);
  });

  it('applies create_skill validation to imported owner skills', async () => {
    const invalid =
      '---\nname: builtin-handle\ntitle: Title\ndescription: Description\n---\n\nBody';
    expect(() => parseUserSkillMarkdown(invalid)).toThrow(/must start with "my-"/);

    const ambiguous = new JSZip();
    ambiguous.file('one/SKILL.md', invalid);
    ambiguous.file('two/SKILL.md', invalid);
    await expect(
      parseUserSkillZip(await ambiguous.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toThrow(/exactly one SKILL\.md/);
  });

  it('rejects an honest zip whose SKILL.md exceeds the size cap', async () => {
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', skillMarkdown('x'.repeat(75_000)));
    await expect(
      parseUserSkillZip(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })),
    ).rejects.toThrow('The archive SKILL.md is too large.');
  });

  it('rejects a forged-header zip bomb whose declared size hides the real inflation', async () => {
    // ~100 KB of body compresses to a few hundred bytes, so the bomb itself
    // slips under the upload route's 1 MiB archive cap with room to spare.
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', skillMarkdown('x'.repeat(100 * 1024)));
    const bomb = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );
    // Forge the central directory's declared uncompressedSize (offset 24 in the
    // entry record) to a small honest-looking value.
    bomb.writeUInt32LE(123, centralDirectoryEntry(bomb, 'my-skill/SKILL.md') + 24);
    // The forgery must take, or the test no longer exercises the attack path.
    const reloaded = await JSZip.loadAsync(bomb);
    const forged = reloaded.file('my-skill/SKILL.md') as unknown as {
      _data: { uncompressedSize: number };
    };
    expect(forged._data.uncompressedSize).toBe(123);
    await expect(parseUserSkillZip(bomb)).rejects.toThrow('The archive SKILL.md is too large.');
  });

  it('parses STORE (uncompressed) skill zips', async () => {
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', skillMarkdown('Stored instructions.'));
    const stored = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    await expect(parseUserSkillZip(stored)).resolves.toEqual({
      name: 'my-skill',
      title: 'Title',
      description: 'Description',
      content: 'Stored instructions.',
    });
  });

  it('rejects a forged STORE entry whose declared size hides real bytes', async () => {
    // STORE never inflates, so its only guard is the byte-length check on the
    // actual slice — the forgery below must not make that check read 123.
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', skillMarkdown('x'.repeat(80_000)));
    const bomb = Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    bomb.writeUInt32LE(123, centralDirectoryEntry(bomb, 'my-skill/SKILL.md') + 24);
    const reloaded = await JSZip.loadAsync(bomb);
    const forged = reloaded.file('my-skill/SKILL.md') as unknown as {
      _data: { uncompressedSize: number };
    };
    expect(forged._data.uncompressedSize).toBe(123);
    await expect(parseUserSkillZip(bomb)).rejects.toThrow('The archive SKILL.md is too large.');
  });

  it('reports a corrupt deflate stream as an invalid zip, not a size refusal', async () => {
    // Declare DEFLATE over stored markdown bytes: inflateRawSync throws a
    // plain zlib error (not ERR_BUFFER_TOO_LARGE), which the decoder rethrows
    // for the outer catch to map — pinning that contract keeps a future
    // refactor from swallowing every zlib failure as "too large".
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', skillMarkdown('Plainly stored text.'));
    const lying = Buffer.from(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
    );
    lying.writeUInt16LE(8, centralDirectoryEntry(lying, 'my-skill/SKILL.md') + 10);
    await expect(parseUserSkillZip(lying)).rejects.toThrow(
      'The skill archive is not a valid zip file.',
    );
  });
});
