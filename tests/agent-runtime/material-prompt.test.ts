/**
 * The materials prompt block (RFC #1716 §4) is static guidance. A conversation
 * with nothing attached can still use the knowledge base, and the block does
 * not change when the material set does.
 */
import { describe, expect, it } from 'vitest';
import type { AgentSessionMaterial } from '@openmaic/storage';

import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import { materialsPromptBlock } from '@/lib/server/agent-runtime/material-prompt';
import type { ResolvedMaterial } from '@/lib/server/agent-runtime/material-resolver';

function row(overrides: Partial<AgentSessionMaterial>): ResolvedMaterial {
  return {
    origin: 'session',
    record: {
      id: 'mat_web',
      sessionId: 'ses_1',
      kind: 'web',
      title: 'Sample article',
      sourceUrl: 'https://example.com/a',
      textAssetId: 'materials/ses_1/mat_web/text.md',
      rawAssetId: null,
      textChars: 42,
      derivedFrom: null,
      extraction: { status: 'done', attempts: 0 },
      createdAt: new Date(0).toISOString(),
      ...overrides,
    },
  };
}

function entry(overrides: Partial<OwnerMaterialEntry>): ResolvedMaterial {
  return {
    origin: 'owner',
    entry: {
      id: 'src_lesson',
      ownerId: 'user:alice',
      kind: 'source',
      derivedFrom: null,
      mime: 'application/pdf',
      bytes: 3,
      originalName: 'lesson.pdf',
      ossKey: 'objects/secret-key',

      assetId: 'ast_secret_pool',
      sha256: 'digest',
      status: 'ready',
      extraction: { status: 'running' },
      createdAt: 0,
      deletedAt: null,
      folderId: null,
      displayName: null,
      extractionError: null,
      extractionResult: null,
      lineage: null,
      ...overrides,
    },
  };
}

describe('materialsPromptBlock', () => {
  const sets: Record<string, readonly ResolvedMaterial[]> = {
    none: [],
    derivatives: [
      entry({ id: 'src_first' }),
      ...Array.from({ length: 100 }, (_, i) =>
        entry({
          id: `img_${i}`,
          kind: 'image',
          derivedFrom: 'src_first',
          extraction: null,
        }),
      ),
      entry({ id: 'src_second', originalName: 'second.pdf' }),
      row({ id: 'mat_legacy', kind: 'source', title: 'legacy.pdf', textAssetId: null }),
    ],
    mixed: [
      row({}),
      row({ id: 'mat_copy', kind: 'source', title: 'old copy.pdf', textAssetId: null }),
      entry({}),
      entry({
        id: 'img_1',
        kind: 'image',
        derivedFrom: 'src_lesson',
        originalName: 'lesson.pdf at page 2',
        extraction: null,
      }),
      entry({ id: 'src_deck', originalName: 'deck.pptx', mime: null, displayName: 'Week 1' }),
    ],
    extractionIdle: [entry({ extraction: { status: 'idle' } })],
    extractionDone: [entry({ extraction: { status: 'done' } })],
    injected: [
      entry({
        id: 'src_0',
        originalName: `line one\n## Injected heading\n${'x'.repeat(300)}`,
      }),
    ],
  };

  it('is byte-identical for every material set', () => {
    const baseline = materialsPromptBlock(sets.none!);
    for (const [name, materials] of Object.entries(sets)) {
      expect(materialsPromptBlock(materials), name).toBe(baseline);
    }
  });

  it('teaches the knowledge base to a conversation with nothing attached', () => {
    const prompt = materialsPromptBlock([]);
    expect(prompt).toContain('## Materials and the knowledge base');
    expect(prompt).toContain('`list_materials` lists what this conversation has');
    expect(prompt).toContain("scope: 'library'");
    expect(prompt).toContain(
      "`read_material`, `search_material`, `extract_material`, `wait_for_materials` and `use_material_media` take `scope: 'library'` too",
    );
    expect(prompt).toContain(
      'Every other tool, PowerPoint import included, reaches only what is attached.',
    );
    expect(prompt).not.toContain('Every material tool takes');
    expect(prompt).toContain(
      'call `extract_material` with its id, then `wait_for_materials`, then `read_material` with the same id',
    );
    expect(prompt).toContain('`revision`');
    expect(prompt).toContain('Read a `web` material directly');
    expect(prompt).toContain('read through the `extraction` material');
    expect(prompt).toContain('import_pptx');
    expect(prompt).toContain('layout-preserving');
    for (const tool of [
      'list_material_folders',
      'create_material_folder',
      'rename_material_folder',
      'move_materials',
      'rename_material',
      'use_material_media',
      'search_material',
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toContain('you cannot delete');
    expect(prompt).toContain('use those words with the user as they are');
    expect(prompt).not.toContain('Nothing is attached');
    expect(prompt).not.toContain('Attached to this conversation');
    expect(prompt).not.toContain('read_material` on the resulting extraction');
  });

  it('does not copy names, ids, counts, extraction status, or secrets into the block', () => {
    const prompt = materialsPromptBlock(sets.mixed!);
    for (const leaked of [
      'Sample article',
      'old copy.pdf',
      'lesson.pdf',
      'Week 1',
      'src_lesson',
      'src_deck',
      'mat_web',
      'mat_copy',
      'img_1',
      'extraction running',
      '100 derivatives',
      '1 derivative',
      'secret',
      'ast_',
      'objects/',
      'textAssetId',
      'sourceUrl',
      'digest',
      '\n## Injected heading',
    ]) {
      expect(prompt, leaked).not.toContain(leaked);
    }
    expect(materialsPromptBlock(sets.injected!)).toBe(prompt);
    expect(materialsPromptBlock(sets.extractionIdle!)).toBe(
      materialsPromptBlock(sets.extractionDone!),
    );
  });
});
