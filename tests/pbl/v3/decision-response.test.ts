import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  indexProjectFiles,
  packageBuiltin,
  validateProjectPackage,
} from '@/lib/server/pbl-v3/project-package';
import { startOrchestration, submitDecision } from '@/lib/pbl/v3/domain/orchestration/transition';
import {
  DECISION_RESPONSE_MAX_LENGTH,
  DECISION_RESPONSE_MAX_BYTES,
  decisionResponseLabel,
  isDecisionResponseWithinLimits,
  isDecisionResponseStorable,
  isDecisionResponseValid,
} from '@/lib/pbl/v3/domain/orchestration/decisions';
import { projectArtifacts } from '@/lib/pbl/v3/domain/orchestration/artifacts';
import { renderTeachingPrompt } from '@/lib/server/pbl-v3/teaching-prompt';

function fixture() {
  const source = installedProject({ id: 'greeting-python', version: '1.0.0' });
  const bundle = packageBuiltin(source);
  const spec = JSON.parse(bundle.files['project.json']);
  spec.definition.decisions[0].responseType = 'text';
  spec.definition.decisions[0].requiresRationale = true;
  spec.definition.decisions[0].options = [];
  bundle.files['project.json'] = JSON.stringify(spec);
  const { project } = validateProjectPackage(
    indexProjectFiles(bundle.entry.id, bundle.entry.version, bundle.files),
  );
  const definition = project.definition;
  const state = startOrchestration(definition).state;
  state.position.stageIndex = 1;
  return {
    definition,
    state,
    decision: definition.decisions[0]!,
    milestone: definition.milestones[0]!,
  };
}

describe('authored decision responses', () => {
  it('rejects PostgreSQL-incompatible decision text without altering learner input or state', () => {
    const { definition, state, decision } = fixture();
    const original = structuredClone(state);
    for (const value of ['x\0y', '\uD800', '\uDC00', 'x\uD800y'])
      for (const response of [
        { chosen: value, rationale: 'Reason' },
        { chosen: 'Rule', rationale: value },
      ]) {
        expect(isDecisionResponseStorable(response)).toBe(false);
        expect(() =>
          submitDecision(definition, state, {
            decisionId: decision.id,
            recordId: 'invalid-unicode',
            ...response,
          }),
        ).toThrow();
        expect(state).toEqual(original);
      }
    for (const value of ['普通文字', '🧠', '\\u0000', '\\uD800', '\tline\nnext'])
      expect(isDecisionResponseStorable({ chosen: value, rationale: value })).toBe(true);
  });
  it('accepts boundary-length text without changing it and rejects overflow before a transition', () => {
    const { definition, state, decision, milestone } = fixture();
    const original = structuredClone(state);
    const chosen = 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH);
    const rationale = 'y'.repeat(DECISION_RESPONSE_MAX_LENGTH);
    const saved = submitDecision(definition, state, {
      decisionId: decision.id,
      chosen,
      rationale,
      recordId: 'boundary',
    });
    expect(saved.state.collected[milestone.id]!.decisions[0]).toMatchObject({ chosen, rationale });
    for (const response of [
      { chosen: chosen + 'x', rationale: 'Reason' },
      { chosen: 'Rule', rationale: rationale + 'x' },
      { chosen: ' '.repeat(DECISION_RESPONSE_MAX_LENGTH) + 'x', rationale: 'Reason' },
    ]) {
      expect(() =>
        submitDecision(definition, state, {
          decisionId: decision.id,
          ...response,
          recordId: 'oversized',
        }),
      ).toThrow();
      expect(state).toEqual(original);
    }
  });

  it('bounds combined JSON-encoded Unicode and escaped text while allowing the exact byte boundary', () => {
    for (const value of ['学'.repeat(64_000), '🧠'.repeat(32_000), '\u0000'.repeat(32_000)]) {
      expect(value.length).toBeLessThanOrEqual(DECISION_RESPONSE_MAX_LENGTH);
      expect(isDecisionResponseWithinLimits({ chosen: value, rationale: value })).toBe(false);
    }
    const rationale = '学'.repeat(63_997) + 'x';
    expect(Buffer.byteLength(JSON.stringify(['x', rationale]))).toBe(DECISION_RESPONSE_MAX_BYTES);
    expect(isDecisionResponseWithinLimits({ chosen: 'x', rationale })).toBe(true);
    expect(isDecisionResponseWithinLimits({ chosen: 'x', rationale: rationale + 'x' })).toBe(false);
    expect(isDecisionResponseWithinLimits({ chosen: '学'.repeat(60_000) })).toBe(true);
  });

  it.each([
    { responseType: 'text' as const },
    { responseType: 'text' as const, requiresRationale: true },
    {},
    { requiresRationale: true },
  ])('bounds required and optional rationale for either response format: %j', (format) => {
    const definition = { ...format, options: [{ id: 'first' }] };
    expect(
      isDecisionResponseValid(definition, {
        chosen: 'first',
        rationale: 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH),
      }),
    ).toBe(true);
    expect(
      isDecisionResponseValid(definition, {
        chosen: 'first',
        rationale: 'x'.repeat(DECISION_RESPONSE_MAX_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it('renders literal text without option substitution while preserving legacy choice labels', () => {
    const definition = { options: [{ id: 'format', label: 'Formatted string' }] };
    expect(decisionResponseLabel({ ...definition, responseType: 'text' }, 'format')).toBe('format');
    expect(decisionResponseLabel(definition, 'format')).toBe('Formatted string');
    expect(decisionResponseLabel({ ...definition, responseType: 'choice' }, 'format')).toBe(
      'Formatted string',
    );
    expect(decisionResponseLabel(definition, 'Retired option')).toBe('Retired option');
    expect(decisionResponseLabel(undefined, 'Original response')).toBe('Original response');
  });

  it('retains legacy choice validation and accepts required rationale without changing choice identity', () => {
    const decision = { options: [{ id: 'first' }] };
    expect(isDecisionResponseValid(decision, { chosen: 'first' })).toBe(true);
    expect(isDecisionResponseValid(decision, { chosen: 'other' })).toBe(false);
    expect(
      isDecisionResponseValid({ ...decision, requiresRationale: true }, { chosen: 'first' }),
    ).toBe(false);
    expect(
      isDecisionResponseValid(
        { ...decision, requiresRationale: true },
        { chosen: 'first', rationale: 'This suits my use case.' },
      ),
    ).toBe(true);
  });

  it.each([
    { chosen: '', rationale: 'Because' },
    { chosen: '  \n ', rationale: 'Because' },
    { chosen: 'My rule', rationale: ' \n ' },
    { chosen: 'My rule', rationale: 42 },
  ])('rejects an incomplete response: %j', (response) => {
    const { decision } = fixture();
    expect(isDecisionResponseValid(decision, response)).toBe(false);
  });

  it('preserves multiline text and rationale through package validation, revision, events and role projections', () => {
    const { definition, state, decision, milestone } = fixture();
    const chosen = 'If the item exists, act on it.\nOtherwise keep the collection unchanged.';
    const rationale = 'Avoid changing an unrelated item.  保留我的原话。';
    const saved = submitDecision(definition, state, {
      decisionId: decision.id,
      chosen,
      rationale,
      recordId: 'first',
    });
    expect(saved.events[0]).toMatchObject({
      type: 'decision.recorded',
      chosen,
      rationale,
      revision: 0,
    });
    const revised = submitDecision(definition, saved.state, {
      decisionId: decision.id,
      chosen,
      rationale: 'An improved explanation.',
      recordId: 'second',
    });
    expect(revised.state.collected[milestone.id]!.decisions[0]).toEqual({
      id: decision.id,
      chosen,
      rationale: 'An improved explanation.',
      revision: 1,
    });
    const projection = projectArtifacts({
      reads: ['decisions', 'decisions.chosen'],
      milestone,
      state: { decisions: revised.state.collected[milestone.id]!.decisions },
      decisionCatalog: definition.decisions,
    });
    expect(projection.decisions![0]).toMatchObject({
      responseType: 'text',
      requiresRationale: true,
      options: [],
    });
    expect(projection.decisionsChosen![0]).toEqual({
      id: decision.id,
      chosen,
      rationale: 'An improved explanation.',
    });
    const planningPrompt = renderTeachingPrompt({
      definition,
      milestone,
      stage: milestone.stages[2]!,
      stageKey: `${milestone.id}:2`,
      role: 'planner',
      packaged: true,
      skill: { content: {}, progression: ['SKILL.md', 'A-plan.md'], documents: [] },
      collected: revised.state.collected[milestone.id]!,
    }).systemPrompt;
    expect(planningPrompt).toContain(JSON.stringify(projection.decisionsChosen));
    expect(planningPrompt).toContain('Use the recorded rationale in plans and reviews');
  });

  it('keeps stage authorization and rejects invalid submissions before producing a transition', () => {
    const { definition, state, decision } = fixture();
    expect(() =>
      submitDecision(definition, state, {
        decisionId: decision.id,
        chosen: 'rule',
        recordId: 'missing-reason',
      }),
    ).toThrow();
    expect(state.collected[definition.milestones[0]!.id]!.decisions).toEqual([]);
    state.position.stageIndex = 2;
    expect(() =>
      submitDecision(definition, state, {
        decisionId: decision.id,
        chosen: 'rule',
        rationale: 'reason',
        recordId: 'wrong-stage',
      }),
    ).toThrow('not allowed');
  });
});
