#!/usr/bin/env node
/*
 * Idempotently externalize inline course assets to Supabase Storage.
 *
 * Usage:
 *   node scripts/migrate-course-assets.js --dry-run
 *   node scripts/migrate-course-assets.js --report-dir reports/assets-20260726
 *
 * Required: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY. The checkpoint makes a rerun resume after the last
 * committed course; data URIs already converted to URLs are naturally skipped.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'course-assets';
const DATA_URI = /^data:([^;,]+)?(;base64)?,(.*)$/s;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const reportDirArg = process.argv.find((arg) => arg.startsWith('--report-dir='));
const reportDir = reportDirArg ? reportDirArg.slice('--report-dir='.length) : 'reports/course-assets-migration';
const checkpointPath = path.join(reportDir, 'checkpoint.json');

function mkdirp(directory) { fs.mkdirSync(directory, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function isDataUri(value) { return typeof value === 'string' && value.startsWith('data:'); }
function decodeDataUri(value) {
  const match = value.match(DATA_URI);
  if (!match) throw new Error('Invalid data URI');
  const contentType = match[1] || 'application/octet-stream';
  const buffer = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
  return { contentType, buffer };
}
function ext(contentType, kind) {
  const normalized = contentType.split('/')[1]?.toLowerCase();
  const aliases = { jpeg: 'jpg', mpeg: 'mp3', 'svg+xml': 'svg' };
  return aliases[normalized] || normalized || (kind === 'images' ? 'png' : 'mp3');
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  mkdirp(reportDir);
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!dryRun) {
    const { error: getError } = await supabase.storage.getBucket(BUCKET);
    if (getError) {
      const { error } = await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: '50MB' });
      if (error) throw new Error(`Unable to create ${BUCKET}: ${error.message}`);
    }
  }

  // A dry-run is a fresh audit, not a resumable mutation; always scan all rows.
  const checkpoint = dryRun
    ? { lastCourseId: null, processed: 0 }
    : readJson(checkpointPath, { lastCourseId: null, processed: 0 });
  const report = { startedAt: new Date().toISOString(), dryRun, courses: 0, changedCourses: 0, images: 0, audio: 0, bytesBefore: 0, bytesAfter: 0, failures: [] };
  let cursor = checkpoint.lastCourseId;
  for (;;) {
    let query = supabase.from('courses').select('id,data').order('id').limit(50);
    if (cursor) query = query.gt('id', cursor);
    const { data: courses, error } = await query;
    if (error) throw error;
    if (!courses?.length) break;
    for (const course of courses) {
      report.courses++;
      const original = course.data || {};
      const next = structuredClone(original);
      let changed = false;
      const upload = async (value, kind) => {
        const { contentType, buffer } = decodeDataUri(value);
        report.bytesBefore += Buffer.byteLength(value);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const objectPath = `courses/${course.id}/${kind}/${hash}.${ext(contentType, kind)}`;
        if (!dryRun) {
          const { error: uploadError } = await supabase.storage.from(BUCKET).upload(objectPath, buffer, { contentType, upsert: true });
          if (uploadError) throw new Error(uploadError.message);
        }
        const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
        report.bytesAfter += Buffer.byteLength(publicData.publicUrl);
        if (kind === 'images') report.images++; else report.audio++;
        return publicData.publicUrl;
      };
      try {
        const mapping = next.stage?.data?.imageMapping;
        if (mapping && typeof mapping === 'object') for (const [key, value] of Object.entries(mapping)) {
          if (isDataUri(value)) { mapping[key] = await upload(value, 'images'); changed = true; }
        }
        if (Array.isArray(next.scenes)) for (const scene of next.scenes) {
          if (isDataUri(scene.narrationAudioUrl)) { scene.narrationAudioUrl = await upload(scene.narrationAudioUrl, 'audio'); changed = true; }
          if (Array.isArray(scene.actions)) for (const action of scene.actions) {
            if (isDataUri(action.audioUrl)) { action.audioUrl = await upload(action.audioUrl, 'audio'); changed = true; }
          }
        }
        if (changed && !dryRun) {
          const { error: updateError } = await supabase.from('courses').update({ data: next, updated_at: new Date().toISOString() }).eq('id', course.id);
          if (updateError) throw updateError;
        }
        if (changed) report.changedCourses++;
      } catch (error) {
        report.failures.push({ courseId: course.id, error: error instanceof Error ? error.message : String(error) });
      }
      cursor = course.id;
      checkpoint.lastCourseId = cursor;
      checkpoint.processed++;
      writeJson(checkpointPath, checkpoint);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.bytesSaved = report.bytesBefore - report.bytesAfter;
  // Both reports describe the same scan. `before` is the baseline payload
  // footprint; `after` adds the resulting URL footprint and reduction.
  writeJson(path.join(reportDir, 'before.json'), {
    ...report,
    bytesAfter: 0,
    bytesSaved: 0,
    estimatedPayloadBytesAfterExternalization: report.bytesAfter,
  });
  writeJson(path.join(reportDir, 'after.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
