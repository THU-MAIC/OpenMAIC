import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DocumentWriteRefusedError } from '@openmaic/storage';
import type { PPTImageElement, SlideContent } from '@openmaic/dsl';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { AppScene, GeneratedAgentConfig, PBLContent, Stage } from '@/lib/types/stage';
import type { DiscussionAction, SpeechAction } from '@/lib/types/action';
import { CREATE_REFUSED } from '@/lib/persistence/owner-bound-document-store';

import { createFakeDocumentStore } from './_fake-document-store';
import { FIXED_NOW, makeSlideScene } from './_stage-fixtures';

const mocks = vi.hoisted(() => ({
  persistenceConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
  resolveStageAccess: vi.fn(),
  resolveOwnedAsset: vi.fn(),
  storeGeneratedAsset: vi.fn(),
  releasePending: vi.fn(),
  classroomsDir: '',
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => mocks.persistenceConfigured,
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(
    mocks.resolveRequestOwnerId,
  ),
);

vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: async () => mocks.fakeStore!.store,
  getBackgroundDocumentStore: async () => mocks.fakeStore!.store,
}));

vi.mock('@/lib/server/stage-access', () => ({
  resolveStageAccess: (...args: unknown[]) => mocks.resolveStageAccess(...args),
}));

vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveOwnedAsset: (...args: unknown[]) => mocks.resolveOwnedAsset(...args),
}));

vi.mock('@/lib/server/store-generated-asset', () => ({
  storeGeneratedAsset: (...args: unknown[]) => mocks.storeGeneratedAsset(...args),
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    assetStore: {
      releasePending: mocks.releasePending,
    },
    pool: {},
  }),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    get CLASSROOMS_DIR() {
      return mocks.classroomsDir;
    },
  };
});

import { POST, _resetCopyLimitsForTesting } from '@/app/api/stages/[id]/copy/route';

const SOURCE_STAGE_ID = 'stage-source-1';
const COPIER_OWNER = 'user:copier';
const SOURCE_OWNER = 'user:creator';

type NextInit = ConstructorParameters<typeof NextRequest>[1];

function callCopy(id = SOURCE_STAGE_ID, init: NextInit = {}) {
  const { headers, ...restInit } = init;
  const req = new NextRequest(`http://localhost/api/stages/${id}/copy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
      'x-user-locale': 'en-US',
      ...((headers as Record<string, string>) ?? {}),
    },
    ...restInit,
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

function slideElements(scene: AppScene): PPTImageElement[] {
  return ((scene.content as SlideContent).canvas.elements ?? []) as PPTImageElement[];
}

function makeImageElement(id: string, src: string): PPTImageElement {
  return {
    id,
    type: 'image',
    src,
    width: 100,
    height: 100,
    left: 0,
    top: 0,
    fixedRatio: true,
    rotate: 0,
  };
}

function createSourceDocument(stageId = SOURCE_STAGE_ID): AppDocument {
  const scene1 = makeSlideScene('scene-src-1', stageId, 1, 'Intro');
  scene1.multiAgent = {
    enabled: true,
    agentIds: ['agent-teacher-1', 'agent-student-1'],
    directorPrompt: 'Engage discussion',
  };
  const speech1: SpeechAction & { agentId?: string } = {
    id: 'act-speech-1',
    type: 'speech',
    text: 'Welcome to this lesson!',
    agentId: 'agent-teacher-1',
    audioId: 'ast_source_audio_1',
  };
  scene1.actions = [speech1];
  (scene1.content as SlideContent).canvas.elements.push(
    makeImageElement('el-img-1', 'ast_source_img_1'),
  );

  const scene2 = makeSlideScene('scene-src-2', stageId, 2, 'Deep Dive');
  const discussion2: DiscussionAction = {
    id: 'act-disc-2',
    type: 'discussion',
    topic: 'Questions?',
    agentId: 'agent-student-1',
  };
  scene2.actions = [discussion2];
  // Repeated reference to ast_source_img_1 to test deduplication
  (scene2.content as SlideContent).canvas.elements.push(
    makeImageElement('el-img-2', 'ast_source_img_1'),
  );
  // External media reference
  (scene2.content as SlideContent).canvas.elements.push(
    makeImageElement('el-img-ext', 'https://cdn.example.com/external-photo.png'),
  );

  const teacherConfig: GeneratedAgentConfig = {
    id: 'agent-teacher-1',
    name: 'Dr. Smith',
    role: 'teacher',
    persona: 'Professor',
    avatar: '👨‍🏫',
    color: '#3b82f6',
    priority: 1,
  };
  const studentConfig: GeneratedAgentConfig = {
    id: 'agent-student-1',
    name: 'Alice',
    role: 'student',
    persona: 'Student',
    avatar: '👩‍🎓',
    color: '#10b981',
    priority: 2,
  };

  return {
    stage: {
      id: stageId,
      name: 'Introduction to Physics',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      agentIds: ['agent-teacher-1', 'agent-student-1'],
      generatedAgentConfigs: [teacherConfig, studentConfig],
      videoManifest: {
        ast_source_video_1: { prompt: 'Wave animation' } as unknown as NonNullable<
          Stage['videoManifest']
        >[string],
      },
    },
    scenes: [scene1, scene2],
    outline: {
      outlines: [
        {
          id: 'scene-src-1',
          type: 'slide',
          title: 'Intro',
          order: 1,
          description: 'Intro',
          keyPoints: [],
        },
        {
          id: 'scene-src-2',
          type: 'slide',
          title: 'Deep Dive',
          order: 2,
          description: 'Deep dive',
          keyPoints: [],
        },
      ],
      requirement: 'Teach Physics',
      generationComplete: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    },
  };
}

let tempDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  _resetCopyLimitsForTesting();

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-copy-test-'));
  mocks.classroomsDir = tempDir;

  mocks.persistenceConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue(COPIER_OWNER);

  mocks.fakeStore = createFakeDocumentStore();
  (
    mocks.fakeStore.store as unknown as { createDocument: (doc: AppDocument) => Promise<void> }
  ).createDocument = async (doc: AppDocument) => mocks.fakeStore!.store.saveDocument(doc);

  const sourceDoc = createSourceDocument(SOURCE_STAGE_ID);
  mocks.fakeStore.docs.set(SOURCE_STAGE_ID, sourceDoc);

  mocks.resolveStageAccess.mockResolvedValue({
    stageId: SOURCE_STAGE_ID,
    ownerId: SOURCE_OWNER,
    name: 'Introduction to Physics',
    isPublic: true,
    publishedAt: FIXED_NOW,
    generationComplete: true,
    source: 'document',
    deletedAt: null,
  });

  let assetCounter = 0;
  mocks.storeGeneratedAsset.mockImplementation(
    async (input: { bytes: Buffer; mimeType: string }) => {
      assetCounter += 1;
      return {
        status: 'allocated',
        assetId: `ast_copied_${assetCounter}`,
        byteLength: input.bytes.byteLength,
      };
    },
  );

  mocks.resolveOwnedAsset.mockImplementation(async (assetId: string) => {
    if (assetId.startsWith('ast_source_')) {
      return {
        status: 'resolved',
        buffer: Buffer.from(`bytes-of-${assetId}`),
        mimeType: assetId.includes('audio') ? 'audio/mpeg' : 'image/png',
      };
    }
    return { status: 'missing' };
  });

  mocks.releasePending.mockResolvedValue(undefined);
});

afterEach(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('POST /api/stages/[id]/copy', () => {
  it('successfully copies a course with new IDs, rewritten references, and localized (copy) suffix', async () => {
    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { id: string };
    expect(data).toHaveProperty('id');
    const newStageId = data.id;
    expect(newStageId).toMatch(/^stage-/);
    expect(newStageId).not.toBe(SOURCE_STAGE_ID);

    // Verify stored document in copier's store
    const stored = mocks.fakeStore!.docs.get(newStageId);
    expect(stored).toBeDefined();
    expect(stored!.stage.name).toBe('Introduction to Physics (copy)');
    const outline = stored!.outline as { generationComplete?: boolean; outlines: { id: string }[] };
    expect(outline.generationComplete).toBe(true);

    // Verify agent IDs were minted fresh and consistently rewritten
    const newAgentIds = stored!.stage.agentIds!;
    expect(newAgentIds).toHaveLength(2);
    expect(newAgentIds).not.toContain('agent-teacher-1');
    expect(newAgentIds).not.toContain('agent-student-1');

    const teacherConfig = stored!.stage.generatedAgentConfigs!.find((c) => c.name === 'Dr. Smith')!;
    const studentConfig = stored!.stage.generatedAgentConfigs!.find((c) => c.name === 'Alice')!;
    expect(teacherConfig.id).toBe(newAgentIds[0]);
    expect(studentConfig.id).toBe(newAgentIds[1]);

    // Scene 1 agent references
    const newScene1 = stored!.scenes[0]!;
    expect(newScene1.stageId).toBe(newStageId);
    expect(newScene1.id).not.toBe('scene-src-1');
    expect(newScene1.multiAgent?.agentIds).toEqual([teacherConfig.id, studentConfig.id]);
    const speech1 = newScene1.actions![0] as SpeechAction & { agentId?: string };
    expect(speech1.agentId).toBe(teacherConfig.id);

    // Scene 2 agent references
    const newScene2 = stored!.scenes[1]!;
    expect(newScene2.stageId).toBe(newStageId);
    expect(newScene2.id).not.toBe('scene-src-2');
    const discussion2 = newScene2.actions![0] as DiscussionAction;
    expect(discussion2.agentId).toBe(studentConfig.id);

    // Outlines rewritten with new scene IDs
    expect(outline.outlines[0]!.id).toBe(newScene1.id);
    expect(outline.outlines[1]!.id).toBe(newScene2.id);
  });

  it('deduplicates repeated media references and copies them independently', async () => {
    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(200);
    const { id: newStageId } = (await res.json()) as { id: string };

    const stored = mocks.fakeStore!.docs.get(newStageId)!;
    const scene1 = stored.scenes[0]!;
    const scene2 = stored.scenes[1]!;

    const img1Ref = slideElements(scene1)[0]!.src;
    const img2Ref = slideElements(scene2)[0]!.src;

    // Both scenes referenced ast_source_img_1; they must now point to the SAME new asset ID
    expect(img1Ref).toMatch(/^ast_copied_/);
    expect(img2Ref).toBe(img1Ref);

    // External media URL remained unchanged
    const extImgRef = slideElements(scene2)[1]!.src;
    expect(extImgRef).toBe('https://cdn.example.com/external-photo.png');

    // Speech audio was also copied and rewritten
    const speechAudio = (scene1.actions![0] as SpeechAction).audioId;
    expect(speechAudio).toMatch(/^ast_copied_/);
    expect(speechAudio).not.toBe('ast_source_audio_1');
  });

  it('copied course remains fully usable and intact after the original course is deleted', async () => {
    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(200);
    const { id: newStageId } = (await res.json()) as { id: string };

    // Now delete the original course and its assets from the fake store
    mocks.fakeStore!.docs.delete(SOURCE_STAGE_ID);
    mocks.resolveStageAccess.mockResolvedValue(null);

    // The copied course is completely intact in the store
    const copied = mocks.fakeStore!.docs.get(newStageId);
    expect(copied).toBeDefined();
    expect(copied!.stage.id).toBe(newStageId);
    expect(copied!.scenes).toHaveLength(2);

    const img1Ref = slideElements(copied!.scenes[0]!)[0]!.src;
    expect(img1Ref).toMatch(/^ast_copied_/);
  });

  it('independently copies legacy /api/classroom-media/<id>/... files from disk', async () => {
    // Create legacy media files in temp classrooms dir
    const legacyCourseDir = path.join(tempDir, SOURCE_STAGE_ID);
    await fs.mkdir(path.join(legacyCourseDir, 'media'), { recursive: true });
    await fs.mkdir(path.join(legacyCourseDir, 'audio'), { recursive: true });
    await fs.writeFile(path.join(legacyCourseDir, 'media', 'chart.png'), Buffer.from('png-bytes'));
    await fs.writeFile(path.join(legacyCourseDir, 'audio', 'voice.mp3'), Buffer.from('mp3-bytes'));

    // Add legacy media references to source document
    const sourceDoc = mocks.fakeStore!.docs.get(SOURCE_STAGE_ID)!;
    slideElements(sourceDoc.scenes[0]!).push(
      makeImageElement('legacy-img-el', `/api/classroom-media/${SOURCE_STAGE_ID}/media/chart.png`),
    );
    const legacySpeech: SpeechAction & { audioUrl?: string } = {
      id: 'legacy-speech-1',
      type: 'speech',
      text: 'Legacy speech',
      audioUrl: `/api/classroom-media/${SOURCE_STAGE_ID}/audio/voice.mp3`,
    };
    sourceDoc.scenes[0]!.actions!.push(legacySpeech);

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(200);
    const { id: newStageId } = (await res.json()) as { id: string };

    const stored = mocks.fakeStore!.docs.get(newStageId)!;
    const scene1 = stored.scenes[0]!;

    const legacyEl = slideElements(scene1).find((el) => el.id === 'legacy-img-el')!;
    expect(legacyEl.src).toMatch(/^ast_copied_/);
    expect(legacyEl.src).not.toContain('/api/classroom-media/');

    const copiedSpeech = scene1.actions!.find(
      (a) => a.type === 'speech' && (a as SpeechAction).text === 'Legacy speech',
    ) as SpeechAction & { audioUrl?: string };
    expect(copiedSpeech.audioId).toMatch(/^ast_copied_/);
    expect(copiedSpeech.audioUrl).toBeUndefined();
  });

  it('refuses courses containing PBL v3 projects with a clear 400 error', async () => {
    const sourceDoc = mocks.fakeStore!.docs.get(SOURCE_STAGE_ID)!;
    sourceDoc.scenes.push({
      id: 'scene-pbl-v3',
      stageId: SOURCE_STAGE_ID,
      title: 'PBL Project',
      order: 3,
      type: 'pbl',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      content: {
        type: 'pbl',
        projectV3: { id: 'greeting-python', version: '1.0.0' },
      } as unknown as PBLContent,
    });

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { errorCode: string; error: string };
    expect(body.errorCode).toBe('INVALID_REQUEST');
    expect(body.error).toContain('PBL v3 projects cannot be copied');
  });

  it('surfaces asset quota refusal as 507 and releases pending allocations', async () => {
    // First allocation succeeds
    mocks.storeGeneratedAsset.mockResolvedValueOnce({
      status: 'allocated',
      assetId: 'ast_copied_first',
    });
    // Second allocation is refused due to full quota
    mocks.storeGeneratedAsset.mockResolvedValueOnce({
      status: 'refused',
      reason: 'storage-full',
    });

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(507);

    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('ASSET_QUOTA_EXCEEDED');
    expect(mocks.releasePending).toHaveBeenCalledWith(
      expect.objectContaining({ key: `owner:${COPIER_OWNER}` }),
      'ast_copied_first',
    );
  });

  it('surfaces course create quota refusal as 403 and releases pending allocations', async () => {
    (mocks.fakeStore!.store as unknown as { createDocument: () => Promise<void> }).createDocument =
      async () => {
        throw new DocumentWriteRefusedError(
          SOURCE_STAGE_ID,
          CREATE_REFUSED,
          'Course creation quota exceeded for your tier.',
        );
      };

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { errorCode: string; error: string };
    expect(body.errorCode).toBe('CREATE_REFUSED');
    expect(body.error).toContain('Course creation quota exceeded');
    expect(mocks.releasePending).toHaveBeenCalled();
  });

  it('refuses total media size exceeding 500 MiB with 413', async () => {
    // Return an asset whose buffer size exceeds 500 MiB
    mocks.resolveOwnedAsset.mockResolvedValueOnce({
      status: 'resolved',
      buffer: { byteLength: 501 * 1024 * 1024 } as Buffer,
      mimeType: 'image/png',
    });

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(413);

    const body = (await res.json()) as { errorCode: string; error: string };
    expect(body.errorCode).toBe('INVALID_REQUEST');
    expect(body.error).toContain('500MB');
  });

  it('returns 404 when server persistence is not configured', async () => {
    mocks.persistenceConfigured = false;
    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(404);
  });

  it('returns 404 when source course is missing', async () => {
    mocks.resolveStageAccess.mockResolvedValue(null);
    const res = await callCopy('stage-missing');
    expect(res.status).toBe(404);
  });

  it('returns 404 when source course is tombstoned (deleted)', async () => {
    mocks.resolveStageAccess.mockResolvedValue({
      stageId: SOURCE_STAGE_ID,
      ownerId: SOURCE_OWNER,
      name: 'Deleted course',
      isPublic: false,
      publishedAt: null,
      generationComplete: true,
      source: 'document',
      deletedAt: new Date(),
    });

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(404);
  });

  it('enforces one copy in flight per owner and returns 429', async () => {
    let finishFirst: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    mocks.storeGeneratedAsset.mockImplementationOnce(async () => {
      await pausePromise;
      return { status: 'allocated', assetId: 'ast_test' };
    });

    // Start first copy (does not await completion)
    const firstPromise = callCopy(SOURCE_STAGE_ID);

    // Fire second copy immediately for same owner
    const secondRes = await callCopy(SOURCE_STAGE_ID);
    expect(secondRes.status).toBe(429);
    const body = (await secondRes.json()) as { errorCode: string };
    expect(body.errorCode).toBe('CONCURRENT_COPY_LIMIT');

    // Unblock first copy and let it finish
    finishFirst!();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);
  });

  it('enforces rate limit per owner and returns 429 when exceeded', async () => {
    // Fire 10 copies successfully
    for (let i = 0; i < 10; i++) {
      const res = await callCopy(SOURCE_STAGE_ID);
      expect(res.status).toBe(200);
    }

    // 11th copy within the same window should be rate limited
    const res11 = await callCopy(SOURCE_STAGE_ID);
    expect(res11.status).toBe(429);
    const body = (await res11.json()) as { errorCode: string };
    expect(body.errorCode).toBe('RATE_LIMITED');
  });

  it('refuses cross-origin or non-JSON requests with 403', async () => {
    const resNoJson = await callCopy(SOURCE_STAGE_ID, {
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(resNoJson.status).toBe(403);

    const resCrossOrigin = await callCopy(SOURCE_STAGE_ID, {
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(resCrossOrigin.status).toBe(403);
  });

  it('truncates title appropriately when (copy) suffix would exceed 120 characters', async () => {
    const longName = 'A'.repeat(118);
    const sourceDoc = mocks.fakeStore!.docs.get(SOURCE_STAGE_ID)!;
    sourceDoc.stage.name = longName;

    const res = await callCopy(SOURCE_STAGE_ID);
    expect(res.status).toBe(200);
    const { id: newStageId } = (await res.json()) as { id: string };

    const stored = mocks.fakeStore!.docs.get(newStageId)!;
    expect(stored.stage.name.length).toBeLessThanOrEqual(120);
    expect(stored.stage.name.endsWith(' (copy)')).toBe(true);
  });

  it('uses locale-specific suffix for different request languages', async () => {
    const resZh = await callCopy(SOURCE_STAGE_ID, {
      headers: { 'x-user-locale': 'zh-CN' },
    });
    expect(resZh.status).toBe(200);
    const { id: zhStageId } = (await resZh.json()) as { id: string };
    expect(mocks.fakeStore!.docs.get(zhStageId)!.stage.name).toBe(
      'Introduction to Physics （副本）',
    );

    const resJa = await callCopy(SOURCE_STAGE_ID, {
      headers: { 'x-user-locale': 'ja-JP' },
    });
    expect(resJa.status).toBe(200);
    const { id: jaStageId } = (await resJa.json()) as { id: string };
    expect(mocks.fakeStore!.docs.get(jaStageId)!.stage.name).toBe(
      'Introduction to Physics （コピー）',
    );
  });
});
