import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function withFreshStorageModule() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'openmaic-recover-test-'));
  tempDirs.push(tmpDir);

  process.chdir(tmpDir);
  vi.resetModules();

  const mod = await import('@/lib/server/classroom-storage');
  return { mod, tmpDir };
}

afterEach(async () => {
  process.chdir(originalCwd);

  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

describe('classroom storage soft-delete recovery', () => {
  it('restores a soft-deleted classroom and clears deleted index entry', async () => {
    const { mod } = await withFreshStorageModule();

    const classroomId = 'recover-case-1';
    const ownerUserId = 'admin-1';

    await mod.persistClassroom(
      {
        id: classroomId,
        stage: {
          id: classroomId,
          name: 'Recover Test',
          ownerUserId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        scenes: [],
      },
      'http://localhost:3000',
    );

    const deleted = await mod.softDeleteClassroom({
      id: classroomId,
      ownerUserId,
      deletedBy: ownerUserId,
    });

    expect(deleted.deleted).toBe(true);
    await expect(mod.readClassroom(classroomId)).resolves.toBeNull();

    const deletedList = await mod.listDeletedClassrooms();
    expect(deletedList.some((entry) => entry.id === classroomId)).toBe(true);

    const restored = await mod.restoreDeletedClassroom(classroomId);
    expect(restored).toMatchObject({ id: classroomId, ownerUserId });

    const active = await mod.readClassroom(classroomId);
    expect(active?.id).toBe(classroomId);

    const deletedListAfterRestore = await mod.listDeletedClassrooms();
    expect(deletedListAfterRestore.some((entry) => entry.id === classroomId)).toBe(false);
  });

  it('returns null when restoring a non-deleted classroom id', async () => {
    const { mod } = await withFreshStorageModule();

    const restored = await mod.restoreDeletedClassroom('missing-id');
    expect(restored).toBeNull();
  });
});
