/**
 * The materials prompt block (RFC #1716 §4): one flow -- extract, wait, read
 * the same id -- for a conversation with nothing attached as for one with
 * session rows and linked sources together; safe metadata only.
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
  it('teaches the knowledge base to a conversation with nothing attached', () => {
    const prompt = materialsPromptBlock([]);
    expect(prompt).toContain('## Materials and the knowledge base');
    expect(prompt).toContain('Nothing is attached to this conversation yet.');
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
    expect(prompt).not.toContain('import_pptx');
  });

  it('names what a mixed conversation has, and reads every kind the right way', () => {
    const prompt = materialsPromptBlock([
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
    ]);
    expect(prompt).toContain('- "Sample article" (web, id mat_web)');
    expect(prompt).toContain('- "old copy.pdf" (source, id mat_copy)');
    expect(prompt).toContain(
      '- "lesson.pdf" (knowledge-base source, id src_lesson, extraction running)',
    );
    expect(prompt).toContain('- "lesson.pdf at page 2" (image of src_lesson, id img_1)');
    expect(prompt).toContain('- "Week 1" (knowledge-base source, id src_deck');
    expect(prompt).toContain('A `web` material was already fetched and extracted');
    expect(prompt).toContain('read through the `extraction` material');
    expect(prompt).toContain('import_pptx');
    // The old flow told the agent to go and find a new extraction id.
    expect(prompt).not.toContain('read_material` on the resulting extraction');
    // Safe metadata only.
    expect(prompt).not.toMatch(/secret|ast_|objects\/|textAssetId|sourceUrl|digest/);
  });

  it('keeps names to one short line and the list to thirty entries', () => {
    const many = Array.from({ length: 32 }, (_, index) =>
      entry({ id: `src_${index}`, originalName: `file ${index}.pdf` }),
    );
    many[0] = entry({
      id: 'src_0',
      originalName: `line one\n## Injected heading\n${'x'.repeat(300)}`,
    });
    const prompt = materialsPromptBlock(many);
    expect(prompt).not.toContain('\n## Injected heading');
    expect(prompt).toContain('line one ## Injected heading');
    expect(prompt).toContain('…');
    expect(prompt).toContain('src_29');
    expect(prompt).not.toContain('src_30,');
    expect(prompt).toContain('…and 2 more; call `list_materials` to see them all.');
  });
});
