/**
 * `import_pptx` — fill an uploaded PowerPoint's slides into a stage as pages.
 *
 * This is the layout-preserving path: parse the .pptx into DSL slides and
 * write one scene per slide, appended to the pages the stage already has (or
 * inserted at `atOrder`). The stage keeps its own identity — title and
 * description come from `create_stage` and are never replaced by the PPT's.
 * The PPT is one content source among others, on equal footing with
 * `generate_scene`; existing pages are a normal premise, not a conflict.
 * It is not extract + generate_scene, which rebuilds a new lesson
 * from extracted text.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Slide } from '@openmaic/dsl';
import type { AgentSessionMaterial } from '@openmaic/storage';
import type { OssUpload } from '@openmaic/importer';

import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, SlideContent, Stage } from '@/lib/types/stage';
import { stripTags } from './course-edit/apply';
import { shiftCourseOrders } from './course-edit/tools';
import type { CourseDocument, CourseToolDeps } from './course-tools';
import { runStageMutation } from './mutation-fence';
import { isPptxMaterial } from './pptx-mime';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { getSessionMaterial, resolveSessionMaterialRawAsset } from './session-materials';

export { isPptxMaterial, PPTX_MIME } from './pptx-mime';

export const IMPORT_PPTX_TOOL_NAME = 'import_pptx';
export const IMPORT_PPTX_REQUIREMENT_PREFIX = 'import_pptx:';
export const MAX_IMPORT_SLIDES = 80;

/** Next-step hint after import. Inspection and repair come before TTS. */
export const AFTER_IMPORT_NEXT_STEP =
  'Next: set_roster if the classroom has no roster; inspect every imported page with list_scenes, read_stage, and render_scene_preview when that tool is registered; load the pro-editing skill to fix visual bad cases; understand the course; then patch_stage the actions when needed; then generate_tts. Do not patch actions or generate_tts before inspection.';

const ImportParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  materialId: Type.String({
    description: 'The source mat_ id of an uploaded .pptx, from list_materials.',
  }),
  atOrder: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Insert the imported slides at this 1-based page position instead of appending after the last page; pages at this order and beyond shift back (same semantics as edit_deck insert / duplicate_scene). Default: append after the last page.',
    }),
  ),
});

export interface ImportPptxToolDeps extends CourseToolDeps {
  getMaterial?: (sessionId: string, materialId: string) => Promise<AgentSessionMaterial | null>;
  readMaterialBytes?: (
    record: AgentSessionMaterial,
  ) => Promise<{ bytes: Buffer; mime: string } | null>;
  parsePptx?: (buffer: ArrayBuffer, options?: { upload?: OssUpload }) => Promise<Slide[]>;
  uploadImportedMedia?: OssUpload;
}

/**
 * The import idempotency key for one material. It is stored as the outline
 * `requirement` and doubles as the key of the per-stage `pptxImports` receipts.
 *
 * The key rides the material's CONTENT digest (sha256) rather than its material
 * id, so a retry of the same PowerPoint — even re-uploaded as a new mat_ id —
 * reports the pages it already imported instead of appending a second copy.
 * Falls back to the material id when the digest is absent.
 */
export function importRequirementFor(material: { id: string; sha256?: string | null }): string {
  const digest = material.sha256?.trim();
  return digest
    ? `${IMPORT_PPTX_REQUIREMENT_PREFIX}sha256:${digest}`
    : `${IMPORT_PPTX_REQUIREMENT_PREFIX}${material.id}`;
}

export function titleFromSlide(slide: Slide, index: number): string {
  for (const element of slide.elements ?? []) {
    const rec = element as {
      type?: string;
      content?: string;
      text?: { content?: string };
    };
    let text = '';
    if (rec.type === 'text') text = stripTags(rec.content ?? '');
    else if (rec.type === 'shape') text = stripTags(rec.text?.content ?? '');
    if (text) return text.slice(0, 80);
  }
  const notes = slide.script?.replace(/\s+/g, ' ').trim();
  if (notes) return notes.slice(0, 80);
  return `Slide ${index + 1}`;
}

function pageIdFor(seq: number): string {
  return `p${seq}`;
}

/** The `p<seq>` page-seq of an outline/scene id, or 0 when it is not one. */
function pageSeqOf(id: string | undefined): number {
  const match = id?.match(/^p(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function sceneIdFor(outlineId: string, order: number): string {
  const raw = outlineId.replace(/[^\w-]/g, '');
  return `scene-${raw || `o${order}`}`;
}

function speechFromNotes(sceneId: string, notes: string | undefined): Action[] {
  const text = notes?.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  return [
    {
      id: `speech-${sceneId}`,
      type: 'speech',
      text,
    } satisfies SpeechAction,
  ];
}

export function slidesToScenes(
  slides: Slide[],
  stageId: string,
  options: { firstOrder?: number; firstPageSeq?: number } = {},
): { scenes: Scene[]; outlines: SceneOutline[] } {
  // firstOrder is the order of the first imported scene (1 for a fresh stage,
  // max+1 for an append, atOrder for an insertion). firstPageSeq is the first
  // page id in the stage-wide sequence (`p<seq>`): it stays unique across the
  // whole document even when an insertion puts the imported pages between
  // existing ones, so scene/outline ids never collide after a shift.
  const firstOrder = options.firstOrder ?? 1;
  const firstPageSeq = options.firstPageSeq ?? firstOrder;
  const scenes: Scene[] = [];
  const outlines: SceneOutline[] = [];
  slides.forEach((slide, index) => {
    const order = firstOrder + index;
    const pageSeq = firstPageSeq + index;
    const outlineId = pageIdFor(pageSeq);
    const sceneId = sceneIdFor(outlineId, order);
    const title = titleFromSlide(slide, index);
    const canvas: Slide = {
      ...slide,
      id: slide.id || `slide-${outlineId}`,
    };
    const content: SlideContent = { type: 'slide', canvas };
    scenes.push({
      id: sceneId,
      stageId,
      order,
      title,
      type: 'slide',
      outlineId,
      content,
      actions: speechFromNotes(sceneId, slide.script),
    } as Scene);
    outlines.push({
      id: outlineId,
      order,
      title,
      type: 'slide',
      description: title,
      keyPoints: [],
    });
  });
  return { scenes, outlines };
}

function mimeFromName(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

/**
 * Upload one media blob extracted from the deck. Bytes go through the shared
 * asset registry (the same neutral surface `use_material_media` and
 * `generate_image` use); the returned id is a stable `src`. A thrown upload
 * must not abort the deck parse: the importer treats a rejected callback as a
 * missing asset and still returns the slide, so the fallback is the original
 * data URL.
 */
export async function defaultUploadImportedMedia(blob: Blob, filename: string): Promise<string> {
  const buffer = Buffer.from(await blob.arrayBuffer());
  const mime = blob.type || mimeFromName(filename);
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
  try {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const src = await provider.assetStore.put(
      { key: 'shared' },
      new Blob([buffer], { type: mime }),
      { contentType: mime },
    );
    if (src) return src;
  } catch {
    // A thrown upload must not abort the deck parse: the importer treats a
    // rejected callback as a missing asset and still returns the slide.
  }
  return dataUrl;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function importerWorkerPath(): string | null {
  const path = join(process.cwd(), 'lib/server/agent-runtime/import-pptx-worker.mjs');
  return existsSync(path) ? path : null;
}

async function rewriteDataUrls(value: unknown, upload: OssUpload): Promise<unknown> {
  if (typeof value === 'string' && value.startsWith('data:')) {
    const response = await fetch(value);
    const blob = await response.blob();
    const ext = blob.type.split('/')[1]?.split(';')[0] || 'bin';
    return upload(blob, `import.${ext}`);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => rewriteDataUrls(item, upload)));
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
        key,
        await rewriteDataUrls(item, upload),
      ]),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** Parse in a worker thread so DOM shims never land on the request process. */
export async function parsePptxIsolated(
  buffer: ArrayBuffer,
  options: { upload?: OssUpload } = {},
): Promise<Slide[]> {
  const workerFile = importerWorkerPath();
  if (!workerFile) {
    throw new Error('PPTX import worker is missing from the deployment.');
  }
  const copy = toArrayBuffer(new Uint8Array(buffer));
  const slides = await new Promise<Slide[]>((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: { buffer: copy } });
    const fail = (error: unknown) => {
      void worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    worker.once('message', (message: { slides?: Slide[]; error?: string }) => {
      void worker.terminate();
      if (message.error) fail(new Error(message.error));
      else resolve(message.slides ?? []);
    });
    worker.once('error', fail);
  });
  if (!options.upload) return slides;
  return (await rewriteDataUrls(slides, options.upload)) as Slide[];
}

export async function parsePptxBuffer(
  buffer: ArrayBuffer,
  options: { upload?: OssUpload } = {},
): Promise<Slide[]> {
  return parsePptxIsolated(buffer, options);
}

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('aborted');
}

export function buildImportPptxTool(
  deps: ImportPptxToolDeps,
): AgentTool<typeof ImportParams, unknown> {
  const getMaterial = deps.getMaterial ?? getSessionMaterial;
  const readMaterialBytes =
    deps.readMaterialBytes ??
    (async (record: AgentSessionMaterial) => {
      if (!record.rawAssetId) return null;
      return resolveSessionMaterialRawAsset(record.sessionId, record.rawAssetId);
    });
  const parsePptx = deps.parsePptx ?? parsePptxIsolated;
  const upload = deps.uploadImportedMedia ?? defaultUploadImportedMedia;

  return {
    name: IMPORT_PPTX_TOOL_NAME,
    label: 'Import PowerPoint',
    description:
      'Import slides from an uploaded .pptx INTO the given stage as appended pages, keeping layout. The stage keeps its own title and existing pages. Call once with the source mat_ id from list_materials, after create_stage. Do NOT extract_material or generate_scene for a layout-preserving import. Safe to retry for the same material: a retry reports the pages it already imported instead of appending again.',
    parameters: ImportParams,
    async execute(_id, params: Static<typeof ImportParams>, signal) {
      throwIfAborted(signal ?? deps.abortSignal);
      const stageId = params.stageId;
      throwIfAborted(signal ?? deps.abortSignal);
      const sessionId = deps.sessionId;
      if (!sessionId) {
        return toolResult(
          'No agent session is bound to this run; cannot read uploaded materials.',
          {},
          true,
        );
      }

      const record = await getMaterial(sessionId, params.materialId);
      if (!record) {
        return toolResult(
          `Material ${params.materialId} was not found in this session. Call list_materials and use a source mat_ id.`,
          { status: 'not_found', materialId: params.materialId },
          true,
        );
      }
      if (record.kind !== 'source') {
        return toolResult(
          `Material ${record.id} is a ${record.kind} derivative, not the uploaded .pptx. Pass the source mat_ id.`,
          { status: 'not_source', materialId: record.id, kind: record.kind },
          true,
        );
      }

      throwIfAborted(signal ?? deps.abortSignal);
      // The session material row carries no mime or content digest: both come
      // from the registry bytes, so the pptx gate and the idempotency key are
      // resolved from the raw asset in one read.
      const raw = await readMaterialBytes(record);
      if (!raw || !isPptxMaterial({ mime: raw.mime, originalName: record.title })) {
        return toolResult(
          `Material "${record.title ?? record.id}" is not a .pptx (mime ${raw?.mime ?? 'unknown'}). import_pptx only accepts PowerPoint files.`,
          { status: 'unsupported_type', materialId: record.id, mime: raw?.mime ?? null },
          true,
        );
      }

      const digest = createHash('sha256').update(raw.bytes).digest('hex');
      const requirement = importRequirementFor({ id: record.id, sha256: digest });
      const legacyRequirement = `${IMPORT_PPTX_REQUIREMENT_PREFIX}${record.id}`;
      const doc = await deps.store.loadDocument(stageId);
      if (!doc) {
        return toolResult(
          `No stage document exists at ${stageId}. import_pptx fills pages INTO an existing stage — call create_stage first, then import_pptx with the stageId create_stage returned.`,
          { status: 'no-document', stageId },
          true,
        );
      }
      throwIfAborted(signal ?? deps.abortSignal);
      const existingOutline = doc.outline as AppDocumentOutline | undefined;
      const existingScenes = [...(doc.scenes ?? [])].sort((a, b) => a.order - b.order);

      // Idempotent retry: a material that already imported into this stage
      // must not append a second copy. The receipt lives in the outline's
      // `pptxImports` map, keyed by the same import key as `requirement`.
      // Documents written by a pre-append importer carry only `requirement`
      // (`import_pptx:<materialId>`) and no receipts — treat those as one
      // legacy import covering the whole stage, so a retry on such a document
      // is still a report, never a duplicate append.
      //
      // The legacy material-id key is ALSO consulted once the map exists: a
      // receipt migrated from a pre-append document keeps its old
      // `import_pptx:<materialId>` key even when the material now has a
      // sha256 — the current record resolves to `import_pptx:sha256:<digest>`,
      // which would miss the migrated entry and re-append.
      const receipt =
        existingOutline?.pptxImports?.[requirement] ??
        existingOutline?.pptxImports?.[legacyRequirement];
      const legacyReceipt =
        !existingOutline?.pptxImports && existingOutline?.requirement === legacyRequirement
          ? existingScenes.map((scene) => scene.id)
          : undefined;
      const receiptSceneIds = receipt?.sceneIds ?? legacyReceipt;
      if (receiptSceneIds) {
        const live = existingScenes.filter((scene) => receiptSceneIds.includes(scene.id));
        if (live.length > 0) {
          return toolResult(
            [
              `This PowerPoint (${record.title ?? record.id}) was already imported into stage "${doc.stage?.name ?? stageId}" — nothing was appended, the pages are unchanged:`,
              live.map((scene) => `${scene.order}. ${scene.title}`).join(' | '),
              receiptSceneIds.length !== live.length
                ? `${receiptSceneIds.length - live.length} of the imported page(s) have since been deleted.`
                : '',
              `To import this file again on purpose, delete those pages first (edit_deck op=delete), then call import_pptx again. ${AFTER_IMPORT_NEXT_STEP}`,
            ]
              .filter(Boolean)
              .join(' '),
            {
              reused: true,
              pages: live.length,
              materialId: record.id,
              ...(digest ? { materialSha256: digest } : {}),
              pageOrders: live.map((scene) => scene.order),
              stageId,
            },
          );
        }
        // Every page of the earlier import was deleted: nothing would be
        // duplicated, so the retry is a genuine fresh import into the stage.
      }

      throwIfAborted(signal ?? deps.abortSignal);
      const arrayBuffer = toArrayBuffer(raw.bytes);

      let slides: Slide[];
      try {
        slides = await parsePptx(arrayBuffer, { upload });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'aborted') throw error;
        return toolResult(
          `Failed to parse the PowerPoint: ${message}`,
          { status: 'parse_failed', materialId: record.id },
          true,
        );
      }
      throwIfAborted(signal ?? deps.abortSignal);

      if (!slides.length) {
        return toolResult(
          'The PowerPoint parsed but contained no slides.',
          { status: 'empty', materialId: record.id },
          true,
        );
      }

      const truncated = slides.length > MAX_IMPORT_SLIDES;
      const imported = truncated ? slides.slice(0, MAX_IMPORT_SLIDES) : slides;
      // Append numbering starts at the current MAX order + 1 (never at the
      // scene count: orders may be gapped), and atOrder is clamped into
      // [1, maxOrder + 1] — the same shift semantics as edit_deck insert /
      // duplicate_scene, with maxOrder + 1 as the append position.
      const maxOrder = existingScenes.reduce((max, scene) => Math.max(max, scene.order), 0);
      // Outline ids run on the stage-wide `p<seq>` sequence, past every seq
      // already used by scenes or outline entries, so they stay unique even
      // when the insertion lands mid-deck or orders are gapped.
      const firstPageSeq =
        Math.max(
          ...existingScenes.map((scene) => pageSeqOf(scene.outlineId)),
          ...(existingOutline?.outlines ?? []).map((outline) => pageSeqOf(String(outline.id))),
          0,
        ) + 1;
      const at =
        params.atOrder == null ? maxOrder + 1 : Math.max(1, Math.min(params.atOrder, maxOrder + 1));
      const { scenes, outlines } = slidesToScenes(imported, stageId, {
        firstOrder: at,
        firstPageSeq,
      });
      const now = Date.now();
      const previousRoster = doc.stage?.generatedAgentConfigs;
      // The stage keeps its identity: create_stage owns the title and
      // description, and the PPT never touches them. Only the timestamps and
      // the (possibly extended) video manifest move here — same shape the
      // other agent-path writers use (set_roster spreads doc.stage).
      const stage: Stage = {
        ...doc.stage,
        id: stageId,
        videoManifest: {
          ...(doc.stage?.videoManifest ?? {}),
          ...buildVideoManifestFromOutlines(outlines),
        },
        createdAt: doc.stage?.createdAt ?? now,
        updatedAt: now,
      };

      // Shared shift: existing scenes AND snapshot outline entries at order >=
      // at move back by the imported span, so the imported pages never land on
      // an occupied plan slot and the shifted pages keep their briefs.
      const shifted = shiftCourseOrders(existingScenes, existingOutline, at, imported.length);
      const nextScenes = [...shifted.scenes, ...scenes].sort((a, b) => a.order - b.order);

      // First write of a `pptxImports` map onto a legacy document must MIGRATE
      // the legacy receipt, not discard it: pre-append importer documents
      // recorded "material A is imported" only as `requirement =
      // import_pptx:<A>`, and the outline below overwrites `requirement` with
      // the CURRENT material's key. Importing B onto such a document and then
      // retrying A used to look like a fresh import and append duplicate pages.
      // Seed A's receipt from the pre-import scenes — the same whole-stage
      // semantics the legacy read path above gives that document.
      const migratedImports: Record<string, { sceneIds: string[]; importedAt: number }> = {};
      if (
        !existingOutline?.pptxImports &&
        typeof existingOutline?.requirement === 'string' &&
        existingOutline.requirement.startsWith(IMPORT_PPTX_REQUIREMENT_PREFIX) &&
        existingOutline.requirement !== requirement
      ) {
        migratedImports[existingOutline.requirement] = {
          sceneIds: existingScenes.map((scene) => scene.id),
          importedAt: existingOutline.createdAt ?? now,
        };
      }

      const nextDoc: CourseDocument = {
        stage,
        scenes: nextScenes,
        outline: {
          // Append, never overwrite: the imported outline entries join the
          // stage's existing plan (sorted by order so read_stage_outline and
          // /outline list pages in order). The stage's earlier entries stay
          // untouched — outline is a snapshot, not a gate.
          outlines: [...(shifted.outline?.outlines ?? []), ...outlines].sort(
            (a, b) => a.order - b.order,
          ),
          requirement,
          generationComplete: true,
          producer: 'server-job',
          ...(deps.sessionId ? { producerRef: deps.sessionId } : {}),
          createdAt: existingOutline?.createdAt ?? now,
          updatedAt: now,
          pptxImports: {
            ...migratedImports,
            ...(existingOutline?.pptxImports ?? {}),
            [requirement]: { sceneIds: scenes.map((scene) => scene.id), importedAt: now },
          },
        } satisfies AppDocumentOutline,
      };
      await runStageMutation(signal, () => deps.store.saveDocument(nextDoc));

      const notesPages = scenes.filter((scene) =>
        (scene.actions ?? []).some((action) => action.type === 'speech'),
      ).length;
      deps.onCheckpoint({
        tool: IMPORT_PPTX_TOOL_NAME,
        stageId,
        detail: `imported ${scenes.length} slides from ${record.title ?? record.id} at orders ${at}..${at + scenes.length - 1}`,
      });

      const pageList = outlines.map((outline) => `${outline.order}. ${outline.title}`).join(' | ');
      return toolResult(
        [
          `Imported ${scenes.length} page(s) from "${record.title ?? record.id}" into stage "${stage.name}" at orders ${at}${scenes.length > 1 ? `–${at + scenes.length - 1}` : ''}: ${pageList}.`,
          truncated
            ? `Only the first ${MAX_IMPORT_SLIDES} slides were imported; the file had ${slides.length}.`
            : '',
          notesPages
            ? `${notesPages} page(s) received narration from speaker notes.`
            : 'No speaker notes were found; pages have no narration yet.',
          previousRoster?.length
            ? `A classroom roster already exists. ${AFTER_IMPORT_NEXT_STEP}`
            : AFTER_IMPORT_NEXT_STEP,
        ]
          .filter(Boolean)
          .join(' '),
        {
          stageId,
          courseTitle: stage.name,
          materialId: record.id,
          ...(digest ? { materialSha256: digest } : {}),
          pages: scenes.length,
          truncated,
          sourceSlideCount: slides.length,
          notesPages,
          firstOrder: at,
          pageOrders: scenes.map((scene) => scene.order),
        },
      );
    },
  };
}
