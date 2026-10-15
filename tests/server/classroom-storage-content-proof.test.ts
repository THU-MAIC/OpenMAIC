import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRequirements } from '@openmaic/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  ClassroomContentReviewError,
  matchesClassroomContentProof,
  reviewClassroomContent,
  type ClassroomContentProof,
  type ClassroomReviewPacket,
} from '@/lib/server/classroom-content-review';
import { persistClassroom } from '@/lib/server/classroom-storage';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  readFile: vi.fn(),
  prepareClassroomAudioAssets: vi.fn(),
  persistClassroomAudioAssets: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  promises: {
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
    rename: mocks.rename,
    rm: mocks.rm,
    readFile: mocks.readFile,
  },
}));
vi.mock('@/lib/server/classroom-audio-import', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-audio-import')>()),
  prepareClassroomAudioAssets: mocks.prepareClassroomAudioAssets,
  persistClassroomAudioAssets: mocks.persistClassroomAudioAssets,
}));

const order: string[] = [];
function source(): UserRequirements {
  return {
    requirement: 'Explain the actual echo program.',
    codeContextRequired: true,
    codemateSource: {
      title: 'Echo',
      content: 'Read one token, then print it with a newline.\n',
      code: 'token = input()\nprint(token)\n',
      correctedCode: 'token = input()\nprint(token)\n',
      language: 'Python',
      referenceValidation: { status: 'unknown', scope: 'test_fixture_no_judge' },
    },
  };
}
function material(): { stage: Stage; scenes: Scene[] } {
  const stage: Stage = { id: 'storage-proof-fixture', name: 'Echo', createdAt: 1, updatedAt: 1 };
  const scenes: Scene[] = [
    {
      id: 'scene',
      stageId: stage.id,
      type: 'slide',
      title: 'Echo behavior',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            themeColors: ['#000000'],
            fontColor: '#000000',
            fontName: 'Arial',
            backgroundColor: '#ffffff',
          },
          elements: [],
        },
      },
      actions: [
        { id: 'speech', type: 'speech', text: 'Read the token and print it with a newline.' },
      ],
    },
  ];
  return { stage, scenes };
}
const bindingReview = async (packet: ClassroomReviewPacket): Promise<string> =>
  JSON.stringify({
    review_version: packet.binding.reviewVersion,
    content_pass: true,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
    reviewed_scene_ids: packet.binding.sceneIds,
    findings: [],
  });
async function checkedMaterial() {
  const requirements = source();
  const checked = await reviewClassroomContent({
    requirements,
    material: material(),
    callbacks: { review: bindingReview },
  });
  return { requirements, ...checked };
}
function validator(requirements: UserRequirements, proof: ClassroomContentProof) {
  return vi.fn((candidate: { stage: Stage; scenes: Scene[] }) => {
    order.push('validate');
    if (!matchesClassroomContentProof(requirements, candidate, proof)) {
      throw new ClassroomContentReviewError('binding_mismatch');
    }
  });
}

// The real storage and real proof-binding functions run. Provider review is a
// deterministic callback, and fs/audio normalizer are mocked. This checks the
// write boundary only, not model facts, real audio assets or persistent bytes.
describe('classroom storage final content boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    order.length = 0;
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockImplementation(async () => {
      order.push('write');
    });
    mocks.rename.mockImplementation(async () => {
      order.push('rename');
    });
    mocks.rm.mockResolvedValue(undefined);
    mocks.prepareClassroomAudioAssets.mockReturnValue([]);
    mocks.persistClassroomAudioAssets.mockImplementation(async () => {
      order.push('normalize');
    });
  });

  it('rejects audio normalization that changes teaching text before any atomic document write', async () => {
    const checked = await checkedMaterial();
    mocks.persistClassroomAudioAssets.mockImplementation(
      async (_assets, _dir, _url, scenes: Scene[]) => {
        order.push('normalize');
        const speech = scenes[0].actions![0];
        if (speech.type !== 'speech') throw new Error('fixture speech missing');
        speech.text = 'Changed teaching content after review';
      },
    );
    const validate = validator(checked.requirements, checked.proof);
    await expect(
      persistClassroom({ id: checked.material.stage.id, ...checked.material }, 'http://localhost', {
        contentReview: checked.proof,
        validateBeforeWrite: validate,
      }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' });
    expect(order).toEqual(['normalize', 'validate']);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(checked.material.scenes[0].actions![0]).toHaveProperty(
      'text',
      'Read the token and print it with a newline.',
    );
  });

  it('allows only speech audio-reference normalization and stores the original trusted bound proof', async () => {
    const checked = await checkedMaterial();
    mocks.persistClassroomAudioAssets.mockImplementation(
      async (_assets, _dir, _url, scenes: Scene[]) => {
        order.push('normalize');
        Object.assign(scenes[0].actions![0], {
          audioId: 'ast_fixture',
          audioUrl: '/api/classroom-media/storage-proof-fixture/audio/ast_fixture.mp3',
          audioInvalidated: false,
        });
      },
    );
    const validate = validator(checked.requirements, checked.proof);
    const persisted = await persistClassroom(
      { id: checked.material.stage.id, ...checked.material },
      'http://localhost',
      {
        contentReview: checked.proof,
        validateBeforeWrite: validate,
      },
    );
    expect(order).toEqual(['normalize', 'validate', 'write', 'rename']);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(
      matchesClassroomContentProof(
        checked.requirements,
        { stage: persisted.stage, scenes: persisted.scenes },
        persisted.contentReview,
      ),
    ).toBe(true);
    expect(persisted.contentReview).toBe(checked.proof);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    const [temporaryPath, bytes] = mocks.writeFile.mock.calls[0];
    expect(temporaryPath).toMatch(/storage-proof-fixture\.json\.\d+\.\d+\.tmp$/);
    const written = JSON.parse(bytes);
    expect(written.contentReview).toEqual(checked.proof);
    expect(written.scenes[0].actions[0].audioUrl).toContain('/api/classroom-media/');
    expect(written.scenes[0].actions[0].text).toBe('Read the token and print it with a newline.');
    expect(mocks.rename.mock.calls[0][0]).toBe(temporaryPath);
    expect(mocks.rename.mock.calls[0][1]).toMatch(/storage-proof-fixture\.json$/);
    expect(checked.material.scenes[0].actions![0]).not.toHaveProperty('audioUrl');
  });

  it('ignores a client-shaped top-level proof unless supplied through trusted server options', async () => {
    const checked = await checkedMaterial();
    const data = {
      id: checked.material.stage.id,
      ...checked.material,
      contentReview: checked.proof,
    };
    const persisted = await persistClassroom(data, 'http://localhost');
    expect(persisted).not.toHaveProperty('contentReview');
    expect(JSON.parse(mocks.writeFile.mock.calls[0][1])).not.toHaveProperty('contentReview');
  });

  it('rejects an already aborted write before audio normalization, references or filesystem calls', async () => {
    const doc = material(),
      controller = new AbortController();
    controller.abort();
    const validate = vi.fn();
    await expect(
      persistClassroom({ id: doc.stage.id, ...doc }, 'http://localhost', {
        signal: controller.signal,
        validateBeforeWrite: validate,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(doc.scenes[0].actions![0]).not.toHaveProperty('audioId');
    expect(doc.scenes[0].actions![0]).not.toHaveProperty('audioUrl');
  });

  it('does not rename a temporary document or expose a completed reference when cancelled during write', async () => {
    const checked = await checkedMaterial(),
      controller = new AbortController();
    const validate = validator(checked.requirements, checked.proof);
    mocks.writeFile.mockImplementation(async (_path, _bytes, writeOptions) => {
      order.push('write');
      expect(writeOptions.signal).toBe(controller.signal);
      controller.abort();
      // Simulate a write resolving after its signal fired; real storage must
      // recheck cancellation before the atomic rename, even for late success.
    });
    await expect(
      persistClassroom({ id: checked.material.stage.id, ...checked.material }, 'http://localhost', {
        signal: controller.signal,
        contentReview: checked.proof,
        validateBeforeWrite: validate,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(order).toEqual(['normalize', 'validate', 'write']);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0][0], { force: true });
    expect(checked.material.scenes[0].actions![0]).not.toHaveProperty('audioUrl');
  });
});
