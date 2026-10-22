/**
 * The consumers of original bytes on a linked library source (RFC #1716 §4):
 * `import_pptx`, `clip_audio` and `use_material_media` each run to success
 * on a material attached by id, through the production resolver and readers
 * over PGlite. Only what lies outside the material library is faked: the
 * PPTX parser and the ffmpeg clip.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { PPTTextElement, Slide } from '@openmaic/dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { attachOwnerMaterialsToSession } from '@/lib/persistence/session-material-links';
import {
  buildDslCourseToolset,
  type CourseDocument,
  type CourseStore,
} from '@/lib/server/agent-runtime/course-tools';
import { IMPORT_PPTX_TOOL_NAME, PPTX_MIME } from '@/lib/server/agent-runtime/import-pptx';
import { buildMaterialMediaTool } from '@/lib/server/agent-runtime/material-media';
import { getSessionMaterial } from '@/lib/server/agent-runtime/session-materials';
import { buildVoiceCloneTools } from '@/lib/server/agent-runtime/voice-clone-tools';
import type { Scene } from '@/lib/types/stage';

import {
  ACCOUNT,
  bootLibraryHarness,
  seedPoolSource,
  seedSession,
  type ExtractionScenarioPool,
  type LibraryHarness,
} from '../persistence/_material-library-scenarios';

class PGlitePool implements ExtractionScenarioPool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

function stageStore(): CourseStore {
  let doc: CourseDocument | null = {
    stage: {
      id: 'stage-import',
      name: 'Lesson',
      agentIds: [],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as CourseDocument['stage'],
    scenes: [],
    outline: {
      outlines: [],
      requirement: 'Lesson',
      generationComplete: false,
      producer: 'server-job',
      createdAt: 1,
      updatedAt: 1,
    } satisfies AppDocumentOutline,
  };
  return {
    async loadDocument() {
      return doc;
    },
    async saveDocument(next: CourseDocument) {
      doc = next;
    },
    async putScene(_stageId: string, scene: Scene) {
      if (!doc) throw new Error('no document');
      doc = { ...doc, scenes: [...doc.scenes.filter((item) => item.id !== scene.id), scene] };
    },
  } as unknown as CourseStore;
}

function slide(id: string): Slide {
  return {
    id,
    viewportSize: 1280,
    viewportRatio: 0.5625,
    theme: {
      backgroundColor: '#ffffff',
      themeColors: ['#2563eb'],
      fontColor: '#111827',
      fontName: 'Inter',
    },
    elements: [
      {
        id: `${id}-title`,
        type: 'text',
        left: 40,
        top: 40,
        width: 800,
        height: 80,
        rotate: 0,
        content: '<p>Cells</p>',
        defaultFontName: 'Inter',
        defaultColor: '#111',
      } as PPTTextElement,
    ],
  };
}

/** A 24 kHz mono PCM16 WAV: the clip contract the voice tools enforce. */
function wav(seconds = 2): Buffer {
  const sampleRate = 24_000;
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  return out;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
};

// Real pool reads and a document import over PGlite: generous under a loaded
// machine.
describe('consumers of a linked library source (PGlite)', { timeout: 20_000 }, () => {
  let db: PGlite | undefined;

  async function boot(): Promise<LibraryHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://library-consumers-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    const h = await bootLibraryHarness(new PGlitePool(db), databaseUrl);
    await seedSession(h, 'ses-1');
    return h;
  }

  const attach = (h: LibraryHarness, ids: string[]) =>
    attachOwnerMaterialsToSession(h.provider, {
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      materialIds: ids,
    });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
  });

  it('imports a linked .pptx, and a copy of the same file reuses its receipt', async () => {
    const h = await boot();
    const deck = Buffer.from('fake-pptx-bytes');
    await seedPoolSource(h, 'src-deck', deck, PPTX_MIME);
    await attach(h, ['src-deck']);
    // A copy of the same file under another id, as the binder made before links.
    const copyKey = `materials/ses-1/mat_copy/raw.${Buffer.from(PPTX_MIME).toString('base64url')}`;
    h.objects.set(copyKey, deck);
    await h.pool.query(
      `INSERT INTO agent_session_materials
         (id, session_id, kind, title, raw_asset_id, text_chars, extraction_status)
       VALUES ('mat_copy', 'ses-1', 'source', 'deck.pptx', $1, 0, 'idle')`,
      [copyKey],
    );

    const store = stageStore();
    const parsePptx = vi.fn(async () => [slide('s1'), slide('s2')]);
    const tool = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'owned' as const }),
      store,
      sessionId: 'ses-1',
      onCheckpoint: () => {},
      parsePptx,
    }).find((candidate) => candidate.name === IMPORT_PPTX_TOOL_NAME)!;

    const first = (await tool.execute('call-1', {
      stageId: 'stage-import',
      materialId: 'src-deck',
    } as never)) as ToolResult;
    expect(first.isError).toBeUndefined();
    expect(first.details).toMatchObject({ materialId: 'src-deck', pages: 2 });
    expect((await store.loadDocument('stage-import'))!.scenes).toHaveLength(2);

    // Same bytes, other id: the digest receipt reports the earlier import.
    const again = (await tool.execute('call-2', {
      stageId: 'stage-import',
      materialId: 'mat_copy',
    } as never)) as ToolResult;
    expect(again.content[0]!.text).toContain('already imported');
    expect((await store.loadDocument('stage-import'))!.scenes).toHaveLength(2);
    expect(parsePptx).toHaveBeenCalledTimes(1);
  });

  it('clips a linked audio source into a session audio-track', async () => {
    const h = await boot();
    const audio = Buffer.from('fake-mp3-bytes');
    await seedPoolSource(h, 'src-talk', audio, 'audio/mpeg');
    await attach(h, ['src-talk']);

    const clipAudio = vi.fn(async () => wav());
    const clip = buildVoiceCloneTools({ sessionId: 'ses-1', clipAudio }).find(
      (candidate) => candidate.name === 'clip_audio',
    )!;
    const result = (await clip.execute('call', {
      materialId: 'src-talk',
      startSec: 0,
      endSec: 2,
    } as never)) as ToolResult;

    expect(clipAudio).toHaveBeenCalledWith(audio, expect.any(String), 0, 2);
    const clipId = result.details.clipId as string;
    expect(await getSessionMaterial('ses-1', clipId)).toMatchObject({
      kind: 'audio-track',
      title: 'src-talk.bin clip',
    });
  });

  it('copies a linked image into the course as a new pending entry', async () => {
    const h = await boot();
    const image = Buffer.from('fake-png-bytes');
    await seedPoolSource(h, 'src-img', image, 'image/png');
    await attach(h, ['src-img']);

    const media = buildMaterialMediaTool({ sessionId: 'ses-1', ownerId: ACCOUNT });
    const result = (await media.execute('call', {
      materialId: 'src-img',
      stageId: 'stage-1',
    } as never)) as ToolResult;

    expect(result.isError).toBeUndefined();
    const src = result.details.src as string;
    expect(src).toMatch(/^ast_/);
    expect(result.details).toMatchObject({
      materialId: 'src-img',
      mimeType: 'image/png',
      bytes: image.byteLength,
    });
    const read = await h.provider.assetStore.resolve(assetPrincipalForOwner(ACCOUNT), src);
    expect(Buffer.from(read!.bytes)).toEqual(image);
  });

  it('refuses a stage the run cannot write, before reading the material', async () => {
    const h = await boot();
    await seedPoolSource(h, 'src-img', Buffer.from('fake-png-bytes'), 'image/png');
    await attach(h, ['src-img']);

    const media = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'foreign' as const }),
      store: stageStore(),
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      onCheckpoint: () => {},
    }).find((candidate) => candidate.name === 'use_material_media')!;
    const result = (await media.execute('call', {
      materialId: 'src-img',
      stageId: 'stage-other',
    } as never)) as ToolResult;

    expect(result.isError).toBe(true);
    const entries = await h.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM asset_entries',
    );
    // Only the upload's own entry.
    expect(Number(entries.rows[0]!.count)).toBe(1);
  });

  it('reports a full asset store to the model without a fallback write', async () => {
    const h = await boot();
    await seedPoolSource(h, 'src-img', Buffer.from('fake-png-bytes'), 'image/png');
    await attach(h, ['src-img']);
    const media = buildMaterialMediaTool({
      sessionId: 'ses-1',
      ownerId: ACCOUNT,
      storeAsset: async () => ({ status: 'refused', reason: 'storage-full' }),
    });
    const result = (await media.execute('call', {
      materialId: 'src-img',
      stageId: 'stage-1',
    } as never)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ materialId: 'src-img', status: 'storage-full' });
  });

  it('reports a linked .pptx whose bytes are unavailable as unavailable, not as another type', async () => {
    const h = await boot();
    await seedPoolSource(h, 'src-deck', Buffer.from('fake-pptx-bytes'), PPTX_MIME);
    await attach(h, ['src-deck']);
    // The entry is gone and the row has no old object to fall back to.
    await h.pool.query('DELETE FROM asset_root_refs');
    await h.pool.query('DELETE FROM asset_entries');

    const tool = buildDslCourseToolset({
      stageAccess: async () => ({ kind: 'owned' as const }),
      store: stageStore(),
      sessionId: 'ses-1',
      onCheckpoint: () => {},
    }).find((candidate) => candidate.name === IMPORT_PPTX_TOOL_NAME)!;
    const result = (await tool.execute('call', {
      stageId: 'stage-import',
      materialId: 'src-deck',
    } as never)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ status: 'unavailable', materialId: 'src-deck' });
  });
});
