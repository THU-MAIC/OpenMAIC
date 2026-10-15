import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UserRequirements } from '@openmaic/generation';
import {
  CLASSROOM_CONTENT_REVIEW_VERSION,
  createClassroomContentCallbacks,
  matchesClassroomContentProof,
  reviewClassroomContent,
  type ClassroomContentProof,
  type ClassroomReviewPacket,
} from '@/lib/server/classroom-content-review';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
interface FixtureScene {
  id: string;
  stageId: string;
  type: string;
  title: string;
  order: number;
  content: {
    type: string;
    html?: string;
    canvas?: { elements: Array<{ id: string; type: string; content: string }> };
    widgetConfig?: { starterCode: string; testCases: Array<{ input: string; expected: string }> };
    questions?: Array<{
      id: string;
      type: string;
      question: string;
      options: Array<{ value: string; label: string }>;
      answer: string[];
      analysis: string;
    }>;
  };
  actions: Array<{
    id: string;
    type: string;
    text?: string;
    audioId?: string;
    audioUrl?: string;
    audioInvalidated?: boolean;
    state?: { x: number };
  }>;
}
interface FixtureMaterial {
  stage: { id: string; name: string; createdAt: number; updatedAt: number };
  scenes: FixtureScene[];
}
function requirements(): UserRequirements {
  return {
    requirement: '对实际原题和原代码讲解，保留完整数据。',
    codeContextRequired: true,
    codemateSource: {
      title: '题目',
      content: '完整题面\n1 2\n',
      code: 'x = input()\nprint(x)\n',
      correctedCode: 'x = input()\nprint(x)\n',
      language: 'Python',
      analysis: { claim: '待核假设' },
      referenceValidation: { status: 'unknown', scope: 'not_supplied' },
    },
  };
}
function material(): FixtureMaterial {
  return {
    stage: { id: 'stage', name: '课程', createdAt: 1, updatedAt: 1 },
    scenes: [
      {
        id: 'slide',
        stageId: 'stage',
        type: 'slide',
        title: '例子',
        order: 0,
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'text', type: 'text', content: '<p>待核文字</p>' }] },
        },
        actions: [
          {
            id: 'speech',
            type: 'speech',
            text: '旧旁白',
            audioId: 'old-audio',
            audioUrl: '/old.mp3',
          },
        ],
      },
      {
        id: 'widget',
        stageId: 'stage',
        type: 'interactive',
        title: '互动',
        order: 1,
        content: {
          type: 'interactive',
          html: '<button onclick="step()">next</button><script>function step(){x++}</script>',
          widgetConfig: { starterCode: 'x = 0', testCases: [{ input: '1', expected: '1' }] },
        },
        actions: [{ id: 'state', type: 'widget_setState', state: { x: 0 } }],
      },
      {
        id: 'quiz',
        stageId: 'stage',
        type: 'quiz',
        title: '检查',
        order: 2,
        content: {
          type: 'quiz',
          questions: [
            {
              id: 'q',
              type: 'single',
              question: '问题',
              options: [
                { value: 'A', label: '选项一' },
                { value: 'B', label: '选项二' },
              ],
              answer: ['A'],
              analysis: '完整解析',
            },
          ],
        },
        actions: [{ id: 'last-speech', type: 'speech', text: '末尾旁白必须审查' }],
      },
    ],
  };
}
function answer(
  packet: ClassroomReviewPacket,
  findings: unknown[] = [],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    review_version: packet.binding.reviewVersion,
    content_pass: findings.length === 0,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
    reviewed_scene_ids: packet.binding.sceneIds,
    findings,
    ...overrides,
  });
}
function legacyFinding(overrides: Record<string, unknown> = {}) {
  return {
    scene_id: 'slide',
    path: '/actions/0/text',
    quoted_text: '旧旁白',
    reason: '需完善文字',
    required_change: '改为明确文字',
    kind: 'text',
    affects_code: false,
    affects_root: false,
    ...overrides,
  };
}
function ref(packet: ClassroomReviewPacket, sceneId = 'slide', path = '/actions/0/text'): string {
  const field = packet.fieldPathCatalog
    .find((entry) => entry.sceneId === sceneId)
    ?.fields.find((entry) => entry.path === path);
  if (!field) throw new Error('Fixture field missing');
  return field.fieldRef;
}
function finding(packet: ClassroomReviewPacket, overrides: Record<string, unknown> = {}) {
  return {
    field_ref: Object.hasOwn(overrides, 'field_ref') ? overrides.field_ref : ref(packet),
    reason: '需完善文字',
    required_change: '改为明确文字',
    kind: 'text',
    affects_code: false,
    affects_root: false,
    ...overrides,
  };
}
function patchAnswer(
  packet: ClassroomReviewPacket,
  patches: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    review_version: packet.binding.reviewVersion,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
    patches,
    ...overrides,
  });
}
const accept = async (packet: ClassroomReviewPacket) => answer(packet);

describe('native classroom content contract', () => {
  it('binds full source and every material type while excluding only standard speech audio references', async () => {
    const source = requirements(),
      doc = material();
    const result = await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: { review: accept },
    });
    expect(matchesClassroomContentProof(source, result.material, result.proof)).toBe(true);
    expect(result.proof.binding.reviewVersion).toBe(CLASSROOM_CONTENT_REVIEW_VERSION);
    for (const mutate of [
      (next: typeof doc) => {
        next.scenes[0].title = '另一标题';
      },
      (next: typeof doc) => {
        next.scenes[1].content.html = '<script>x--</script>';
      },
      (next: typeof doc) => {
        next.scenes[2].content.questions![0].answer = ['B'];
      },
      (next: typeof doc) => {
        next.scenes[2].content.questions![0].analysis = '另一解析';
      },
      (next: typeof doc) => {
        next.scenes[2].actions[0].text = '另一旁白';
      },
      (next: typeof doc) => {
        next.scenes[0].actions[0].id = 'split-new-id';
      },
    ]) {
      const next = copy(doc);
      mutate(next);
      expect(matchesClassroomContentProof(source, next, result.proof)).toBe(false);
    }
    const audio = copy(doc);
    audio.scenes[0].actions[0].audioId = 'new-audio';
    audio.scenes[0].actions[0].audioUrl = '/new.mp3';
    expect(matchesClassroomContentProof(source, audio, result.proof)).toBe(true);
    const changedSource = copy(source);
    changedSource.codemateSource!.code += ' ';
    expect(matchesClassroomContentProof(changedSource, doc, result.proof)).toBe(false);
    const nonSpeechAudio = copy(doc);
    Object.assign(nonSpeechAudio.scenes[1].actions[0], { audioId: 'not-a-standard-speech-link' });
    expect(matchesClassroomContentProof(source, nonSpeechAudio, result.proof)).toBe(false);
  });

  it('retains ordinary requirements compatibility without guessing code context from title', async () => {
    const source = { requirement: '普通课程', codeContextRequired: false };
    const result = await reviewClassroomContent({
      requirements: source,
      material: material(),
      callbacks: { review: accept },
    });
    expect(result.proof.binding.sourceScope).toBe('general_requirements_only');
    expect(result.proof.contentPass).toBe(true);
  });

  it('fails before any callback for explicitly required but missing source or invalid historical proof scope', async () => {
    const review = vi.fn(accept);
    await expect(
      reviewClassroomContent({
        requirements: { requirement: '课程', codeContextRequired: true },
        material: material(),
        callbacks: { review },
      }),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    const source = requirements();
    source.codemateSource!.referenceValidation = {
      status: 'stored-passed',
      scope: 'current_suite_claim',
      codeHash: digest(source.codemateSource!.correctedCode),
    };
    await expect(
      reviewClassroomContent({ requirements: source, material: material(), callbacks: { review } }),
    ).rejects.toMatchObject({ code: 'source_validation_invalid' });
    expect(review).not.toHaveBeenCalled();
    const noInlineCode = material();
    delete noInlineCode.scenes[1].content.html;
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: noInlineCode,
        callbacks: { review },
      }),
    ).rejects.toMatchObject({ code: 'material_incomplete' });
    expect(review).not.toHaveBeenCalled();
  });

  it('accepts only exact old-reference hash/scope and never upgrades it to current judge evidence', async () => {
    const source = requirements();
    source.codemateSource!.referenceValidation = {
      status: 'stored-passed',
      scope: 'original_validation_run_current_suite_not_revalidated_for_classroom',
      codeHash: digest(source.codemateSource!.correctedCode),
    };
    const result = await reviewClassroomContent({
      requirements: source,
      material: material(),
      callbacks: { review: accept },
    });
    expect(result.proof.scope).toContain('not_widget_execution_judge_audio_or_pixels');
    source.codemateSource!.referenceValidation.codeHash = '0'.repeat(64);
    await expect(
      reviewClassroomContent({
        requirements: source,
        material: material(),
        callbacks: { review: accept },
      }),
    ).rejects.toMatchObject({ code: 'source_validation_invalid' });
  });

  it('rejects partial scene coverage, stale hashes and legacy invented or cross-field quotes', async () => {
    for (const review of [
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [], { reviewed_scene_ids: ['slide', 'widget'] }),
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [], { material_digest: '0'.repeat(64) }),
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [legacyFinding({ quoted_text: '未出现的原文' })]),
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [legacyFinding({ path: '/title', quoted_text: '旧旁白' })]),
    ])
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks: { review },
        }),
      ).rejects.toBeDefined();
  });

  it('rejects fenced/non-JSON reviews, missing flags, unsupported locations and a pass with findings', async () => {
    for (const review of [
      async (packet: ClassroomReviewPacket) => '```json\n' + answer(packet) + '\n```',
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { affects_code: undefined })]),
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [legacyFinding({ path: '/__proto__/text' })]),
      async (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet)], { content_pass: true }),
    ])
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks: { review },
        }),
      ).rejects.toMatchObject({ code: 'review_unavailable' });
  });

  it('does not repair any code/root finding or protected HTML, quiz answer or widget-code field', async () => {
    for (const makeFinding of [
      (packet: ClassroomReviewPacket) => finding(packet, { affects_code: true }),
      (packet: ClassroomReviewPacket) => finding(packet, { kind: 'root', affects_root: true }),
      (packet: ClassroomReviewPacket) =>
        finding(packet, { field_ref: ref(packet, 'widget', '/content/html'), kind: 'fact' }),
      (packet: ClassroomReviewPacket) =>
        finding(packet, {
          field_ref: ref(packet, 'quiz', '/content/questions/0/answer/0'),
          kind: 'fact',
        }),
      (packet: ClassroomReviewPacket) =>
        finding(packet, {
          field_ref: ref(packet, 'widget', '/content/widgetConfig/starterCode'),
          kind: 'fact',
        }),
    ]) {
      const repair = vi.fn(async () => '{}');
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks: { review: async (packet) => answer(packet, [makeFinding(packet)]), repair },
        }),
      ).rejects.toMatchObject({ code: 'requires_regeneration' });
      expect(repair).not.toHaveBeenCalled();
    }
  });

  it('requires code/root flags for claims labeled as code/root defects', async () => {
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks: {
          review: async (packet) => answer(packet, [finding(packet, { kind: 'code_logic' })]),
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
  });

  it('allows one directed prose repair, invalidates old narration audio, and rechecks all scenes under new hashes', async () => {
    const reviewInputs: ClassroomReviewPacket[] = [],
      source = requirements(),
      doc = material();
    const result = await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: {
        review: async (packet) => {
          reviewInputs.push(packet);
          return answer(packet, reviewInputs.length === 1 ? [finding(packet)] : []);
        },
        repair: async (packet) =>
          patchAnswer(packet, [{ field_ref: ref(packet), new_text: '新旁白' }]),
      },
    });
    expect(reviewInputs).toHaveLength(2);
    expect(reviewInputs[1].binding.sceneIds).toEqual(['slide', 'widget', 'quiz']);
    expect(reviewInputs[1].binding.materialDigest).not.toBe(reviewInputs[0].binding.materialDigest);
    expect(reviewInputs[1].material).toHaveProperty(
      'scenes.2.content.questions.0.analysis',
      '完整解析',
    );
    expect(result.material.scenes[0].actions[0]).toMatchObject({
      text: '新旁白',
      audioInvalidated: true,
    });
    expect(result.material.scenes[0].actions[0]).not.toHaveProperty('audioId');
    expect(result.material.scenes[0].actions[0]).not.toHaveProperty('audioUrl');
    expect(doc.scenes[0].actions[0].text).toBe('旧旁白');
    expect(matchesClassroomContentProof(source, doc, result.proof)).toBe(false);
  });

  it('does not retry again when the complete second review still rejects', async () => {
    const repair = vi.fn(async (packet: ClassroomReviewPacket) =>
      patchAnswer(packet, [{ field_ref: ref(packet), new_text: '新旁白' }]),
    );
    let calls = 0;
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks: {
          review: async (packet) => {
            calls++;
            return answer(packet, [finding(packet)]);
          },
          repair,
        },
      }),
    ).rejects.toMatchObject({ code: 'content_unresolved' });
    expect(calls).toBe(2);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('rejects unrelated repairs and changing markup/embedded code during a supposed text-only repair', async () => {
    for (const newText of [
      '<p onclick="run()">新文字</p>',
      '<p><script>run()</script>新文字</p>',
    ]) {
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks: {
            review: async (packet) =>
              answer(packet, [
                finding(packet, {
                  field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
                }),
              ]),
            repair: async (packet) =>
              patchAnswer(packet, [
                {
                  field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
                  new_text: newText,
                },
              ]),
          },
        }),
      ).rejects.toMatchObject({ code: 'requires_regeneration' });
    }
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks: {
          review: async (packet) => answer(packet, [finding(packet)]),
          repair: async (packet) =>
            patchAnswer(packet, [
              {
                field_ref: ref(packet, 'quiz', '/content/questions/0/analysis'),
                new_text: '其他解析',
              },
            ]),
        },
      }),
    ).rejects.toMatchObject({ code: 'repair_invalid' });
    const doc = material();
    doc.scenes[0].content.canvas!.elements[0].content = '<pre><code>x=1</code></pre><p>措辞</p>';
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: doc,
        callbacks: {
          review: async (packet) =>
            answer(packet, [
              finding(packet, {
                field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
              }),
            ]),
          repair: async (packet) =>
            patchAnswer(packet, [
              {
                field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
                new_text: '<pre><code>x=2</code></pre><p>新措辞</p>',
              },
            ]),
        },
      }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
  });

  it('rejects a changed source during a review and a partial generation before any model callback', async () => {
    const source = requirements();
    await expect(
      reviewClassroomContent({
        requirements: source,
        material: material(),
        callbacks: {
          review: async (packet) => {
            source.codemateSource!.code += ' ';
            return answer(packet);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'binding_mismatch' });
    const review = vi.fn(accept);
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        expectedSceneCount: 4,
        callbacks: { review },
      }),
    ).rejects.toMatchObject({ code: 'material_incomplete' });
    expect(review).not.toHaveBeenCalled();
  });

  it('passes complete bytes through the existing AICallFn and never includes a heldout annotation', async () => {
    const source = requirements();
    source.codemateSource!.content = '题面'.repeat(40000) + '末尾完整锚点';
    const doc = material();
    doc.scenes[2].actions[0].text = '完整末尾旁白';
    const aiCall = vi.fn(async (_system: string, user: string) => {
      const packet = JSON.parse(user) as ClassroomReviewPacket;
      expect(packet.requirements.codemateSource!.content).toBe(source.codemateSource!.content);
      expect(user).toContain('完整末尾旁白');
      expect(user).toContain('function step()');
      expect(user).toContain('完整解析');
      expect(user).not.toContain('private_human_oracle');
      return answer(packet);
    });
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: createClassroomContentCallbacks(aiCall),
    });
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('rejects oversize input instead of slicing it and accepting a partial proof', async () => {
    const source = requirements();
    source.codemateSource!.content = 'x'.repeat(1100000);
    const review = vi.fn(accept);
    await expect(
      reviewClassroomContent({ requirements: source, material: material(), callbacks: { review } }),
    ).rejects.toMatchObject({ code: 'context_too_large' });
    expect(review).not.toHaveBeenCalled();
  });

  it('catalogs all addressable strings with unique packet-bound refs without duplicating or truncating material', async () => {
    const source = requirements();
    const doc = material();
    let captured: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: {
        review: async (packet) => {
          captured = packet;
          return answer(packet);
        },
      },
    });
    expect(captured!.requirements).toEqual(source);
    expect(captured!.material).toEqual(doc);
    const expected = [
      {
        sceneId: 'slide',
        paths: [
          '/id',
          '/stageId',
          '/type',
          '/title',
          '/content/type',
          '/content/canvas/elements/0/id',
          '/content/canvas/elements/0/type',
          '/content/canvas/elements/0/content',
          '/actions/0/id',
          '/actions/0/type',
          '/actions/0/text',
          '/actions/0/audioId',
          '/actions/0/audioUrl',
        ],
      },
      {
        sceneId: 'widget',
        paths: [
          '/id',
          '/stageId',
          '/type',
          '/title',
          '/content/type',
          '/content/html',
          '/content/widgetConfig/starterCode',
          '/content/widgetConfig/testCases/0/input',
          '/content/widgetConfig/testCases/0/expected',
          '/actions/0/id',
          '/actions/0/type',
        ],
      },
      {
        sceneId: 'quiz',
        paths: [
          '/id',
          '/stageId',
          '/type',
          '/title',
          '/content/type',
          '/content/questions/0/id',
          '/content/questions/0/type',
          '/content/questions/0/question',
          '/content/questions/0/options/0/value',
          '/content/questions/0/options/0/label',
          '/content/questions/0/options/1/value',
          '/content/questions/0/options/1/label',
          '/content/questions/0/answer/0',
          '/content/questions/0/analysis',
          '/actions/0/id',
          '/actions/0/type',
          '/actions/0/text',
        ],
      },
    ];
    expect(
      captured!.fieldPathCatalog.map((entry) => ({
        sceneId: entry.sceneId,
        paths: entry.fields.map((field) => field.path).sort(),
      })),
    ).toEqual(expected.map((entry) => ({ ...entry, paths: [...entry.paths].sort() })));
    expect(JSON.stringify(captured!.fieldPathCatalog)).not.toContain('旧旁白');
    expect(JSON.stringify(captured!.fieldPathCatalog)).not.toContain('function step()');
    expect(Object.isFrozen(captured!.fieldPathCatalog)).toBe(true);
    expect(captured!.fieldPathCatalog.every((entry) => Object.isFrozen(entry.fields))).toBe(true);
    const refs = captured!.fieldPathCatalog.flatMap((entry) =>
      entry.fields.map((field) => field.fieldRef),
    );
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.every((value) => /^scene[1-9]\d*\/[\s\S]+#[a-f0-9]{32}$/.test(value))).toBe(true);
    for (const [index, entry] of captured!.fieldPathCatalog.entries()) {
      for (const field of entry.fields) {
        expect(field.fieldRef.startsWith(`scene${index + 1}${field.path}#`)).toBe(true);
        const value = field.fieldRef.substring(field.fieldRef.lastIndexOf('#') + 1);
        expect(value).toHaveLength(32);
      }
    }
  });

  it('uses escaped object keys and numeric array paths without advertising parser-forbidden addresses', async () => {
    const doc = material();
    const content = doc.scenes[1].content;
    Object.assign(content, { 'a/b~c': { '~key/': ['exact &lt;quote&gt;\\n'] }, blank: ' \n' });
    Object.defineProperty(content, '__proto__', { value: 'blocked_proto', enumerable: true });
    Object.defineProperty(content, 'constructor', {
      value: 'blocked_constructor',
      enumerable: true,
    });
    Object.defineProperty(content, 'prototype', { value: 'blocked_prototype', enumerable: true });
    Object.defineProperty(content, '', { value: 'blocked_empty_key', enumerable: true });
    Object.defineProperty(content, 'x'.repeat(501), {
      value: 'blocked_long_path',
      enumerable: true,
    });
    let deep: Record<string, unknown> = { leaf: 'blocked_deep_path' };
    for (let index = 0; index < 21; index++) deep = { nest: deep };
    Object.assign(content, { deep });
    let captured: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: doc,
      callbacks: {
        review: async (packet) => {
          captured = packet;
          return answer(packet);
        },
      },
    });
    const paths = captured!.fieldPathCatalog
      .find((entry) => entry.sceneId === 'widget')!
      .fields.map((field) => field.path);
    expect(paths).toContain('/content/a~1b~0c/~0key~1/0');
    expect(paths).toContain('/content/widgetConfig/testCases/0/expected');
    expect(paths).not.toContain('/content/blank');
    expect(
      paths.some(
        (path) =>
          path.includes('__proto__') || path.includes('constructor') || path.includes('prototype'),
      ),
    ).toBe(false);
    expect(paths.some((path) => path.startsWith('/content/deep/'))).toBe(false);
    expect(paths.every((path) => path.length <= 500)).toBe(true);
    // Unaddressable values are still present in the full material, never sliced.
    const sentContent = (captured!.material as unknown as FixtureMaterial).scenes[1].content;
    for (const [key, value] of [
      ['__proto__', 'blocked_proto'],
      ['constructor', 'blocked_constructor'],
      ['prototype', 'blocked_prototype'],
      ['', 'blocked_empty_key'],
      ['x'.repeat(501), 'blocked_long_path'],
    ]) {
      expect(Object.getOwnPropertyDescriptor(sentContent, key)?.value).toBe(value);
    }
    expect(JSON.stringify(Object.getOwnPropertyDescriptor(sentContent, 'deep')?.value)).toBe(
      JSON.stringify(deep),
    );
    const repair = vi.fn(async () => '{}');
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: doc,
        callbacks: {
          review: async (packet) =>
            answer(packet, [
              finding(packet, { field_ref: ref(packet, 'widget', '/content/a~1b~0c/~0key~1/0') }),
            ]),
          repair,
        },
      }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(repair).not.toHaveBeenCalled();
  });

  it('includes address catalog overhead in the unchanged total 1 MiB cap before any callback', async () => {
    const source = requirements();
    const doc = material();
    let packet: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: {
        review: async (input) => {
          packet = input;
          return answer(input);
        },
      },
    });
    const legacyEnvelope: Partial<ClassroomReviewPacket> = copy(packet!);
    delete legacyEnvelope.fieldPathCatalog;
    const limit = 1024 * 1024;
    source.codemateSource!.content = 'x'.repeat(
      limit -
        Buffer.byteLength(JSON.stringify(legacyEnvelope)) +
        Buffer.byteLength(source.codemateSource!.content) -
        64,
    );
    legacyEnvelope.requirements = copy(source);
    expect(Buffer.byteLength(JSON.stringify(legacyEnvelope))).toBeLessThan(limit);
    const review = vi.fn(accept);
    await expect(
      reviewClassroomContent({ requirements: source, material: doc, callbacks: { review } }),
    ).rejects.toMatchObject({ code: 'context_too_large' });
    expect(review).not.toHaveBeenCalled();
  });

  it('rejects legacy paths and raw, cross-field or decoded quotes without normalizing to a ref', async () => {
    const doc = material();
    doc.scenes[0].content.canvas!.elements[0].content = '<p>&lt;x&gt;\\n</p>';
    for (const item of [
      legacyFinding({
        scene_id: 'widget',
        path: '/widgetConfig/starterCode',
        quoted_text: 'x = 0',
      }),
      legacyFinding({ scene_id: 'widget', path: '/content/html', quoted_text: 'x = 0' }),
      legacyFinding({ path: '/title', quoted_text: '旧旁白' }),
      legacyFinding({ path: '/actions/speech/text' }),
      legacyFinding({ path: '/content/canvas/elements[0]/content', quoted_text: '&lt;x&gt;' }),
      legacyFinding({ path: '/content/canvas/elements/0/content', quoted_text: '<x>' }),
    ]) {
      const repair = vi.fn(async () => '{}');
      const record = vi.fn(async (_proof: ClassroomContentProof) => {});
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: doc,
          callbacks: { review: async (packet) => answer(packet, [item]), repair },
          record,
        }),
      ).rejects.toMatchObject({ code: 'review_unavailable' });
      expect(repair).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('times out without recording a pass, repairing, or starting another review', async () => {
    vi.useFakeTimers();
    try {
      const review = vi.fn(() => new Promise<string>(() => {})),
        repair = vi.fn(async () => '{}'),
        record = vi.fn(async (_proof: ClassroomContentProof) => {});
      const pending = reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks: { review, repair },
        record,
      });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'review_timeout' });
      await vi.advanceTimersByTimeAsync(129999);
      expect(record).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(review).toHaveBeenCalledTimes(1);
      expect(repair).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects unknown, stale, cross-scene overrides and old-version responses without recording or repairing', async () => {
    let previous: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks: {
        review: async (packet) => {
          previous = packet;
          return answer(packet);
        },
      },
    });
    const doc = material();
    doc.scenes[0].actions[0].text += ' changed';
    for (const makeResponse of [
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { field_ref: 'f_' + '0'.repeat(32) })]),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { field_ref: ref(previous!) })]),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [
          finding(packet, { field_ref: ref(packet, 'widget', '/content/html'), scene_id: 'slide' }),
        ]),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { quoted_text: 'correct-looking extra quote' })]),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [], { review_version: 'native-classroom-content-v1-20261015' }),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [], { review_version: 'native-classroom-content-field-ref-v2-20261015' }),
      (packet: ClassroomReviewPacket) => answer(packet, [], { review_version: undefined }),
    ]) {
      const record = vi.fn(async (_proof: ClassroomContentProof) => {}),
        repair = vi.fn(async () => '{}');
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: doc,
          callbacks: { review: async (packet) => makeResponse(packet), repair },
          record,
        }),
      ).rejects.toBeDefined();
      expect(record).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
    }
    // A previously valid server proof is also invalid under the new protocol version.
    const result = await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks: { review: accept },
    });
    const old = copy(result.proof);
    Object.assign(old.binding, { reviewVersion: 'native-classroom-content-v1-20261015' });
    expect(matchesClassroomContentProof(requirements(), result.material, old)).toBe(false);
  });

  it('binds refs to the complete source and snapshot and distinguishes equal text in different scenes', async () => {
    const source = requirements(),
      doc = material();
    doc.scenes[1].title = doc.scenes[0].title;
    const packets: ClassroomReviewPacket[] = [];
    const capture = async (packet: ClassroomReviewPacket) => {
      packets.push(packet);
      return answer(packet);
    };
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: { review: capture },
    });
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: { review: capture },
    });
    source.codemateSource!.content += ' final constraint';
    await reviewClassroomContent({
      requirements: source,
      material: doc,
      callbacks: { review: capture },
    });
    expect(ref(packets[0], 'slide', '/title')).not.toBe(ref(packets[0], 'widget', '/title'));
    expect(ref(packets[0])).toBe(ref(packets[1]));
    expect(ref(packets[0])).not.toBe(ref(packets[2]));
    const record = vi.fn(async (_proof: ClassroomContentProof) => {});
    await expect(
      reviewClassroomContent({
        requirements: source,
        material: doc,
        record,
        callbacks: {
          review: async (packet) =>
            answer(packet, [finding(packet, { field_ref: ref(packets[0]) })]),
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(record).not.toHaveBeenCalled();
  });

  it('grounds a complete HTML/code target byte-exactly on the server without model quoting or decoding', async () => {
    const doc = material();
    const html =
      '<p title="a\\b">&lt;x&gt;\\n</p>\n<script>const s="\\\\n";function step(){x++}</script>';
    doc.scenes[1].content.html = html;
    const record = vi.fn(async (_proof: ClassroomContentProof) => {}),
      repair = vi.fn(async () => '{}');
    let target = '';
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: doc,
        record,
        callbacks: {
          review: async (packet) => {
            target = ref(packet, 'widget', '/content/html');
            return answer(packet, [
              finding(packet, { field_ref: target, kind: 'code_logic', affects_code: true }),
            ]);
          },
          repair,
        },
      }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].findings[0]).toMatchObject({
      fieldRef: target,
      sceneId: 'widget',
      path: '/content/html',
      quotedText: html,
    });
    expect(repair).not.toHaveBeenCalled();
  });

  it('retains distinct findings for the same target and does not silently drop a nondefect model claim', async () => {
    const record = vi.fn(async (_proof: ClassroomContentProof) => {});
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        record,
        callbacks: {
          review: async (packet) =>
            answer(packet, [
              finding(packet, { reason: 'First independent claim.' }),
              finding(packet, { reason: 'Second independent claim.' }),
              finding(packet, { reason: '无需修改。', required_change: '无需修改。' }),
            ]),
        },
      }),
    ).rejects.toMatchObject({ code: 'content_rejected' });
    expect(record.mock.calls[0][0].findings).toHaveLength(3);
    expect(record.mock.calls[0][0].findings[2].reason).toBe('无需修改。');
  });

  it('rejects incomplete, duplicate, unknown, stale or legacy repair patches before a second review', async () => {
    for (const makePatches of [
      (packet: ClassroomReviewPacket) =>
        patchAnswer(packet, [{ field_ref: ref(packet), new_text: '新旁白' }]),
      (packet: ClassroomReviewPacket) =>
        patchAnswer(packet, [
          { field_ref: ref(packet), new_text: '新旁白' },
          { field_ref: ref(packet), new_text: '另一旁白' },
        ]),
      (packet: ClassroomReviewPacket) =>
        patchAnswer(packet, [{ field_ref: 'f_' + '0'.repeat(32), new_text: '新旁白' }]),
      (packet: ClassroomReviewPacket) =>
        patchAnswer(
          packet,
          [
            { field_ref: ref(packet), new_text: '新旁白' },
            { field_ref: ref(packet, 'slide', '/title'), new_text: '新标题' },
          ],
          { review_snapshot_digest: '0'.repeat(64) },
        ),
      (packet: ClassroomReviewPacket) =>
        patchAnswer(
          packet,
          [
            { field_ref: ref(packet), new_text: '新旁白' },
            { field_ref: ref(packet, 'slide', '/title'), new_text: '新标题' },
          ],
          { review_version: 'native-classroom-content-v1-20261015' },
        ),
      (packet: ClassroomReviewPacket) =>
        patchAnswer(packet, [{ field_ref: ref(packet), old_text: '旧旁白', new_text: '新旁白' }]),
      (_packet: ClassroomReviewPacket) =>
        JSON.stringify({
          patches: [
            { scene_id: 'slide', path: '/actions/0/text', old_text: '旧旁白', new_text: '新旁白' },
          ],
        }),
    ]) {
      const review = vi.fn(async (packet: ClassroomReviewPacket) =>
        answer(packet, [
          finding(packet),
          finding(packet, { field_ref: ref(packet, 'slide', '/title') }),
        ]),
      );
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks: {
            review,
            repair: async (packet) => makePatches(packet),
          },
        }),
      ).rejects.toBeDefined();
      expect(review).toHaveBeenCalledTimes(1);
    }
  });

  it('applies every distinct listed target once while preserving embedded code and rechecking the complete result', async () => {
    const doc = material();
    doc.scenes[0].content.canvas!.elements[0].content = '<pre><code>x=1</code></pre><p>旧解释</p>';
    const before = copy(doc);
    const seen: ClassroomReviewPacket[] = [];
    const result = await reviewClassroomContent({
      requirements: requirements(),
      material: doc,
      callbacks: {
        review: async (packet) => {
          seen.push(packet);
          return answer(
            packet,
            seen.length === 1
              ? [
                  finding(packet),
                  finding(packet, { reason: 'A separate claim in the same speech.' }),
                  finding(packet, {
                    field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
                  }),
                ]
              : [],
          );
        },
        repair: async (packet) =>
          patchAnswer(packet, [
            { field_ref: ref(packet), new_text: '新旁白' },
            {
              field_ref: ref(packet, 'slide', '/content/canvas/elements/0/content'),
              new_text: '<pre><code>x=1</code></pre><p>新解释</p>',
            },
          ]),
      },
    });
    expect(seen).toHaveLength(2);
    expect(ref(seen[1])).not.toBe(ref(seen[0]));
    expect(seen[1].binding.sceneIds).toEqual(seen[0].binding.sceneIds);
    expect(result.material.scenes[0].content.canvas!.elements[0].content).toBe(
      '<pre><code>x=1</code></pre><p>新解释</p>',
    );
    expect(result.material.scenes.slice(1)).toEqual(before.scenes.slice(1));
    expect(doc).toEqual(before);
    expect(matchesClassroomContentProof(requirements(), result.material, result.proof)).toBe(true);
  });

  it('rejects a stale repair ref despite current binding echoes and does not overwrite an unlisted field', async () => {
    let stale: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks: {
        review: async (packet) => {
          stale = packet;
          return answer(packet);
        },
      },
    });
    const doc = material();
    doc.scenes[0].actions[0].text = 'different old text';
    const review = vi.fn(async (packet: ClassroomReviewPacket) =>
      answer(packet, [finding(packet)]),
    );
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: doc,
        callbacks: {
          review,
          repair: async (packet) =>
            patchAnswer(packet, [{ field_ref: ref(stale!), new_text: 'replacement' }]),
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(review).toHaveBeenCalledTimes(1);
    expect(doc.scenes[0].actions[0].text).toBe('different old text');
  });

  it('fails closed at the complete 2 MiB server proof bound without truncating or recording any finding', async () => {
    const doc = material();
    doc.scenes[1].content.html = '<p>' + 'x'.repeat(40000) + '</p>';
    const record = vi.fn(async (_proof: ClassroomContentProof) => {}),
      repair = vi.fn(async () => '{}');
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: doc,
        record,
        callbacks: {
          review: async (packet) =>
            answer(
              packet,
              Array.from({ length: 64 }, (_, index) =>
                finding(packet, {
                  field_ref: ref(packet, 'widget', '/content/html'),
                  reason: 'Independent model claim ' + index,
                }),
              ),
            ),
          repair,
        },
      }),
    ).rejects.toMatchObject({ code: 'context_too_large' });
    expect(record).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks: {
          review: async (packet) =>
            answer(
              packet,
              Array.from({ length: 65 }, () => finding(packet)),
            ),
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
  });
});

describe('server packet structured response schema', () => {
  it('binds the complete catalog and fixed source/version/scene values with an explicit pure validator', async () => {
    const fallback = vi.fn(async () => 'unexpected fallback');
    const doc = material(),
      source = requirements();
    let capturedDefinition: unknown;
    const callbacks = createClassroomContentCallbacks(fallback, {
      structuredCall: async (_system, user, schema) => {
        const packet = JSON.parse(user) as ClassroomReviewPacket;
        expect(packet.requirements).toEqual(source);
        expect(packet.material).toEqual(doc);
        const definition = JSON.parse(JSON.stringify(await schema.jsonSchema));
        capturedDefinition = definition;
        const refs = packet.fieldPathCatalog.flatMap((entry) =>
          entry.fields.map((field) => field.fieldRef),
        );
        expect(definition.properties.findings.items.properties.field_ref.enum).toEqual(refs);
        expect(definition.properties.reviewed_scene_ids.items.enum).toEqual(
          packet.binding.sceneIds,
        );
        expect(definition.properties.review_version.enum).toEqual([packet.binding.reviewVersion]);
        expect(definition.properties.source_digest.enum).toEqual([packet.binding.sourceDigest]);
        expect(definition.properties.material_digest.enum).toEqual([packet.binding.materialDigest]);
        expect(definition.properties.review_snapshot_digest.enum).toEqual([
          packet.binding.reviewSnapshotDigest,
        ]);
        expect(definition.additionalProperties).toBe(false);
        expect(definition.properties.findings.items.additionalProperties).toBe(false);
        expect(Object.isFrozen(await schema.jsonSchema)).toBe(true);
        if (!schema.validate) throw new Error('Explicit validator missing');
        const value = JSON.parse(answer(packet));
        const valid = await schema.validate(value);
        expect(valid.success).toBe(true);
        if (valid.success) expect(valid.value).toBe(value);
        return answer(packet);
      },
    });
    await reviewClassroomContent({ requirements: source, material: doc, callbacks });
    expect(capturedDefinition).toBeDefined();
    expect(fallback).not.toHaveBeenCalled();
    expect(doc).toEqual(material());
  });

  it('constrains repair to each distinct listed ref once and generates new full enums after revision', async () => {
    const packets: ClassroomReviewPacket[] = [],
      definitions: Array<Record<string, unknown>> = [];
    const fallback = vi.fn(async () => 'unexpected fallback');
    let calls = 0;
    const callbacks = createClassroomContentCallbacks(fallback, {
      structuredCall: async (_system, user, schema) => {
        const packet = JSON.parse(user) as ClassroomReviewPacket;
        packets.push(packet);
        const definition = JSON.parse(JSON.stringify(await schema.jsonSchema));
        definitions.push(definition);
        calls++;
        const raw =
          calls === 1
            ? answer(packet, [
                finding(packet),
                finding(packet, { reason: 'Another independent text claim.' }),
              ])
            : calls === 2
              ? patchAnswer(packet, [{ field_ref: ref(packet), new_text: '新旁白' }])
              : answer(packet);
        if (calls === 2) {
          expect(definition.properties.patches.minItems).toBe(1);
          expect(definition.properties.patches.maxItems).toBe(1);
          expect(definition.properties.patches.items.properties.field_ref.enum).toEqual([
            ref(packet),
          ]);
          expect(definition.properties.patches.items.required).toEqual(['field_ref', 'new_text']);
        }
        if (!schema.validate) throw new Error('Explicit validator missing');
        expect((await schema.validate(JSON.parse(raw))).success).toBe(true);
        return raw;
      },
    });
    const result = await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks,
    });
    expect(result.material.scenes[0].actions[0].text).toBe('新旁白');
    expect(calls).toBe(3);
    expect(ref(packets[0])).not.toBe(ref(packets[2]));
    const lastDefinition = JSON.parse(JSON.stringify(definitions[2]));
    expect(lastDefinition.properties.findings.items.properties.field_ref.enum).not.toContain(
      ref(packets[0]),
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('locally rejects bad enums, bindings, coverage, flags, legacy keys and pass/findings conflicts without rewriting values', async () => {
    for (const makeRaw of [
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { field_ref: 'f_' + '0'.repeat(32) })]),
      (packet: ClassroomReviewPacket) => answer(packet, [], { source_digest: '0'.repeat(64) }),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [], { reviewed_scene_ids: ['slide', 'slide', 'quiz'] }),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { kind: 'code_logic', affects_code: false })]),
      (packet: ClassroomReviewPacket) =>
        answer(packet, [finding(packet, { quoted_text: 'extra legacy field' })]),
      (packet: ClassroomReviewPacket) => answer(packet, [finding(packet)], { content_pass: true }),
      (packet: ClassroomReviewPacket) => answer(packet, [], { review_version: 'old-version' }),
    ]) {
      const fallback = vi.fn(async () => 'unexpected fallback'),
        record = vi.fn(async () => {});
      const callbacks = createClassroomContentCallbacks(fallback, {
        structuredCall: async (_system, user, schema) => {
          const raw = makeRaw(JSON.parse(user)),
            value = JSON.parse(raw),
            before = JSON.stringify(value);
          if (!schema.validate) throw new Error('Explicit validator missing');
          expect((await schema.validate(value)).success).toBe(false);
          expect(JSON.stringify(value)).toBe(before);
          // The original raw parser must independently reject the same response.
          return raw;
        },
      });
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          callbacks,
          record,
        }),
      ).rejects.toBeDefined();
      expect(record).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    }
  });

  it('keeps complete patch-set and embedded-code guards in the explicit repair validator and the raw parser', async () => {
    for (const makePatches of [
      (_packet: ClassroomReviewPacket) => [{ field_ref: 'f_' + '0'.repeat(32), new_text: 'new' }],
      (packet: ClassroomReviewPacket) => [
        { field_ref: ref(packet, 'quiz', '/content/questions/0/analysis'), new_text: 'unlisted' },
      ],
      (packet: ClassroomReviewPacket) => [
        { field_ref: ref(packet), new_text: 'new' },
        { field_ref: ref(packet), new_text: 'another' },
      ],
      (_packet: ClassroomReviewPacket) => [],
    ]) {
      let calls = 0;
      const fallback = vi.fn(async () => 'unexpected fallback');
      const callbacks = createClassroomContentCallbacks(fallback, {
        structuredCall: async (_system, user, schema) => {
          const packet = JSON.parse(user) as ClassroomReviewPacket;
          if (++calls === 1) return answer(packet, [finding(packet)]);
          const raw = patchAnswer(packet, makePatches(packet));
          if (!schema.validate) throw new Error('Explicit validator missing');
          expect((await schema.validate(JSON.parse(raw))).success).toBe(false);
          return raw;
        },
      });
      await expect(
        reviewClassroomContent({ requirements: requirements(), material: material(), callbacks }),
      ).rejects.toBeDefined();
      expect(calls).toBe(2);
      expect(fallback).not.toHaveBeenCalled();
    }
    const doc = material();
    doc.scenes[0].content.canvas!.elements[0].content = '<pre><code>x=1</code></pre><p>old</p>';
    let calls = 0;
    const callbacks = createClassroomContentCallbacks(async () => 'unexpected fallback', {
      structuredCall: async (_system, user, schema) => {
        const packet = JSON.parse(user) as ClassroomReviewPacket;
        const target = ref(packet, 'slide', '/content/canvas/elements/0/content');
        if (++calls === 1) return answer(packet, [finding(packet, { field_ref: target })]);
        const raw = patchAnswer(packet, [
          { field_ref: target, new_text: '<pre><code>x=2</code></pre><p>new</p>' },
        ]);
        if (!schema.validate) throw new Error('Explicit validator missing');
        expect((await schema.validate(JSON.parse(raw))).success).toBe(false);
        return raw;
      },
    });
    await expect(
      reviewClassroomContent({ requirements: requirements(), material: doc, callbacks }),
    ).rejects.toMatchObject({ code: 'requires_regeneration' });
    expect(calls).toBe(2);
    expect(doc.scenes[0].content.canvas!.elements[0].content).toBe(
      '<pre><code>x=1</code></pre><p>old</p>',
    );
  });

  it('retains the raw response byte bound even when the parsed-value validator succeeds', async () => {
    const record = vi.fn(async () => {}),
      fallback = vi.fn(async () => 'unexpected fallback');
    const callbacks = createClassroomContentCallbacks(fallback, {
      structuredCall: async (_system, user, schema) => {
        const packet = JSON.parse(user) as ClassroomReviewPacket;
        const raw = answer(packet);
        if (!schema.validate) throw new Error('Explicit validator missing');
        expect((await schema.validate(JSON.parse(raw))).success).toBe(true);
        return ' '.repeat(256 * 1024) + raw;
      },
    });
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: material(),
        callbacks,
        record,
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(record).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects changed server-packet catalogs before the structured transport and never falls back after an error', async () => {
    let captured: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks: {
        review: async (packet) => {
          captured = packet;
          return answer(packet);
        },
      },
    });
    const fallback = vi.fn(async () => 'unexpected fallback'),
      structuredCall = vi.fn(async () => {
        throw new Error('fixture unsupported schema');
      });
    const callbacks = createClassroomContentCallbacks(fallback, { structuredCall });
    const forged = copy(captured!);
    forged.fieldPathCatalog[0].fields[0].fieldRef = 'f_' + '0'.repeat(32);
    await expect(Promise.resolve().then(() => callbacks.review(forged))).rejects.toMatchObject({
      code: 'binding_mismatch',
    });
    expect(structuredCall).not.toHaveBeenCalled();
    await expect(
      reviewClassroomContent({ requirements: requirements(), material: material(), callbacks }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(structuredCall).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('counts the complete response schema and packet against the 1 MiB input bound before transport', async () => {
    const source = requirements();
    let captured: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: source,
      material: material(),
      callbacks: {
        review: async (packet) => {
          captured = packet;
          return answer(packet);
        },
      },
    });
    source.codemateSource!.content = 'x'.repeat(
      1024 * 1024 -
        Buffer.byteLength(JSON.stringify(captured!)) +
        Buffer.byteLength(source.codemateSource!.content) -
        100,
    );
    const structuredCall = vi.fn(async () => 'unexpected call');
    const callbacks = createClassroomContentCallbacks(async () => 'unexpected fallback', {
      structuredCall,
    });
    await expect(
      reviewClassroomContent({ requirements: source, material: material(), callbacks }),
    ).rejects.toMatchObject({ code: 'context_too_large' });
    expect(structuredCall).not.toHaveBeenCalled();
  });
});

// These actual captures remain private; ROOT supplies their frozen directory.
// Stubbed findings exercise ref/location/code-rejection contracts only, never
// claim that a real model detected the historical defect. Heldout is not sent.
const privateRoot = process.env.CLASSROOM_CONTENT_PRIVATE_FIXTURE_ROOT;
describe.skipIf(!privateRoot)('approved actual rejected-classroom fixtures', () => {
  for (const filename of ['rejected-classroom-1.json', 'rejected-classroom-2.json']) {
    it(`${filename}: rejects a real quoted interactive logic defect before any text repair`, async () => {
      const fixture = JSON.parse(readFileSync(join(privateRoot!, filename), 'utf8'));
      const repair = vi.fn(async () => '{}');
      await expect(
        reviewClassroomContent({
          requirements: fixture.requirements,
          material: fixture.material,
          callbacks: {
            review: async (packet) => {
              expect(Object.keys(packet).sort()).toEqual([
                'binding',
                'fieldPathCatalog',
                'material',
                'requirements',
              ]);
              expect(packet.binding.sceneIds.length).toBe(fixture.material.scenes.length);
              const heldout = fixture.heldout.contractFinding;
              const targetScene = (packet.material as unknown as FixtureMaterial).scenes.find(
                (scene) => scene.id === heldout.scene_id,
              );
              const originalField = heldout.path
                .substring(1)
                .split('/')
                .reduce((value: unknown, key: string): unknown => {
                  if (!value || typeof value !== 'object')
                    throw new Error('Fixture target missing');
                  return (value as Record<string, unknown>)[
                    key.replace(/~1/g, '/').replace(/~0/g, '~')
                  ];
                }, targetScene);
              expect(typeof originalField).toBe('string');
              expect(originalField).toContain(heldout.quoted_text);
              return answer(packet, [
                finding(packet, {
                  field_ref: ref(packet, heldout.scene_id, heldout.path),
                  reason: heldout.reason,
                  required_change: heldout.required_change,
                  kind: heldout.kind,
                  affects_code: heldout.affects_code,
                  affects_root: heldout.affects_root,
                }),
              ]);
            },
            repair,
          },
        }),
      ).rejects.toMatchObject({ code: 'requires_regeneration' });
      expect(repair).not.toHaveBeenCalled();
    });
  }
});

describe('readable packet-bound refs v3', () => {
  it('keeps the complete escaped pointer and exact field digest with the ordered scene and full binding', async () => {
    const doc = material();
    Object.assign(doc.scenes[1].content, { 'a/b~c': { 'hash#key': ['literal &lt;x&gt;\\n'] } });
    let packet: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: doc,
      callbacks: {
        review: async (input) => {
          packet = input;
          return answer(input);
        },
      },
    });
    const field = packet!.fieldPathCatalog[1].fields.find(
      (item) => item.path === '/content/a~1b~0c/hash#key/0',
    )!;
    expect(field).toBeDefined();
    const hash = field.fieldRef.substring(field.fieldRef.lastIndexOf('#') + 1);
    expect(field.fieldRef).toBe('scene2/content/a~1b~0c/hash#key/0#' + hash);
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, item]) => [key, canonical(item)]),
            )
          : value;
    const expected = digest(
      JSON.stringify(
        canonical({
          binding: packet!.binding,
          sceneId: 'widget',
          path: field.path,
          fieldDigest: digest('literal &lt;x&gt;\\n'),
        }),
      ),
    ).slice(0, 32);
    expect(hash).toBe(expected);
    expect((packet!.material as unknown as FixtureMaterial).scenes[1].content).toEqual(
      doc.scenes[1].content,
    );
  });

  it('rejects changing a readable ordinal or pointer while retaining a real hash, without guessing another field', async () => {
    for (const change of [
      (value: string) => value.replace(/^scene1\//, 'scene2/'),
      (value: string) => value.replace('/actions/0/text#', '/title#'),
      (value: string) => 'f_' + value.substring(value.lastIndexOf('#') + 1),
    ]) {
      const record = vi.fn(async () => {}),
        repair = vi.fn(async () => '{}');
      await expect(
        reviewClassroomContent({
          requirements: requirements(),
          material: material(),
          record,
          callbacks: {
            review: async (packet) =>
              answer(packet, [finding(packet, { field_ref: change(ref(packet)) })]),
            repair,
          },
        }),
      ).rejects.toMatchObject({ code: 'review_unavailable' });
      expect(record).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
    }
  });

  it('invalidates the old ordinal and digest after scene reorder while retaining every field in the full catalog', async () => {
    let old: ClassroomReviewPacket | undefined;
    await reviewClassroomContent({
      requirements: requirements(),
      material: material(),
      callbacks: {
        review: async (packet) => {
          old = packet;
          return answer(packet);
        },
      },
    });
    const reordered = material();
    [reordered.scenes[0], reordered.scenes[1]] = [reordered.scenes[1], reordered.scenes[0]];
    let current: ClassroomReviewPacket | undefined;
    const record = vi.fn(async () => {});
    await expect(
      reviewClassroomContent({
        requirements: requirements(),
        material: reordered,
        record,
        callbacks: {
          review: async (packet) => {
            current = packet;
            return answer(packet, [finding(packet, { field_ref: ref(old!) })]);
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(ref(old!)).toMatch(/^scene1\/actions\/0\/text#/);
    expect(ref(current!)).toMatch(/^scene2\/actions\/0\/text#/);
    expect(ref(current!)).not.toBe(ref(old!));
    expect(current!.fieldPathCatalog.flatMap((scene) => scene.fields).length).toBe(
      old!.fieldPathCatalog.flatMap((scene) => scene.fields).length,
    );
    expect(record).not.toHaveBeenCalled();
  });
});
