// One-off: synthesize narration for every speech line of a stage via the
// running server (server-side tts slot → MiniMax), store each clip in the
// asset pool, and stamp audioId back into the scene. Single-user mode, so no
// owner cookie is required.
//
// Usage: node scripts/dev-voice-all-once.mjs <stageId>
const BASE = process.env.OPENMAIC_BASE_URL ?? 'http://localhost:3000';
const stageId = process.argv[2];
if (!stageId) {
  console.error('usage: node scripts/dev-voice-all-once.mjs <stageId>');
  process.exit(1);
}

const docRes = await fetch(`${BASE}/api/persistence/documents/${stageId}`);
if (!docRes.ok) {
  console.error(`load document failed: ${docRes.status} ${await docRes.text()}`);
  process.exit(1);
}
const doc = await docRes.json();

let line = 0;
let done = 0;
let failed = 0;

for (const scene of doc.scenes ?? []) {
  const actions = scene.actions ?? [];
  const speeches = actions.filter((a) => a.type === 'speech' && (a.text ?? '').trim());
  if (!speeches.length) continue;

  let sceneDirty = false;
  for (const speech of speeches) {
    line += 1;
    if (speech.audioId) {
      done += 1;
      console.log(`[${line}] ${scene.id}/${speech.id} ... skip (has audio)`);
      continue;
    }
    const audioId = `voice-${scene.id}-${speech.id}`;
    process.stdout.write(`[${line}] ${scene.id}/${speech.id} ... `);
    try {
      // 1) Synthesize through the deployment's tts slot. Retry on provider
      //    rate limits — the free-tier MiniMax tier is RPM-bound.
      let tts = null;
      for (let attempt = 1; ; attempt += 1) {
        const ttsRes = await fetch(`${BASE}/api/generate/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: speech.text, audioId }),
        });
        const body = await ttsRes.json().catch(() => ({}));
        if (ttsRes.ok && body.success && body.base64) {
          tts = body;
          break;
        }
        const isRateLimit =
          ttsRes.status === 429 || String(body.error ?? body.details ?? '').includes('rate limit');
        if (!isRateLimit || attempt >= 6) {
          throw new Error(
            `tts ${ttsRes.status}: ${body.details || body.error || JSON.stringify(body)}`,
          );
        }
        process.stdout.write(`(429, wait ${attempt * 20}s) `);
        await new Promise((r) => setTimeout(r, attempt * 20_000));
      }

      // 2) Store the bytes in the asset pool (multipart: meta + bytes).
      const bytes = Buffer.from(tts.base64, 'base64');
      const form = new FormData();
      form.set(
        'meta',
        new Blob([JSON.stringify({ contentType: `audio/${tts.format}` })], {
          type: 'application/json',
        }),
      );
      form.set(
        'bytes',
        new Blob([bytes], { type: `audio/${tts.format}` }),
        `narration.${tts.format}`,
      );
      const putRes = await fetch(`${BASE}/api/persistence/assets`, {
        method: 'POST',
        body: form,
      });
      const put = await putRes.json().catch(() => ({}));
      if (!putRes.ok || !put.id) {
        throw new Error(`asset ${putRes.status}: ${JSON.stringify(put)}`);
      }

      // 3) Stamp the allocated asset id onto the speech line.
      speech.audioId = put.id;
      sceneDirty = true;
      done += 1;
      console.log(`ok (${(bytes.length / 1024).toFixed(0)} KB → ${put.id})`);
    } catch (error) {
      failed += 1;
      console.log(`FAILED: ${error.message ?? error}`);
    }
    // Be polite to the provider between lines.
    await new Promise((r) => setTimeout(r, 300));
  }

  if (sceneDirty) {
    const saveRes = await fetch(
      `${BASE}/api/persistence/documents/${stageId}/scenes/${scene.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(scene),
      },
    );
    if (!saveRes.ok) {
      console.error(`  save scene ${scene.id} failed: ${saveRes.status} ${await saveRes.text()}`);
      failed += 1;
    } else {
      console.log(`  scene ${scene.id} saved`);
    }
  }
}

console.log(`\n${done}/${line} lines voiced, ${failed} failures.`);
process.exit(failed ? 1 : 0);
