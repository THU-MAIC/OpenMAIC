import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '@/app/api/teacher/students/[profileId]/analyses/route';
import {
  GET as detail,
  PATCH,
} from '@/app/api/teacher/students/[profileId]/analyses/[analysisId]/route';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { createTeacherStudent } from '@/lib/server/teacher/students';
import { TEACHER_ANALYSIS_KIND, validateTeacherAnalysis } from '@/lib/teacher/analysis';

const state = vi.hoisted(() => ({ store: undefined as RuntimeStore | undefined }));
const configured = vi.hoisted(() => vi.fn(() => true));
const provider = vi.hoisted(() => vi.fn(async () => ({ runtimeStore: state.store })));
const generated = vi.hoisted(() => vi.fn());
const generatorFactory = vi.hoisted(() => vi.fn(() => generated));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: configured }));
vi.mock('@/lib/persistence/server-provider', () => ({ getServerPersistenceProvider: provider }));
vi.mock('@/lib/server/teacher/analysis-generator', () => ({
  createTeacherAnalysisGenerator: generatorFactory,
}));

const ORIGIN = 'http://localhost:3000';
const OWNER = '13fe7cc0-4fd9-4ad4-8455-105c97352dd5';
const MATERIAL = `mat_${'b'.repeat(26)}`;
const INPUT = {
  requestId: '242c3d7e-9e25-457a-9e56-efca1f924073',
  workKind: 'monthly_exam',
  subject: 'Math',
  title: 'Fictional monthly exam',
  workDate: '2026-09-08',
  teacherNotes: '',
  materials: [{ materialId: MATERIAL, role: 'student_work' }],
};
let profileId: string;

function req(method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/teacher/students/${profileId}/analyses`, {
    method,
    headers: {
      cookie: `anonymous_id=${OWNER}`,
      ...(body === undefined ? {} : { origin: ORIGIN, 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = () => ({ params: Promise.resolve({ profileId }) });
const detailContext = (analysisId: string) => ({
  params: Promise.resolve({ profileId, analysisId }),
});

beforeAll(() => vi.stubGlobal('IDBKeyRange', IDBKeyRange));
beforeEach(async () => {
  configured.mockReturnValue(true);
  provider.mockClear();
  generatorFactory.mockClear();
  generated.mockReset().mockResolvedValue({
    sources: [
      {
        sourceId: 's1',
        materialId: MATERIAL,
        role: 'student_work',
        name: 'fictional-work.txt',
        mimeType: 'text/plain',
        sha256: 'b'.repeat(64),
        extractorId: 'fictional-text',
        extractorVersion: '1',
        ocr: false,
        blocks: [{ blockId: 'b1', text: 'Fictional solution steps: x = 3.' }],
      },
    ],
    report: {
      readiness: 'sufficient',
      observations: [
        {
          category: 'needs_verification',
          text: 'Confirm the work independently.',
          citations: [{ sourceId: 's1', blockId: 'b1', quote: 'x = 3' }],
        },
      ],
      recommendations: [],
      limitations: ['A single attempt does not establish mastery.'],
    },
    model: { providerId: 'fictional-provider', modelId: 'fictional-model' },
  });
  state.store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `fictional-analysis-http-${Math.random()}`,
    payloadValidators: {
      ...APP_RUNTIME_PAYLOAD_VALIDATORS,
      [TEACHER_ANALYSIS_KIND]: validateTeacherAnalysis,
    },
  });
  profileId = (
    await createTeacherStudent(
      { store: state.store, ownerId: `anon:${OWNER}` },
      {
        requestId: 'aa583ee3-e74c-4089-8283-65e070cb2c04',
        nickname: 'Fictional HTTP student',
        grade: null,
        examYear: null,
        region: null,
      },
    )
  ).student.profile.profileId;
});

describe('teacher analysis HTTP routes', () => {
  it('creates, replays and reads private report snapshots without reselecting a model', async () => {
    const response = await POST(
      req('POST', INPUT, { 'x-api-key': 'FICTIONAL_KEY_NOT_FOR_STORAGE' }),
      context(),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('set-cookie')).toContain(OWNER);
    const { analysis } = await response.json();
    expect(JSON.stringify(analysis)).not.toContain('FICTIONAL_KEY_NOT_FOR_STORAGE');
    expect(generated.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    const replay = await POST(req('POST', INPUT), context());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ analysis });
    expect(await (await GET(req(), context())).json()).toEqual({ analyses: [analysis] });
    expect(await (await detail(req(), detailContext(analysis.analysisId))).json()).toEqual({
      analysis,
    });
    expect(generatorFactory).toHaveBeenCalledTimes(1);
    expect(generated).toHaveBeenCalledTimes(1);
  });

  it('saves, confirms and withdraws through explicit revision checked PATCH actions', async () => {
    const { analysis } = await (await POST(req('POST', INPUT), context())).json();
    const patch = (
      current: typeof analysis,
      action: string,
      teacherComment = current.teacherComment,
    ) =>
      PATCH(
        req('PATCH', {
          expectedUpdatedAt: current.updatedAt,
          action,
          report: current.report,
          teacherComment,
        }),
        detailContext(current.analysisId),
      );
    const saved = await patch(analysis, 'save_draft', 'Teacher checked the source.');
    expect(saved.status).toBe(200);
    const draft = (await saved.json()).analysis;
    const reviewed = (await (await patch(draft, 'confirm_review')).json()).analysis;
    expect(reviewed.status).toBe('reviewed');
    const withdrawn = (await (await patch(reviewed, 'withdraw')).json()).analysis;
    expect(withdrawn.status).toBe('withdrawn');
    const stale = await patch(draft, 'save_draft');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ errorCode: 'ANALYSIS_CONFLICT' });
  });

  it('blocks foreign teacher and student access with safe 404 responses', async () => {
    const { analysis } = await (await POST(req('POST', INPUT), context())).json();
    const foreign = req('GET', undefined, {
      cookie: 'anonymous_id=aa583ee3-e74c-4089-8283-65e070cb2c04',
    });
    const denied = await detail(foreign, detailContext(analysis.analysisId));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ errorCode: 'ANALYSIS_NOT_FOUND' });
    const missing = await GET(req(), {
      params: Promise.resolve({ profileId: `teacher-student:v1:${'f'.repeat(64)}` }),
    });
    expect(missing.status).toBe(404);
    expect(generated).toHaveBeenCalledTimes(1);
  });

  it.each<Record<string, string>>([
    { origin: 'https://other.invalid' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects cross-origin writes before storage: %j', async (headers) => {
    const denied = await POST(req('POST', INPUT, headers), context());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ errorCode: 'ANALYSIS_ORIGIN_REJECTED' });
    expect(denied.headers.get('cache-control')).toBe('private, no-store');
    expect(provider).not.toHaveBeenCalled();
    expect(generated).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON, invalid encoding, oversized bodies and unknown fields', async () => {
    const malformed = new NextRequest(`${ORIGIN}/api/teacher/students/${profileId}/analyses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array([0xc3, 0x28]),
    });
    for (const request of [
      malformed,
      req('POST', INPUT, { 'content-type': 'text/plain' }),
      req('POST', { ...INPUT, profileId: 'injected' }),
    ]) {
      const response = await POST(request, context());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ errorCode: 'ANALYSIS_INPUT_INVALID' });
    }
    const oversized = await POST(
      req('POST', { ...INPUT, teacherNotes: 'a'.repeat(256 * 1024) }),
      context(),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ errorCode: 'ANALYSIS_INPUT_TOO_LARGE' });
    expect(generated).not.toHaveBeenCalled();
  });

  it('returns safe disabled, model failure and cancellation errors without storing a report', async () => {
    configured.mockReturnValue(false);
    const disabled = await GET(req(), context());
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toEqual({ errorCode: 'ANALYSIS_UNAVAILABLE' });
    configured.mockReturnValue(true);
    generated.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_URL_AND_CREDENTIAL'));
    const failed = await POST(req('POST', INPUT), context());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ errorCode: 'ANALYSIS_MODEL_UNAVAILABLE' });
    const controller = new AbortController();
    const canceled = new NextRequest(`${ORIGIN}/api/teacher/students/${profileId}/analyses`, {
      method: 'POST',
      headers: { cookie: `anonymous_id=${OWNER}`, 'content-type': 'application/json' },
      body: JSON.stringify(INPUT),
      signal: controller.signal,
    });
    controller.abort();
    expect((await POST(canceled, context())).status).toBe(408);
    expect(await (await GET(req(), context())).json()).toEqual({ analyses: [] });
  });
});
