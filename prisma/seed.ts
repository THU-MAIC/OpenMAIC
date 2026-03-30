import { hashSync } from 'bcryptjs';
import { promises as fs } from 'fs';
import path from 'path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../lib/generated/prisma/client';

const DB_URL = `file:${path.join(process.cwd(), 'data', 'openmaic.db')}`;
const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');

const adapter = new PrismaBetterSqlite3({ url: DB_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@openmaic.uz' },
    update: {},
    create: {
      email: 'admin@openmaic.uz',
      name: 'Admin',
      password: hashSync('changeme123', 12),
      role: 'admin',
    },
  });

  console.log(`Admin user: ${admin.email} (id: ${admin.id})`);

  // 2. Migrate existing classroom JSON files into DB
  let files: string[];
  try {
    files = await fs.readdir(CLASSROOMS_DIR);
  } catch {
    console.log('No classrooms directory found — skipping migration.');
    return;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json') && f !== 'index.json');
  let migrated = 0;

  for (const file of jsonFiles) {
    const id = file.replace('.json', '');
    const existing = await prisma.classroom.findUnique({ where: { id } });
    if (existing) continue;

    try {
      const raw = await fs.readFile(path.join(CLASSROOMS_DIR, file), 'utf-8');
      const data = JSON.parse(raw);

      await prisma.classroom.create({
        data: {
          id: data.id || id,
          userId: admin.id,
          title: data.stage?.name || 'Untitled',
          language: data.stage?.language || 'zh-CN',
          sceneCount: Array.isArray(data.scenes) ? data.scenes.length : 0,
          filePath: path.join(CLASSROOMS_DIR, file),
          createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        },
      });
      migrated++;
    } catch (err) {
      console.warn(`Skipped ${file}: ${err}`);
    }
  }

  console.log(`Migrated ${migrated} classroom(s) from disk into DB under admin user.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
