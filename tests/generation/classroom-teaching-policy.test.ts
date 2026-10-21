import { describe, expect, it, vi } from 'vitest';
import type { UserRequirements } from '@openmaic/generation';
import {
  CLASSROOM_CONTENT_REVIEW_VERSION,
  matchesClassroomContentProof,
  matchesClassroomScopeLedger,
  reviewClassroomContent,
  reviewClassroomContentScoped,
  type ClassroomContentCallbacks,
  type ClassroomReviewPacket,
  type ClassroomScopeEntry,
} from '@/lib/server/classroom-content-review';

const requirements: UserRequirements = {
  requirement: 'Review the supplied source and every classroom target.',
  codeContextRequired: true,
  codemateSource: {
    title: 'Echo', content: 'Read and output one line.', language: 'Python',
    code: 'value = input()\nprint(value)\n',
    correctedCode: 'value = input()\nprint(value)\n',
    referenceValidation: { status: 'unknown', scope: 'not_supplied' },
  },
};
function material() {
  return {
    stage: { id: 'stage' },
    scenes: [
      { id: 'slide', type: 'slide', title: 'Unresolved wording', content: { type: 'slide', canvas: { elements: [{ id: 'element', type: 'text', content: '<p>Read one line.</p>', fill: '#112233' }] } }, actions: [{ id: 'speech', type: 'speech', text: 'Original explanation' }] },
      { id: 'widget', type: 'interactive', title: 'Widget', content: { type: 'interactive', html: '<div>Complete original HTML.</div>' }, actions: [] },
      { id: 'quiz', type: 'quiz', title: 'Quiz', content: { type: 'quiz', questions: [{ id: 'q', type: 'single', question: 'Which value is echoed?', options: [{ value: 'A', label: 'Input' }, { value: 'B', label: 'Nothing' }], answer: ['A'], analysis: 'The input is echoed.' }] }, actions: [] },
    ],
  };
}
function rawFinding(p: ClassroomReviewPacket, sceneId: string, path: string, kind: 'fact' | 'text' = 'fact') {
  const field = p.fieldPathCatalog.find((s) => s.sceneId === sceneId)!.fields.find((f) => f.path === path)!;
  expect(field).toBeDefined();
  return { field_ref: field.fieldRef, reason: 'The target contains a specific unresolved discrepancy.', required_change: 'Correct the identified discrepancy in this target.', kind, affects_code: false, affects_root: false };
}
function response(p: ClassroomReviewPacket, findings: unknown[] = []) {
  return JSON.stringify({
    review_version: p.binding.reviewVersion,
    source_digest: p.binding.sourceDigest,
    material_digest: p.binding.materialDigest,
    review_snapshot_digest: p.binding.reviewSnapshotDigest,
    reviewed_scene_ids: p.reviewScope?.sceneIds ?? p.binding.sceneIds,
    ...(p.reviewScope ? { scope_version: p.reviewScope.version, scope_id: p.reviewScope.id, scope_kind: p.reviewScope.kind, scope_digest: p.reviewScope.digest } : {}),
    content_pass: findings.length === 0, findings,
  });
}
function run(callbacks: ClassroomContentCallbacks, records: ClassroomScopeEntry[] = []) {
  return reviewClassroomContentScoped({ requirements, material: material(), callbacks, expectedSceneCount: 3, signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, recordScope: (entry) => { records.push(entry); } });
}

describe('strict teaching policy preserves every unresolved finding', () => {
  for (const [sceneId, path] of [
    ['widget', '/content/html'],
    ['quiz', '/content/questions/0/answer/0'],
    ['slide', '/content/canvas/elements/0/fill'],
    ['slide', '/content/canvas/elements/0/id'],
  ]) {
    it.each(['fact', 'text'] as const)(`rejects ${sceneId}${path} with %s and both original flags false after all locals finish`, async (kind) => {
      const records: ClassroomScopeEntry[] = [];
      const completed: string[] = [];
      const repair = vi.fn();
      await expect(run({
        review: async (p) => {
          completed.push(p.reviewScope!.id);
          return response(p, p.reviewScope!.sceneIds[0] === sceneId ? [rawFinding(p, sceneId, path, kind)] : []);
        }, repair,
      }, records)).rejects.toMatchObject({ code: 'requires_regeneration' });
      expect(completed).toHaveLength(3);
      expect(completed).not.toContain('cross:complete');
      expect(records).toHaveLength(3);
      const findings = records.flatMap((entry) => entry.findings);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ sceneId, path, kind, affectsCode: false, affectsRoot: false });
      expect(repair).not.toHaveBeenCalled();
    });
  }

  it.each(['fact', 'text'] as const)('rejects a complete cross-only %s finding without reclassifying its false flags', async (kind) => {
    const records: ClassroomScopeEntry[] = [];
    const repair = vi.fn();
    await expect(run({ review: async (p) => response(p, p.reviewScope!.kind === 'cross_scene' ? [rawFinding(p, 'widget', '/content/html', kind)] : []), repair }, records)).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(records).toHaveLength(4);
    expect(records[3].findings[0]).toMatchObject({ kind, affectsCode: false, affectsRoot: false });
    expect(repair).not.toHaveBeenCalled();
  });

  it.each(['fact', 'text'] as const)('also rejects nonrepairable %s findings in the full-material entry point', async (kind) => {
    const repair = vi.fn();
    const records: unknown[] = [];
    await expect(reviewClassroomContent({ requirements, material: material(), expectedSceneCount: 3, callbacks: { review: async (p) => response(p, [rawFinding(p, 'quiz', '/content/questions/0/answer/0', kind)]), repair }, record: async (proof) => { records.push(proof); } })).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ contentPass: false, findings: [{ affectsCode: false, affectsRoot: false, kind }] });
    expect(repair).not.toHaveBeenCalled();
  });

  it('preserves mixed repairable and nonrepairable findings and never filters the latter into a repair', async () => {
    const records: ClassroomScopeEntry[] = [];
    const repair = vi.fn();
    await expect(run({
      review: async (p) => response(p, p.reviewScope!.sceneIds[0] === 'slide' ? [rawFinding(p, 'slide', '/title')] : p.reviewScope!.sceneIds[0] === 'widget' ? [rawFinding(p, 'widget', '/content/html')] : []), repair,
    }, records)).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(records.flatMap((entry) => entry.findings).map((f) => f.path).sort()).toEqual(['/content/html', '/title']);
    expect(records.flatMap((entry) => entry.findings).every((f) => !f.affectsCode && !f.affectsRoot)).toBe(true);
    expect(repair).not.toHaveBeenCalled();
  });

  it('sends all safely repairable findings to repair and accepts only the empty complete re-review', async () => {
    let calls = 0;
    const repair = vi.fn(async (p: Parameters<NonNullable<ClassroomContentCallbacks['repair']>>[0]) => {
      expect(p.findings).toHaveLength(4);
      expect([...new Set(p.findings.map((f) => f.path))].sort()).toEqual(['/actions/0/text', '/title']);
      expect(p.findings.every((f) => !f.affectsCode && !f.affectsRoot)).toBe(true);
      return JSON.stringify({ review_version: p.binding.reviewVersion, source_digest: p.binding.sourceDigest, material_digest: p.binding.materialDigest, review_snapshot_digest: p.binding.reviewSnapshotDigest, patches: [...new Map(p.findings.map((f) => [f.fieldRef, { field_ref: f.fieldRef, new_text: f.path === '/title' ? 'Resolved title' : 'Resolved explanation' }])).values()] });
    });
    const result = await run({ review: async (p) => {
      calls++;
      return response(p, p.binding.reportVersion === 1 && p.reviewScope!.sceneIds[0] === 'slide' ? [rawFinding(p, 'slide', '/title'), rawFinding(p, 'slide', '/actions/0/text')] : []);
    }, repair });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(calls).toBe(8);
    expect(result.proof).toMatchObject({ contentPass: true, findings: [] });
    expect(result.ledger.entries.every((entry) => entry.contentPass && entry.findings.length === 0)).toBe(true);
  });

  it('requires regeneration when confirmed text remains after the permitted repair', async () => {
    const repair = vi.fn(async (p: Parameters<NonNullable<ClassroomContentCallbacks['repair']>>[0]) => JSON.stringify({ review_version: p.binding.reviewVersion, source_digest: p.binding.sourceDigest, material_digest: p.binding.materialDigest, review_snapshot_digest: p.binding.reviewSnapshotDigest, patches: [{ field_ref: p.findings[0].fieldRef, new_text: 'Changed but still unresolved' }] }));
    await expect(run({ review: async (p) => response(p, p.reviewScope!.sceneIds[0] === 'slide' ? [rawFinding(p, 'slide', '/title')] : []), repair })).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('invalidates old wide-exemption pass proofs and ledgers without relabelling their bindings', async () => {
    const result = await run({ review: async (p) => response(p) });
    expect(CLASSROOM_CONTENT_REVIEW_VERSION).toBe('native-classroom-content-teaching-policy-v4-20261021');
    const oldProof = structuredClone(result.proof);
    const oldLedger = structuredClone(result.ledger);
    Object.assign(oldProof.binding, { reviewVersion: 'native-classroom-content-readable-ref-v3-20261015' });
    Object.assign(oldLedger.binding, { reviewVersion: 'native-classroom-content-readable-ref-v3-20261015' });
    expect(matchesClassroomContentProof(requirements, result.material, oldProof)).toBe(false);
    expect(matchesClassroomScopeLedger(requirements, result.material, oldLedger)).toBe(false);
    expect(matchesClassroomContentProof(requirements, result.material, result.proof)).toBe(true);
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
  });

  it.each([false, true])('rejects a current-version ledger with an unresolved finding even when contentPass is %s', async (pass) => {
    const packets: ClassroomReviewPacket[] = [];
    const result = await run({ review: async (p) => { packets.push(p); return response(p); } });
    const ledger = structuredClone(result.ledger);
    const entry = ledger.entries.find((e) => e.scope.id === 'scene:2')!;
    const packet = packets.find((p) => p.reviewScope!.id === 'scene:2')!;
    const raw = rawFinding(packet, 'widget', '/content/html');
    entry.contentPass = pass;
    entry.findings = [{ fieldRef: raw.field_ref, sceneId: 'widget', path: '/content/html', quotedText: '<div>Complete original HTML.</div>', reason: raw.reason, requiredChange: raw.required_change, kind: raw.kind, affectsCode: false, affectsRoot: false }];
    expect(matchesClassroomScopeLedger(requirements, result.material, ledger)).toBe(false);
  });
});
