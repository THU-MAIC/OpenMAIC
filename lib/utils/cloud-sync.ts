import { supabase } from '@/lib/supabase/client';
import { db } from '@/lib/utils/database';
import {
  publishSceneAudioAssets,
  validatePublishedAudioAssets,
  type PublishSceneAudioAssetsResult,
} from '@/lib/audio/audio-publish';
import { createLogger } from '@/lib/logger';
import { externalizeCourseAssets } from '@/lib/course-assets/externalize';
import { stripRuntimeOnly } from '@/lib/dsl-extensions/serialize';

const log = createLogger('CloudSync');

async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || '璇锋眰澶辫触');
  }
  return data.data as T;
}
// ============================================================
// 浠?IndexedDB 璇诲彇瀹屾暣璇剧▼鏁版嵁
// ============================================================
async function collectStageData(stageId: string) {
  const [stage, rawScenes] = await Promise.all([
    db.stages.get(stageId),
    db.scenes.where('stageId').equals(stageId).toArray(),
  ]);

  if (!stage) {
    throw new Error(`Stage ${stageId} not found locally`);
  }

  // Use the trusted comparator (seq → createdAt → updatedAt → id) instead
  // of plain sortBy('seq'). Trust model (introduced v15):
  //   - stage.sceneOrderTrusted === true  → seq is authoritative, prefer='auto'
  //   - otherwise                         → legacy state, prefer='createdAt'
  // loadStageData has already run the recovery + flag flip on first read,
  // so by the time we get here in the normal flow stage.sceneOrderTrusted
  // should already be true. The 'createdAt' fallback is a safety net for
  // uploads that race before loadStageData has touched the stage.
  const { orderSceneRecordsForDisplay } = await import('./scene-order');
  const stageIsTrusted = stage.sceneOrderTrusted === true;
  const { ordered: scenes, source: orderingSource, duplicateIdsRemoved } =
    orderSceneRecordsForDisplay(rawScenes, {
      prefer: stageIsTrusted ? 'auto' : 'createdAt',
    });

  const outlines = await db.stageOutlines.where('stageId').equals(stageId).toArray();

  if (duplicateIdsRemoved.length > 0) {
    log.warn('[collectStageData] Duplicate scene ids removed', {
      stageId,
      duplicateIdsRemoved,
    });
  }

  log.info('[collectStageData]', {
    stageId,
    sceneCount: scenes.length,
    sceneOrderTrusted: stageIsTrusted,
    first5: scenes.slice(0, 5).map((s) => ({
      id: s.id,
      title: s.title,
      order: s.order,
      seq: s.seq,
      createdAt: s.createdAt,
    })),
    orderingSource,
    source: 'collect',
  });

  const stageName = stage.name?.trim?.() || '';

  return {
    id: stage.id,
    title: stageName || '未命名课程',
    topic: stageName || '',
    stage,
    scenes,
    outlines,
  };
}
// ============================================================
// 淇濆瓨璇剧▼鍒颁簯绔?
// ============================================================
export async function saveStageToCloud(stageId: string) {
  const { id, title, topic, stage, scenes, outlines } =
    await collectStageData(stageId);

  // ── Phase 1: Publish audio assets (3-tier: skip / upload / regenerate) ──
  // Extract teacherVoiceConfig from stage so Tier 3 TTS regeneration uses the
  // course's authoritative voice (not the current settings store value).
  const teacherVoiceConfig = (stage as unknown as Record<string, unknown>).teacherVoiceConfig as
    | { providerId?: string; voiceId?: string; modelId?: string }
    | undefined;

  const publishResult = await publishSceneAudioAssets(
    stageId,
    scenes as any,
    teacherVoiceConfig ?? null,
  );

  log.info('Audio publish result', {
    uploaded: publishResult.uploaded.length,
    skipped: publishResult.skipped.length,
    missing: publishResult.missing.length,
    failed: publishResult.failed.length,
    regenerated: publishResult.regenerated.length,
  });

  // ── Phase 2: Validate all learnable scenes have audioUrl ──
  const validation = validatePublishedAudioAssets(publishResult.scenes);

  if (!validation.ok || publishResult.failed.length > 0 || publishResult.missing.length > 0) {
    console.warn('[MOBILE PUBLISH][Audio Validation Failed]', JSON.stringify({
      stageId,
      validationOk: validation.ok,
      failedCount: publishResult.failed.length,
      missingCount: publishResult.missing.length,
      invalidIssues: validation.issues.length,
      timestamp: new Date().toISOString(),
    }));

    const failedCount = publishResult.failed.length;
    const missingCount = publishResult.missing.length;
    const invalidCount = validation.issues.length;

    const failedPreview = publishResult.failed
      .slice(0, 3)
      .map((item) => `${item.audioId}: ${item.error}`)
      .join('；');

    const missingPreview = publishResult.missing
      .slice(0, 3)
      .map((item) => `${item.audioId}: ${item.reason}`)
      .join('；');

    const issuePreview = validation.issues
      .slice(0, 3)
      .map((i) => `${i.sceneId.slice(0, 8)}: ${i.reason}`)
      .join('；');

    const detailParts = [
      failedCount > 0 ? `上传/生成失败 ${failedCount} 条${failedPreview ? `（${failedPreview}）` : ''}` : '',
      missingCount > 0 ? `文字缺失 ${missingCount} 条${missingPreview ? `（${missingPreview}）` : ''}` : '',
      invalidCount > 0 ? `校验不通过 ${invalidCount} 处${issuePreview ? `（${issuePreview}）` : ''}` : '',
    ].filter(Boolean);

    throw new Error(
      `保存失败：课程语音资源未发布完整。${detailParts.join('；')}。请检查语音生成后重新保存。`,
    );
  }

  // ── Phase 3: Externalize every remaining base64 asset before the JSON write.
  // This deep-copies first: local runtime state remains usable if a later network
  // request fails. Signed uploads go directly to Storage, never through this POST.
  const externalized = await externalizeCourseAssets(
    id,
    stage as unknown as Record<string, unknown>,
    publishResult.scenes as unknown as Record<string, unknown>[],
  );
  const stageToSave = stripRuntimeOnly(externalized.stage);
  const scenesToSave = externalized.scenes;

  const response = await fetch('/api/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title,
      topic,
      data: {
        stage: stageToSave,
        scenes: scenesToSave,
        outlines,
      },
    }),
  });

  await readApiJson(response);

  // 保存成功后，把补齐 audioUrl 的 scenes 回写本地，避免下次重复上传
  if (scenesToSave.length > 0) {
    // Ensure each scene has `seq` (the v13 insertion-order field). publishResult
    // preserves input order, so array index = correct seq.
    const withSeq = scenesToSave.map((s: any, i: number) => ({ ...s, seq: s.seq ?? i }));
    await db.scenes.bulkPut(withSeq);
  }
  // Keep the local course normalized too. Otherwise the next save would need to
  // rediscover the same data: URIs (the content-addressed path is idempotent,
  // but avoiding the extra upload authorization is faster and clearer).
  await db.stages.put(stageToSave as unknown as typeof stage);

  return {
    id,
    title,
    audioPublish: {
      uploaded: publishResult.uploaded.length,
      skipped: publishResult.skipped.length,
      missing: publishResult.missing.length,
      failed: publishResult.failed.length,
      regenerated: publishResult.regenerated.length,
    },
    assets: externalized.converted,
    validation: {
      totalLearnableScenes: validation.totalLearnableScenes,
      validScenes: validation.validScenes,
      ok: validation.ok,
    },
  };
}
// ============================================================
// 鍒楀嚭浜戠璇剧▼
// ============================================================
export async function listCloudCourses() {
  const res = await fetch('/api/courses?scope=all');
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || '获取云端课程失败');
  }
  return json.data as Array<{
    id: string;
    title: string;
    topic: string;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>;
}

export async function listMyCourses() {
  const res = await fetch('/api/courses?scope=mine');
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || '获取我的课程失败');
  }
  return json.data as Array<{
    id: string;
    title: string;
    topic: string;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  }>;
}
// ============================================================
// 涓嬭浇璇剧▼鍒版湰鍦?IndexedDB
// ============================================================
export async function importCourseFromCloud(courseId: string) {
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}`);
  // Server may return a non-JSON body (e.g. 413 from Vercel gateway
  // or 5xx HTML) — guard the JSON parse so the caller gets a clear
  // error instead of a generic SyntaxError "Unexpected token ...".
  let json: { success?: boolean; error?: string; data?: any };
  try {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`服务器返回非 JSON 响应（${res.status}）`);
    }
    json = await res.json();
  } catch {
    throw new Error(`课程请求失败（${res.status}）`);
  }
  if (!res.ok || !json.success) {
    throw new Error(json.error || '课程不存在');
  }
  const data = json.data;
  if (!data?.data) throw new Error('课程数据不完整');
  const { stage, scenes, outlines } = data.data;
  // Force seq/order = array index on import. This repairs ONLY the case
  // where the cloud array order is correct but the embedded seq/order
  // fields inside each record are stale/wrong. It does NOT repair a
  // cloud array that is itself in the wrong order — for that, use the
  // ?repairOrder=createdAt entry on the classroom page (which calls
  // orderSceneRecordsForDisplay with prefer: 'createdAt') or run a
  // server-side repair script.
  const scenesWithSeq = (scenes as Array<Record<string, unknown>>).map(
    (s, i) => ({ ...s, order: i, seq: i }),
  );
  await db.transaction(
    'rw',
    [db.stages, db.scenes, db.stageOutlines],
    async () => {
      // Clear local state for this course FIRST so we don't accumulate
      // duplicate rows when the same course is re-imported with different ids.
      await db.scenes.where('stageId').equals(courseId).delete();
      await db.stageOutlines.where('stageId').equals(courseId).delete();
      await db.stages.put(stage as Parameters<typeof db.stages.put>[0]);
      await db.scenes.bulkPut(scenesWithSeq as unknown as Parameters<typeof db.scenes.bulkPut>[0]);
      await db.stageOutlines.bulkPut(outlines as Parameters<typeof db.stageOutlines.bulkPut>[0]);
    },
  );
  log.info('[importCourseFromCloud] Replaced local state for course:', {
    courseId,
    scenesCount: scenesWithSeq.length,
    outlinesCount: (outlines as unknown[] | undefined)?.length ?? 0,
  });
  return { id: data.id, title: data.title };
}
// ============================================================
// 鍒犻櫎浜戠璇剧▼
// ============================================================
export async function deleteCloudCourse(courseId: string) {
  // Route through the API (which uses service_role) instead of
  // deleting directly via the anon browser client. Once RLS is
  // enabled on public.courses, the anon key can no longer DELETE.
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || '删除云端课程失败');
  }
}

export interface StudentRecord {
  id: string;
  name: string;
  access_code?: string | null;
  email?: string | null;
  employee_no?: string | null;
  note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CourseAssignmentRecord {
  id: string;
  course_id: string;
  student_id: string;
  status: 'not_started' | 'in_progress' | 'completed';
  assigned_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  last_seen_at?: string | null;
  students?: {
    id: string;
    name: string;
    email?: string | null;
    employee_no?: string | null;
  } | null;
}

export async function listStudents() {
  const response = await fetch('/api/students');
  return readApiJson<StudentRecord[]>(response);
}

export async function createStudent(input: {
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}) {
  const response = await fetch('/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readApiJson<StudentRecord>(response);
}

export async function importStudents(students: Array<{
  name: string;
  email?: string;
  employee_no?: string;
  note?: string;
}>) {
  const response = await fetch('/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ students }),
  });
  return readApiJson<StudentRecord[]>(response);
}

export async function listCourseAssignments(courseId: string) {
  const response = await fetch(`/api/courses/${courseId}/assignments`);
  return readApiJson<CourseAssignmentRecord[]>(response);
}

export async function assignCourseToStudents(courseId: string, studentIds: string[]) {
  const response = await fetch(`/api/courses/${courseId}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentIds }),
  });
  return readApiJson<CourseAssignmentRecord[]>(response);
}

export async function verifyStudentAccess(courseId: string, accessCode: string) {
  const response = await fetch('/api/learning/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, accessCode }),
  });
  return readApiJson<{ studentId: string; studentName: string }>(response);
}

export async function recordLearningEvent(input: {
  courseId: string;
  studentId?: string;
  eventType: 'open_course' | 'view_scene' | 'complete_course';
  sceneId?: string;
  sceneOrder?: number;
  metadata?: Record<string, unknown>;
}) {
  const response = await fetch('/api/learning/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readApiJson<{ success: true }>(response);
}



