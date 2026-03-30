import { prisma } from './db';
import { promises as fs } from 'fs';
import path from 'path';
import { CLASSROOMS_DIR, ensureClassroomsDir } from './classroom-storage';

export interface ClassroomIndexEntry {
  id: string;
  title: string;
  language: string;
  createdAt: string;
  sceneCount: number;
  userId?: string;
}

/**
 * Add or update a classroom entry in the DB index.
 */
export async function upsertIndexEntry(entry: ClassroomIndexEntry): Promise<void> {
  if (!entry.userId) return; // Can't index without a user

  await prisma.classroom.upsert({
    where: { id: entry.id },
    update: {
      title: entry.title,
      language: entry.language,
      sceneCount: entry.sceneCount,
    },
    create: {
      id: entry.id,
      userId: entry.userId,
      title: entry.title,
      language: entry.language,
      sceneCount: entry.sceneCount,
      filePath: path.join(CLASSROOMS_DIR, `${entry.id}.json`),
      createdAt: new Date(entry.createdAt),
    },
  });
}

/**
 * Get classrooms for a user (or all for admin), sorted by createdAt desc.
 * Backfills from disk if orphan JSON files exist.
 */
export async function getClassroomIndex(
  userId?: string,
  role?: string,
): Promise<ClassroomIndexEntry[]> {
  // Backfill: scan disk for classroom files not yet in DB
  await backfillOrphans(userId);

  const where = role === 'admin' ? {} : userId ? { userId } : {};
  const rows = await prisma.classroom.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    createdAt: r.createdAt.toISOString(),
    sceneCount: r.sceneCount,
    userId: r.userId,
  }));
}

/**
 * Scan data/classrooms/*.json for files not yet tracked in the DB.
 * Assigns orphans to the given userId (or first admin).
 */
async function backfillOrphans(fallbackUserId?: string): Promise<void> {
  await ensureClassroomsDir();

  let files: string[];
  try {
    files = await fs.readdir(CLASSROOMS_DIR);
  } catch {
    return;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
  if (jsonFiles.length === 0) return;

  const existingIds = new Set(
    (await prisma.classroom.findMany({ select: { id: true } })).map((r) => r.id),
  );

  const orphans = jsonFiles.filter((f) => !existingIds.has(f.replace('.json', '')));
  if (orphans.length === 0) return;

  // Find a user to assign orphans to
  const ownerId =
    fallbackUserId ||
    (await prisma.user.findFirst({ where: { role: 'admin' } }))?.id;
  if (!ownerId) return; // No users yet — skip backfill

  for (const file of orphans) {
    try {
      const raw = await fs.readFile(path.join(CLASSROOMS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);
      const id = data.id || file.replace('.json', '');
      await prisma.classroom.create({
        data: {
          id,
          userId: ownerId,
          title: data.stage?.name || 'Untitled',
          language: data.stage?.language || 'zh-CN',
          sceneCount: Array.isArray(data.scenes) ? data.scenes.length : 0,
          filePath: path.join(CLASSROOMS_DIR, file),
          createdAt: data.createdAt ? new Date(data.createdAt) : new Date(0),
        },
      });
    } catch {
      // Corrupted or duplicate — skip
    }
  }
}
