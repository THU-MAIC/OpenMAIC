import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const DIRECT_TASK_LOOKUP = /\btasks\s*\[[^\]]+\]|\.\s*getTask\s*\(/;
const VIDEO_SOURCE_CHOICE =
  /\b(?:element|elementInfo|el)\.(?:src|mediaRef)\s*(?:(?:\?\?|\|\||&&)\s*(?:element|elementInfo|el)\.(?:src|mediaRef)|\?\s*(?:element|elementInfo|el)\.(?:src|mediaRef)\s*:\s*(?:element|elementInfo|el)\.(?:src|mediaRef))/;
const DIRECT_SLIDE_ELEMENT_WALK = /\b(?:slide|source)\.elements\b/;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSION.test(entry.name)) files.push(path);
  }
  return files;
}

describe('video media resolution boundary', () => {
  it('recognizes direct task lookup and local src/mediaRef choice syntax', () => {
    expect(DIRECT_TASK_LOOKUP.test('const task = tasks[element.id];')).toBe(true);
    expect(DIRECT_TASK_LOOKUP.test('const task = store.getTask(mediaRef);')).toBe(true);
    expect(VIDEO_SOURCE_CHOICE.test('const ref = element.mediaRef ?? element.src;')).toBe(true);
    expect(DIRECT_SLIDE_ELEMENT_WALK.test('for (const element of slide.elements) {}')).toBe(true);
  });

  it('routes slide media resolvers through the complete reference-slot helper', () => {
    const cwd = process.cwd();
    const paths = [
      join(cwd, 'lib/media/collect-stage-asset-refs.ts'),
      join(cwd, 'lib/media/media-orchestrator.ts'),
      join(cwd, 'lib/media/media-task-resolution.ts'),
      join(cwd, 'lib/video-export-app/collect.ts'),
      join(cwd, 'lib/utils/stage-storage.ts'),
    ];
    const violations = paths.flatMap((path) =>
      DIRECT_SLIDE_ELEMENT_WALK.test(readFileSync(path, 'utf8')) ? [relative(cwd, path)] : [],
    );

    // Best-effort static guard: aliases, destructuring, computed access, and
    // helper indirection can evade this regex and remain review responsibilities.
    expect(violations).toEqual([]);
  });

  it('keeps video source and task decisions inside media-task-resolution', () => {
    const cwd = process.cwd();
    const paths = [
      ...sourceFiles(join(cwd, 'components')),
      ...sourceFiles(join(cwd, 'lib/action')),
      ...sourceFiles(join(cwd, 'lib/playback')),
      join(cwd, 'lib/utils/stage-storage.ts'),
    ];
    const violations = paths.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return DIRECT_TASK_LOOKUP.test(source) || VIDEO_SOURCE_CHOICE.test(source)
        ? [relative(cwd, path)]
        : [];
    });

    // Best-effort static guard: aliases, computed property access, helper
    // indirection, and choices spread across wider expressions can evade regex.
    expect(violations).toEqual([]);
  });

  it('routes the PPTX element path through the unified video resolver', () => {
    const source = readFileSync(join(process.cwd(), 'lib/export/use-export-pptx.ts'), 'utf8');
    expect(source).toMatch(
      /import\s+\{[^}]*\bresolveVideoMediaForElement\b[^}]*\}\s+from\s+'@\/lib\/media\/media-task-resolution'/,
    );
    expect(source).toMatch(
      /el\.type === 'video'[\s\S]{0,200}?resolveVideoMediaForElement\([\s\S]{0,300}?documentElements/,
    );
  });
});
