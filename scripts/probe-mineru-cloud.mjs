#!/usr/bin/env node
/**
 * Probe MinerU Cloud API for real supported file formats.
 *
 * Usage:
 *   MINERU_CLOUD_API_KEY=sk-... node scripts/probe-mineru-cloud.mjs
 *
 * For each sample in tmp/samples/, submits it to /file-urls/batch and polls
 * /extract-results/batch/{id} until a terminal state, then prints the outcome.
 * We don't download the ZIP — success at the extraction stage is enough signal
 * for "MinerU Cloud accepts this format."
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = (process.env.MINERU_CLOUD_BASE_URL || 'https://mineru.net/api/v4').replace(
  /\/+$/,
  '',
);
const API_KEY = process.env.MINERU_CLOUD_API_KEY;
if (!API_KEY) {
  console.error('Set MINERU_CLOUD_API_KEY env var.');
  process.exit(1);
}

const SAMPLES_DIR = new URL('../tmp/samples/', import.meta.url).pathname;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 5 * 60 * 1000;

async function readJson(res, ctx) {
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${ctx}: invalid JSON HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${ctx}: HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (json.code !== 0) throw new Error(`${ctx}: code ${json.code} — ${json.msg || 'unknown'}`);
  return json.data;
}

async function probe(fileName) {
  const buffer = readFileSync(join(SAMPLES_DIR, fileName));
  process.stdout.write(`\n[${fileName}] (${buffer.byteLength} bytes)\n`);

  // Step 1: request presigned URL
  let batch;
  try {
    const res = await fetch(`${API_ROOT}/file-urls/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{ name: fileName }],
        enable_formula: true,
        enable_table: true,
        language: 'ch',
      }),
    });
    batch = await readJson(res, 'file-urls/batch');
  } catch (e) {
    console.log(`  ❌ batch request rejected: ${e.message}`);
    return { fileName, result: 'batch-rejected', error: e.message };
  }

  const uploadUrls = batch.file_urls ?? batch.files;
  if (!batch.batch_id || !uploadUrls?.length) {
    console.log(`  ❌ malformed batch response`);
    return { fileName, result: 'batch-malformed' };
  }

  // Step 2: upload
  const putRes = await fetch(uploadUrls[0], {
    method: 'PUT',
    body: buffer,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => putRes.statusText);
    console.log(`  ❌ upload failed HTTP ${putRes.status}: ${text.slice(0, 200)}`);
    return { fileName, result: 'upload-failed', status: putRes.status };
  }

  // Step 3: poll
  const deadline = Date.now() + POLL_MAX_MS;
  let lastState = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let statusData;
    try {
      const res = await fetch(`${API_ROOT}/extract-results/batch/${batch.batch_id}`, {
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
      });
      statusData = await readJson(res, 'poll');
    } catch (e) {
      console.log(`  ⚠️  poll error: ${e.message}`);
      continue;
    }
    const rows = statusData.extract_result;
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const row = list[0];
    if (!row) continue;
    const state = row.state || '';
    if (state !== lastState) {
      process.stdout.write(`  → state=${state}\n`);
      lastState = state;
    }
    if (state === 'done') {
      console.log(`  ✅ MinerU accepted ${fileName}`);
      return { fileName, result: 'accepted', errMsg: row.err_msg };
    }
    if (state === 'failed' || row.err_msg) {
      console.log(`  ❌ MinerU rejected ${fileName}: ${row.err_msg || 'failed'}`);
      return { fileName, result: 'rejected', error: row.err_msg };
    }
  }
  console.log(`  ⏱️  timed out`);
  return { fileName, result: 'timeout' };
}

const files = readdirSync(SAMPLES_DIR).filter((f) => {
  const p = join(SAMPLES_DIR, f);
  return statSync(p).isFile() && !f.startsWith('.');
});

const results = [];
for (const f of files.sort()) {
  results.push(await probe(f));
}

console.log('\n\n═══ SUMMARY ═══');
for (const r of results) {
  const icon = r.result === 'accepted' ? '✅' : '❌';
  console.log(`${icon} ${r.fileName}: ${r.result}${r.error ? ` — ${r.error}` : ''}`);
}
