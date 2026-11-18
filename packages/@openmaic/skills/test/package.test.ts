import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  SkillPackage,
  skillPackageFromLegacyContent,
  exportSkillPackage,
  importSkillPackage,
  patchSkillPackage,
  SKILL_LIMITS,
} from '../src/index';
const bytes = (text: string) => new TextEncoder().encode(text);
const entry = {
  path: 'SKILL.md',
  bytes: bytes('---\nname: lesson-plan\ndescription: Plan a lesson\n---\nUse references/guide.md.'),
};
const guide = { path: 'references/guide.md', bytes: bytes('Check prerequisites.') };
describe('directory packages', () => {
  it('versions all file bytes and ignores input ordering', () => {
    const a = new SkillPackage([entry, guide]);
    expect(new SkillPackage([guide, entry]).manifest.revision).toBe(a.manifest.revision);
    const b = patchSkillPackage(a, a.manifest.revision, [
      { path: guide.path, bytes: bytes('Changed reference') },
    ]);
    expect(b.manifest.revision).not.toBe(a.manifest.revision);
    expect(a.read(guide.path)).toEqual(guide.bytes);
    expect(() => patchSkillPackage(b, a.manifest.revision, [])).toThrow('REVISION_CONFLICT');
  });
  it('round-trips references, binary assets, root files and inert scripts without title', async () => {
    const a = new SkillPackage([
      entry,
      guide,
      { path: 'assets/example.bin', bytes: new Uint8Array([0, 255, 13]) },
      { path: 'outline-constraints.json', bytes: bytes('{}') },
      { path: 'scripts/task.py', bytes: bytes('print(1)') },
    ]);
    const b = await importSkillPackage(await exportSkillPackage(a));
    expect(b.manifest).toEqual(a.manifest);
    expect(b.entries()).toEqual(a.entries());
  });
  it('owns its bytes and returns independent reads', () => {
    const input = Uint8Array.from(entry.bytes);
    const a = new SkillPackage([{ ...entry, bytes: input }]);
    input.fill(0);
    a.read('SKILL.md').fill(0);
    expect(a.read('SKILL.md')).toEqual(entry.bytes);
  });
  it.each(['../secret', '/secret', 'a/../secret', 'a\\secret', 'a//secret', 'a:secret'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => new SkillPackage([entry, { path, bytes: bytes('x') }])).toThrow(
        'INVALID_PACKAGE',
      );
    },
  );
  it('rejects conflicting files and deletion of the entry', () => {
    expect(() => new SkillPackage([entry, entry])).toThrow();
    expect(
      () =>
        new SkillPackage([
          entry,
          { path: 'a', bytes: bytes('x') },
          { path: 'a/b', bytes: bytes('y') },
        ]),
    ).toThrow();
    const a = new SkillPackage([entry]);
    expect(() =>
      patchSkillPackage(a, a.manifest.revision, [{ path: 'SKILL.md', bytes: null }]),
    ).toThrow();
  });
  it('rejects mismatched archive root and links', async () => {
    const zip = new JSZip();
    zip.file('other/SKILL.md', entry.bytes);
    await expect(
      importSkillPackage(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow();
    const links = new JSZip();
    links.file('lesson-plan/SKILL.md', entry.bytes);
    links.file('lesson-plan/assets/link', bytes('/secret'), { unixPermissions: 0o120777 });
    await expect(
      importSkillPackage(await links.generateAsync({ type: 'uint8array', platform: 'UNIX' })),
    ).rejects.toThrow();
  });
});

it.each([
  'assets/config.',
  'assets/config ',
  'assets/dir./file.txt',
  'assets/dir /file.txt',
  'assets/con',
  'assets/CON.txt',
  'assets/CON .txt',
  'assets/nul  .json',
  'assets/COM1 .log',
  'assets/lpt9 .csv',
  'assets/prn.json',
  'assets/aux.csv',
  'assets/nul.bin',
  'assets/com1',
  'assets/COM9.log',
  'assets/lpt1',
  'assets/LPT9.txt',
  'assets/COM¹.txt',
  'assets/LPT².txt',
  'assets/conin$',
  'assets/conout$.txt',
  'assets/a<b.txt',
  'assets/a>b.txt',
  'assets/a"b.txt',
  'assets/a|b.txt',
  'assets/a?b.txt',
  'assets/a*b.txt',
])('rejects non-portable Windows path %s in snapshots and archives', async (path) => {
  expect(() => new SkillPackage([entry, { path, bytes: bytes('sample') }])).toThrow(
    'INVALID_PACKAGE',
  );
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes, { createFolders: false });
  zip.file(`lesson-plan/${path}`, bytes('sample'), { createFolders: false });
  await expect(importSkillPackage(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
    'INVALID_PACKAGE',
  );
});

it.each(['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9'])(
  'rejects the reserved package root %s',
  (name) => {
    expect(
      () =>
        new SkillPackage([
          { ...entry, bytes: bytes(`---\nname: ${name}\ndescription: Method\n---\nPrompt.`) },
        ]),
    ).toThrow('INVALID_PACKAGE');
  },
);

it('keeps ordinary names that only resemble Windows device names portable', async () => {
  const skill = new SkillPackage([
    entry,
    ...['assets/config.txt', 'assets/COM10.txt', 'assets/lpt0.txt', 'assets/con-method.txt'].map(
      (path) => ({ path, bytes: bytes(path) }),
    ),
  ]);
  expect((await importSkillPackage(await exportSkillPackage(skill))).manifest).toEqual(
    skill.manifest,
  );
});

it('reports the file-count resource limit consistently for ZIP imports', async () => {
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes, { createFolders: false });
  for (let i = 1; i < SKILL_LIMITS.files; i++)
    zip.file(`lesson-plan/assets/${i}.txt`, bytes('x'), { createFolders: false });
  expect(
    (await importSkillPackage(await zip.generateAsync({ type: 'uint8array' }))).entries(),
  ).toHaveLength(SKILL_LIMITS.files);
  zip.file('lesson-plan/assets/overflow.txt', bytes('x'), { createFolders: false });
  await expect(
    importSkillPackage(await zip.generateAsync({ type: 'uint8array' })),
  ).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED',
  });
});

it('rejects individual path components beyond the filesystem byte limit', async () => {
  for (const path of [
    `assets/${'a'.repeat(256)}`,
    `assets/${'é'.repeat(128)}`,
    `assets/${'a'.repeat(256)}/file.txt`,
  ]) {
    expect(() => new SkillPackage([entry, { path, bytes: bytes('x') }])).toThrow('INVALID_PACKAGE');
    const zip = new JSZip();
    zip.file('lesson-plan/SKILL.md', entry.bytes, { createFolders: false });
    zip.file(`lesson-plan/${path}`, bytes('x'), { createFolders: false });
    await expect(
      importSkillPackage(await zip.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow('INVALID_PACKAGE');
  }
});

it('round-trips filenames at the component byte boundary', async () => {
  const skill = new SkillPackage([
    entry,
    { path: `assets/${'a'.repeat(255)}`, bytes: bytes('ASCII boundary') },
    { path: `assets/${'é'.repeat(127)}`, bytes: bytes('Unicode boundary') },
  ]);
  expect((await importSkillPackage(await exportSkillPackage(skill))).manifest).toEqual(
    skill.manifest,
  );
});

it('rejects case and normalization aliases in every directory prefix', async () => {
  for (const pair of [
    ['Assets/a.txt', 'assets/b.txt'],
    ['assets/Café/a.txt', 'assets/Cafe\u0301/b.txt'],
    ['assets/ẞ/a.txt', 'assets/ss/b.txt'],
    ['assets/Σ/a.txt', 'assets/ς/b.txt'],
  ]) {
    for (const paths of [pair, [...pair].reverse()]) {
      expect(
        () => new SkillPackage([entry, ...paths.map((path) => ({ path, bytes: bytes('x') }))]),
      ).toThrow('INVALID_PACKAGE');
      const zip = new JSZip();
      zip.file('lesson-plan/SKILL.md', entry.bytes, { createFolders: false });
      for (const path of paths)
        zip.file(`lesson-plan/${path}`, bytes('x'), { createFolders: false });
      await expect(
        importSkillPackage(await zip.generateAsync({ type: 'uint8array' })),
      ).rejects.toThrow('INVALID_PACKAGE');
    }
  }
});

it('round-trips sibling resources sharing the exact directory spelling', async () => {
  const skill = new SkillPackage([
    entry,
    { path: 'assets/shared/a.txt', bytes: bytes('first') },
    { path: 'assets/shared/b.txt', bytes: bytes('second') },
  ]);
  expect((await importSkillPackage(await exportSkillPackage(skill))).manifest).toEqual(
    skill.manifest,
  );
});

it('rejects differing local and central filenames before JSZip can collapse entries', async () => {
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes);
  zip.file('lesson-plan/assets/a.bin', bytes('first'));
  zip.file('lesson-plan/assets/b.bin', bytes('second'));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const target = Buffer.from('lesson-plan/assets/b.bin');
  for (let i = 0; i < archive.length - 30; i++) {
    if (
      archive.readUInt32LE(i) === 0x04034b50 &&
      archive.subarray(i + 30, i + 30 + target.length).equals(target)
    ) {
      archive[i + 30 + target.length - 5] = 'a'.charCodeAt(0);
      break;
    }
  }
  await expect(importSkillPackage(archive)).rejects.toThrow('INVALID_PACKAGE');
});

it('rejects non-round-trippable file names', () => {
  expect(() => new SkillPackage([entry, { path: 'assets/\ud800.txt', bytes: bytes('x') }])).toThrow(
    'INVALID_PACKAGE',
  );
});
it('rejects unicode extra-field aliases and accepts ordinary Unicode resources', async () => {
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes);
  zip.file('lesson-plan/assets/é.txt', bytes('sample'));
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  const valid = await importSkillPackage(archive);
  expect(valid.read('assets/é.txt')).toEqual(bytes('sample'));
  // Replace only the Unicode extra-field name, leaving raw local/central names intact.
  for (let i = 0; i < archive.length - 9; i++) {
    if (archive.readUInt16LE(i) === 0x7075 && archive[i + 4] === 1 && archive[i + 9] === 108) {
      archive[i + 9] = 120;
      break;
    }
  }
  await expect(importSkillPackage(archive)).rejects.toThrow('INVALID_PACKAGE');
});
it('bounds real decompression for every resource, not just the entry', async () => {
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes);
  zip.file('lesson-plan/assets/large.txt', new Uint8Array(2 * 1024 * 1024 + 1));
  await expect(
    importSkillPackage(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })),
  ).rejects.toThrow('LIMIT_EXCEEDED');
});

it('paginates resource text without splitting Unicode and never claims partial coverage', async () => {
  const { readSkillResource } = await import('../src/index');
  const skill = new SkillPackage([entry, { path: 'references/example.txt', bytes: bytes('a😀b') }]);
  expect(readSkillResource(skill, 'references/example.txt', 0, 2)).toMatchObject({
    text: 'a😀',
    complete: false,
    nextOffset: 2,
    revision: skill.manifest.revision,
  });
  expect(readSkillResource(skill, 'references/example.txt', 2, 2)).toMatchObject({
    text: 'b',
    complete: false,
    nextOffset: null,
  });
  expect(readSkillResource(skill)).toMatchObject({ complete: true });
  expect(() => readSkillResource(skill, 'references/example.txt', -1)).toThrow();
});

it('adapts legacy content into a standard single-file package while preserving the body', async () => {
  const content = '# Existing method\nKeep existing instructions.\n';
  const skill = skillPackageFromLegacyContent({
    name: 'legacy-method',
    title: 'Legacy method',
    description: 'Existing method',
    content,
  });
  expect(skill.manifest.title).toBe('Legacy method');
  expect(new TextDecoder().decode(skill.read('SKILL.md')).endsWith(content)).toBe(true);
  expect((await importSkillPackage(await exportSkillPackage(skill))).manifest).toEqual(
    skill.manifest,
  );
});

it('accepts CR-only entry frontmatter without changing stored bytes', () => {
  const content = bytes('---\rname: lesson-plan\rdescription: Method\r---\rUse evidence.');
  const skill = new SkillPackage([{ path: 'SKILL.md', bytes: content }]);
  expect(skill.manifest.name).toBe('lesson-plan');
  expect(skill.read('SKILL.md')).toEqual(content);
});
it('decodes legacy CP437 ZIP resource names with and without Unicode extras', async () => {
  const zip = new JSZip();
  zip.file('lesson-plan/SKILL.md', entry.bytes);
  zip.file('lesson-plan/assets/é.txt', bytes('Legacy encoding'));
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    encodeFileName: (name) =>
      Array.from(name, (c) => String.fromCharCode(c === 'é' ? 0x82 : c.charCodeAt(0))).join(''),
  });
  expect((await importSkillPackage(archive)).read('assets/é.txt')).toEqual(
    bytes('Legacy encoding'),
  );
  // Mark Unicode path fields unknown so decoding must use the raw CP437 names.
  for (let i = 0; i < archive.length - 9; i++)
    if (archive.readUInt16LE(i) === 0x7075 && archive[i + 4] === 1 && archive[i + 9] === 108)
      archive.writeUInt16LE(0x7777, i);
  expect((await importSkillPackage(archive)).read('assets/é.txt')).toEqual(
    bytes('Legacy encoding'),
  );
});

it('protects snapshot state from JavaScript property access and replacement', async () => {
  const skill = new SkillPackage([entry, guide]);
  const manifest = skill.manifest;
  expect(Reflect.get(skill, 'files')).toBeUndefined();
  expect(Reflect.set(skill, 'files', new Map())).toBe(false);
  expect(Reflect.set(skill, 'manifest', { revision: 'forged' })).toBe(false);
  expect(Reflect.deleteProperty(skill, 'manifest')).toBe(false);
  expect(() => Object.defineProperty(skill, 'manifest', { value: {} })).toThrow();
  expect(Reflect.set(manifest, 'revision', 'forged')).toBe(false);
  expect(Reflect.set(manifest.files[0], 'hash', 'forged')).toBe(false);
  skill.entries()[0].bytes.fill(0);
  expect(skill.manifest).toBe(manifest);
  expect(skill.read('SKILL.md')).toEqual(entry.bytes);
  expect((await importSkillPackage(await exportSkillPackage(skill))).manifest).toEqual(manifest);
  expect(patchSkillPackage(skill, manifest.revision, []).manifest).toEqual(manifest);
});

it.each([
  ['SKILL.md', 'skill.md'],
  ['assets/Example.txt', 'assets/example.txt'],
  ['Assets', 'assets/example.txt'],
  ['assets/É.txt', 'assets/é.txt'],
  ['assets/Σ.txt', 'assets/ς.txt'],
  ['assets/ß.txt', 'assets/ss.txt'],
  ['assets/ẞ.txt', 'assets/ß.txt'],
  ['assets/ẞ.txt', 'assets/ss.txt'],
  ['ẞ', 'ss/file.txt'],
  ['Σ', 'ς/file.txt'],
  ['ß', 'ss/file.txt'],
])('rejects portable path collisions between %s and %s', async (first, second) => {
  const files = [
    entry,
    { path: first, bytes: bytes('first') },
    { path: second, bytes: bytes('second') },
  ];
  const input = first === 'SKILL.md' ? files.slice(1) : files;
  if (first === 'SKILL.md') input[0] = entry;
  expect(() => new SkillPackage(input)).toThrow('INVALID_PACKAGE');
  expect(() => new SkillPackage([...input].reverse())).toThrow('INVALID_PACKAGE');
  const zip = new JSZip();
  for (const file of input)
    zip.file(`lesson-plan/${file.path}`, file.bytes, { createFolders: false });
  await expect(importSkillPackage(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
    'INVALID_PACKAGE',
  );
});

it('rejects patches that introduce case aliases while allowing explicit renames', () => {
  const skill = new SkillPackage([entry, guide]);
  expect(() =>
    patchSkillPackage(skill, skill.manifest.revision, [
      { path: 'references/GUIDE.md', bytes: bytes('alias') },
    ]),
  ).toThrow('INVALID_PACKAGE');
  const renamed = patchSkillPackage(skill, skill.manifest.revision, [
    { path: guide.path, bytes: null },
    { path: 'references/GUIDE.md', bytes: guide.bytes },
  ]);
  expect(renamed.read('references/GUIDE.md')).toEqual(guide.bytes);
  expect(skill.read(guide.path)).toEqual(guide.bytes);
});
