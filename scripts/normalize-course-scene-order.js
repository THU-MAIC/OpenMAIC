#!/usr/bin/env node
/*
 * Normalize cloud-course scene order to the current RJ invariant:
 * `scene.order === scene.seq === array index`.
 *
 * Safe defaults:
 * - --dry-run never writes courses or a checkpoint.
 * - normal runs checkpoint after each course and resume after interruption.
 * - every update is guarded by the row's original `updated_at`.
 * - malformed courses are reported and skipped, never guessed or silently fixed.
 *
 * Usage:
 *   node --env-file=.env.local scripts/normalize-course-scene-order.js --dry-run
 *   node --env-file=.env.local scripts/normalize-course-scene-order.js --report-dir=docs/reports/scene-order-migration
 *   node --env-file=.env.local scripts/normalize-course-scene-order.js --restart --report-dir=docs/reports/scene-order-migration
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function stableLegacyCompare(a, b) {
  const createdA = validNumber(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
  const createdB = validNumber(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
  if (createdA !== createdB) return createdA - createdB;
  const updatedA = validNumber(a.updatedAt) ? a.updatedAt : Number.MAX_SAFE_INTEGER;
  const updatedB = validNumber(b.updatedAt) ? b.updatedAt : Number.MAX_SAFE_INTEGER;
  if (updatedA !== updatedB) return updatedA - updatedB;
  return String(a.id).localeCompare(String(b.id));
}

function analyzeCourse(course) {
  const data = course.data;
  const stage = data?.stage;
  const scenes = data?.scenes;
  const issues = [];
  if (!stage || typeof stage !== 'object') issues.push({ code: 'missing-stage' });
  if (!Array.isArray(scenes)) issues.push({ code: 'scenes-not-array' });
  if (issues.length) return { eligible: false, issues, before: [], after: [] };

  const invalidIndexes = scenes
    .map((scene, index) =>
      !scene || typeof scene !== 'object' || typeof scene.id !== 'string' || !scene.id
        ? index
        : null,
    )
    .filter((index) => index !== null);
  if (invalidIndexes.length) issues.push({ code: 'invalid-scene-id', indexes: invalidIndexes });

  const ids = scenes.map((scene) => scene?.id).filter(Boolean);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) issues.push({ code: 'duplicate-scene-id', ids: duplicateIds });
  if (issues.length) return { eligible: false, issues, before: [], after: [] };

  const trusted = stage.sceneOrderTrusted === true;
  const allValidUniqueSeq =
    scenes.every((scene) => validNumber(scene.seq)) &&
    new Set(scenes.map((scene) => scene.seq)).size === scenes.length;
  const source = trusted && allValidUniqueSeq ? 'seq' : 'createdAt→updatedAt→id';
  const ordered =
    source === 'seq'
      ? [...scenes].sort((a, b) => a.seq - b.seq)
      : [...scenes].sort(stableLegacyCompare);
  const timestampTies = ordered
    .filter((scene, index) => index > 0 && scene.createdAt === ordered[index - 1].createdAt)
    .map((scene) => scene.id);
  if (timestampTies.length)
    issues.push({ code: 'created-at-tie', sceneIds: timestampTies, blocking: false });

  const normalized = ordered.map((scene, index) => ({ ...scene, order: index, seq: index }));
  const nextData = structuredClone(data);
  nextData.scenes = normalized;
  nextData.stage = {
    ...nextData.stage,
    sceneOrderTrusted: true,
    sceneOrderRepairedAt: Date.now(),
  };
  const before = scenes.map((scene) => ({
    id: scene.id,
    order: scene.order ?? null,
    seq: scene.seq ?? null,
  }));
  const after = normalized.map((scene) => ({ id: scene.id, order: scene.order, seq: scene.seq }));
  const changed =
    JSON.stringify(before) !== JSON.stringify(after) || stage.sceneOrderTrusted !== true;
  return { eligible: true, issues, source, changed, before, after, nextData };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function sha(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const restart = args.has('--restart');
  const reportDirArg = process.argv.find((arg) => arg.startsWith('--report-dir='));
  const reportDir = reportDirArg
    ? reportDirArg.slice('--report-dir='.length)
    : 'docs/reports/scene-order-migration';
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  fs.mkdirSync(reportDir, { recursive: true });
  const checkpointPath = path.join(reportDir, 'checkpoint.json');
  const checkpoint =
    !dryRun && !restart
      ? readJson(checkpointPath, { lastCourseId: null, processed: 0 })
      : { lastCourseId: null, processed: 0 };
  const report = {
    startedAt: new Date().toISOString(),
    dryRun,
    restart,
    scanned: 0,
    changed: 0,
    unchanged: 0,
    updated: 0,
    skippedConcurrent: 0,
    blocked: [],
    warnings: [],
    snapshots: [],
  };
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let cursor = checkpoint.lastCourseId;
  for (;;) {
    let query = supabase.from('courses').select('id,data,updated_at').order('id').limit(50);
    if (cursor) query = query.gt('id', cursor);
    const { data: courses, error } = await query;
    if (error) throw error;
    if (!courses?.length) break;
    for (const course of courses) {
      report.scanned++;
      const result = analyzeCourse(course);
      if (!result.eligible) {
        report.blocked.push({ courseId: course.id, issues: result.issues });
      } else {
        const snapshot = {
          courseId: course.id,
          source: result.source,
          before: result.before,
          after: result.after,
          beforeHash: sha(result.before),
          afterHash: sha(result.after),
        };
        report.snapshots.push(snapshot);
        result.issues
          .filter((issue) => !issue.blocking)
          .forEach((issue) => report.warnings.push({ courseId: course.id, ...issue }));
        if (!result.changed) {
          report.unchanged++;
        } else if (dryRun) {
          report.changed++;
        } else {
          let update = supabase
            .from('courses')
            .update({ data: result.nextData, updated_at: new Date().toISOString() })
            .eq('id', course.id);
          update =
            course.updated_at == null
              ? update.is('updated_at', null)
              : update.eq('updated_at', course.updated_at);
          const { data: updated, error: updateError } = await update.select('id');
          if (updateError) throw updateError;
          if (!updated?.length) report.skippedConcurrent++;
          else {
            report.changed++;
            report.updated++;
          }
        }
      }
      cursor = course.id;
      if (!dryRun) {
        checkpoint.lastCourseId = cursor;
        checkpoint.processed++;
        writeJson(checkpointPath, checkpoint);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  writeJson(path.join(reportDir, 'before-order.json'), {
    generatedAt: report.startedAt,
    snapshots: report.snapshots.map(({ courseId, source, before, beforeHash }) => ({
      courseId,
      source,
      before,
      beforeHash,
    })),
  });
  writeJson(path.join(reportDir, 'after-order.json'), {
    generatedAt: report.finishedAt,
    dryRun,
    snapshots: report.snapshots.map(({ courseId, source, after, afterHash }) => ({
      courseId,
      source,
      after,
      afterHash,
    })),
  });
  writeJson(path.join(reportDir, dryRun ? 'dry-run.json' : 'result.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (report.blocked.length || report.skippedConcurrent) process.exitCode = 2;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { analyzeCourse, stableLegacyCompare };
