import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createWorkbenchTranslator, workbenchEn, workbenchResourceFor } from '@/lib/i18n/workbench';
import { supportedLocales } from '@/lib/i18n/locales';
import { skillDisplayLabel, skillTitle } from '@/lib/workbench/agent-skills';

const en = createWorkbenchTranslator('en-US');

// Upstream adaptation: the reference's `workbench locale presentation` block
// drove `presentTool` from `components/workbench/chat/tool-presentation` (the
// workbench UI slice, not ported here) — dropped. The twelve-locale contract,
// the built-in skill names and the hardcoded-copy sweep below are all kept,
// and the two pure translator checks from that block survive in their own
// describe below.

function flatten(value: unknown, keyPath = '', into = new Map<string, string>()) {
  if (typeof value === 'string') {
    into.set(keyPath, value);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, keyPath ? `${keyPath}.${key}` : key, into);
    }
  }
  return into;
}

const interpolations = (value: string): string[] =>
  [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();

describe('workbench translator locales', () => {
  it('translates the other ten locales rather than falling back to English', () => {
    expect(createWorkbenchTranslator('fr-FR')('workbench.tool.label.webSearch')).toBe(
      'Rechercher sur le web',
    );
    expect(createWorkbenchTranslator('de-DE')('workbench.tool.label.webSearch')).toBe(
      'Im Web suchen',
    );
    expect(createWorkbenchTranslator('zh-TW')('workbench.tool.label.webSearch')).toBe('聯網搜尋');
  });

  it('keeps an unknown locale on the English map instead of on the key', () => {
    expect(createWorkbenchTranslator('nl-NL')('workbench.tool.label.webSearch')).toBe(
      'Search the web',
    );
  });
});

/**
 * The twelve-locale contract. `workbenchEn` is the shape; every locale must
 * resolve every one of its keys to a real sentence with the same interpolation
 * variables — a missing key would render as `workbench.tool.label.x` on a card,
 * and a dropped `{{order}}` would render a page number that is not there.
 */
describe('workbench copy covers every supported locale', () => {
  const source = flatten(workbenchEn);

  it('has twelve locales to check', () => {
    expect(supportedLocales.length).toBe(12);
    expect(source.size).toBeGreaterThanOrEqual(200);
  });

  it.each(supportedLocales.map((locale) => locale.code))('%s is complete', (code) => {
    const resource = flatten(workbenchResourceFor(code));
    const missing = [...source.keys()].filter((key) => !resource.has(key));
    const extra = [...resource.keys()].filter((key) => !source.has(key));
    expect(missing, `${code} is missing keys`).toEqual([]);
    expect(extra, `${code} has keys the English map does not`).toEqual([]);
    for (const [key, value] of resource) {
      expect(value.trim(), `${code}.${key} is empty`).not.toBe('');
      expect(interpolations(value), `${code}.${key} changed its interpolations`).toEqual(
        interpolations(source.get(key)!),
      );
    }
  });

  it('keeps every overlay tool key set exactly equal to the base', () => {
    // The "%s is complete" checks above assert on workbenchResourceFor(code),
    // which merges the overlay INTO the base first. A key missing from one
    // overlay therefore silently resolves to the base sentence and nothing
    // fails — the exact gap observed when zh-TW dropped a tool.label key and
    // the suite stayed green. This check holds each overlay FILE itself to the
    // base shape: no missing and no extra `tool.*` key, so a locale that was
    // never translated (or a label key dropped in one locale) turns red.
    const overlaysDir = path.join(process.cwd(), 'lib/i18n/workbench-locales');
    const baseToolKeys = [...flatten(workbenchEn).keys()].filter((key) => key.startsWith('tool.'));
    const files = fs
      .readdirSync(overlaysDir)
      .filter((file) => file.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const overlay = JSON.parse(fs.readFileSync(path.join(overlaysDir, file), 'utf8')) as Record<
        string,
        unknown
      >;
      const overlayToolKeys = [...flatten(overlay).keys()].filter((key) => key.startsWith('tool.'));
      const missing = baseToolKeys.filter((key) => !overlayToolKeys.includes(key));
      const extra = overlayToolKeys.filter((key) => !baseToolKeys.includes(key));
      expect(missing, `${file} is missing tool keys the base has`).toEqual([]);
      expect(extra, `${file} has tool keys the base does not`).toEqual([]);
    }
  });
});

/**
 * The built-in skills are named by product copy, not by their frontmatter, so a
 * new skill directory without a `skill.title.<handle>` key would put one
 * untranslated row in every non-Chinese menu. This is the reconciliation that
 * catches it — the same shape as the allowlist check in
 * `tool-presentation.test.ts`.
 */
describe('built-in skill names', () => {
  const skillsDir = path.join(process.cwd(), 'skills', 'agent-runtime');
  const handles = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')),
    )
    .map((entry) => entry.name)
    .sort();

  it('found the installed skills', () => {
    expect(handles.length).toBeGreaterThanOrEqual(14);
  });

  it.each(handles)('%s has a display name in every locale', (handle) => {
    for (const locale of supportedLocales) {
      const t = createWorkbenchTranslator(locale.code);
      const title = skillTitle({ name: handle, source: 'builtin' }, t);
      expect(title, `${handle} has no ${locale.code} title`).toBeTruthy();
      expect(title, `${handle} renders its ${locale.code} copy key`).not.toMatch(/^workbench\./);
    }
  });

  it('keeps the handle beside the name, and falls back to it for a user Skill', () => {
    expect(skillDisplayLabel({ name: 'stage-design', source: 'builtin' }, en)).toBe(
      'Classroom design /stage-design',
    );
    // A user Skill is named by its author: the copy map is not consulted at all.
    expect(
      skillDisplayLabel({ name: 'stage-design', title: '我的做课法', source: 'user' }, en),
    ).toBe('我的做课法 /stage-design');
    expect(skillDisplayLabel({ name: 'usk-42', source: 'user' }, en)).toBe('/usk-42');
  });
});

/**
 * The workbench surface, swept: every user-visible string reaches the screen
 * through a copy key, so no file under these trees may hold a CJK string
 * literal or JSX text node. Comments are exempt (this walks the AST, not the
 * source), which is why the design notes can still quote a Chinese UI label.
 *
 * The range deliberately includes CJK punctuation (U+3000–U+303F) and fullwidth
 * forms (U+FF00–U+FFEF): the CJK enumeration comma and the CJK sentence joiner
 * are as locale-bound as the words around them, and an earlier version of
 * this check that only looked at U+3400–U+9FFF let two of them ship.
 */
describe('workbench hardcoded-copy contract', () => {
  const CJK = /[　-〿㐀-鿿＀-￯]/u;
  // Upstream adaptation: `components/workbench` and `app/workbench` ship with
  // the workbench UI slices, so this sweep currently covers only the data-layer
  // sources in `lib/workbench` (21 files). The UI slices must extend `roots`
  // back to the full reference list.
  const roots = ['lib/workbench'];

  const walk = (relative: string): string[] => {
    const absolute = path.join(process.cwd(), relative);
    if (!fs.existsSync(absolute)) return [];
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) return walk(child);
      return /\.tsx?$/.test(entry.name) ? [child] : [];
    });
  };
  const files = roots.flatMap((root) => walk(root));

  it('found the workbench sources', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files)('%s has no hardcoded CJK copy', (relative) => {
    const file = path.join(process.cwd(), relative);
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const offenders: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        CJK.test(node.text)
      ) {
        offenders.push(node.text.trim());
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(offenders).toEqual([]);
  });
});
