/**
 * Regenerate TTS for an existing classroom.
 *
 * POST /api/regenerate-tts/[classroomId]
 * Body: { language?: string }
 *
 * Deletes existing audio files, re-runs TTS generation with the correct
 * language-aware provider, and persists the updated classroom JSON.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import {
  readClassroom,
  writeJsonFileAtomic,
  CLASSROOMS_DIR,
  isValidClassroomId,
  buildRequestOrigin,
} from '@/lib/server/classroom-storage';
import { generateTTSForClassroom } from '@/lib/server/classroom-media-generation';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('RegenerateTTS');

export const maxDuration = 300; // 5 minutes — TTS for a full classroom can take a while

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ classroomId: string }> },
) {
  const { classroomId } = await params;

  if (!isValidClassroomId(classroomId)) {
    return apiError('INVALID_ID', 400, 'Invalid classroom ID');
  }

  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    return apiError('NOT_FOUND', 404, `Classroom "${classroomId}" not found`);
  }

  let language: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    language = typeof body?.language === 'string' ? body.language : undefined;
  } catch {
    // body is optional
  }

  // Fall back to the language stored on the stage
  const lang = language || classroom.stage.language || 'zh-CN';
  log.info(`Regenerating TTS for classroom ${classroomId}, language=${lang}`);

  // Delete existing audio dir so stale files don't accumulate
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  try {
    await fs.rm(audioDir, { recursive: true, force: true });
    log.info(`Deleted existing audio dir: ${audioDir}`);
  } catch (err) {
    log.warn('Failed to delete audio dir (may not exist):', err);
  }

  // Reset audioId / audioUrl on all speech actions so they get fresh URLs
  for (const scene of classroom.scenes) {
    if (!scene.actions) continue;
    for (const action of scene.actions) {
      if (action.type === 'speech') {
        const sa = action as { audioId?: string; audioUrl?: string };
        delete sa.audioId;
        delete sa.audioUrl;
      }
    }
  }

  const baseUrl = buildRequestOrigin(req);

  try {
    await generateTTSForClassroom(classroom.scenes, classroomId, baseUrl, lang);
  } catch (err) {
    log.error('TTS generation failed:', err);
    return apiError('TTS_FAILED', 500, err instanceof Error ? err.message : String(err));
  }

  // Persist updated classroom JSON (scenes now have audioId/audioUrl)
  const filePath = path.join(CLASSROOMS_DIR, `${classroomId}.json`);
  await writeJsonFileAtomic(filePath, {
    ...classroom,
    // Update language on stage if caller supplied one
    stage: { ...classroom.stage, language: lang, updatedAt: Date.now() },
    scenes: classroom.scenes,
  });

  const speechCount = classroom.scenes.flatMap((s) => s.actions ?? []).filter(
    (a) => a.type === 'speech',
  ).length;

  log.info(`TTS regeneration complete: ${speechCount} speech actions processed`);

  return apiSuccess({
    classroomId,
    language: lang,
    speechActionsProcessed: speechCount,
  });
}
