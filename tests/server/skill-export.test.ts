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
});
