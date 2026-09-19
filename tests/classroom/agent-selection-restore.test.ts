/**
 * restoreAgentSelection: classroom load must honor the user's explicit
 * agent mode/selection (set in the AgentBar) when still valid for the loaded
 * stage, and fall back to stage-derived defaults otherwise. Stage-derived
 * defaults written by previous classroom loads are NOT user choices and must
 * never carry across stages — otherwise visiting a preset classroom would
 * permanently downgrade every auto classroom to preset agents.
 */
import { describe, it, expect } from 'vitest';
import {
  restoreAgentSelection,
  type AgentSelection,
} from '@/lib/orchestration/registry/agent-selection';

const PRESETS = new Set(['default-1', 'default-2', 'default-3', 'default-4']);
const isPresetAgent = (id: string) => PRESETS.has(id);

describe('restoreAgentSelection', () => {
  it('keeps a user-set preset selection even when the stage has generated agents', () => {
    const persisted: AgentSelection = {
      mode: 'preset',
      selectedAgentIds: ['default-2', 'default-3'],
    };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
  });

  it("keeps a user-set auto selection that is a subset of this stage's generated agents", () => {
    const persisted: AgentSelection = { mode: 'auto', selectedAgentIds: ['gen-b'] };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
  });

  it('ignores a stage-derived persisted selection and applies this stage defaults', () => {
    // A previous classroom load wrote {preset, trio} as its fallback; that is
    // not a user choice, so an auto stage must still get its generated agents.
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
        persistedIsUserSet: false,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it("resets a stale user-set auto selection (ids from another stage) to this stage's defaults", () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it('falls back to auto defaults when a user-set preset selection contains unknown ids', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['gen-stale', 'default-2'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
      }),
    ).toEqual({ selection: { mode: 'auto', selectedAgentIds: ['gen-a'] }, isUserSet: false });
  });

  it('falls back to stage preset agents when nothing is generated and nothing was user-set', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: false,
        generatedAgentIds: [],
        stageAgentIds: ['default-4', 'gen-stale'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-4'] },
      isUserSet: false,
    });
  });

  it('falls back to the default preset trio when nothing else is valid', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: [] },
        persistedIsUserSet: true,
        generatedAgentIds: [],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
      isUserSet: false,
    });
  });

  it('round-trips A(auto) → B(preset) → A without degrading A to preset agents', () => {
    // Simulates sequential classroom loads with no user interaction: each
    // load persists its result and feeds it into the next load.
    const loadA = () => ({ generatedAgentIds: ['gen-a1', 'gen-a2'], stageAgentIds: undefined });
    const loadB = () => ({ generatedAgentIds: [], stageAgentIds: ['default-1', 'default-2'] });

    let state = {
      selection: { mode: 'auto', selectedAgentIds: [] } as AgentSelection,
      isUserSet: false,
    };
    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadB(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({
      mode: 'preset',
      selectedAgentIds: ['default-1', 'default-2'],
    });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });
  });

  it('carries a user-set preset choice through the same A → B → A round-trip', () => {
    const persisted: AgentSelection = { mode: 'preset', selectedAgentIds: ['default-2'] };
    let state = { selection: persisted, isUserSet: true };
    for (const stage of [
      { generatedAgentIds: ['gen-a1'], stageAgentIds: undefined },
      { generatedAgentIds: [], stageAgentIds: ['default-1'] },
      { generatedAgentIds: ['gen-a1'], stageAgentIds: undefined },
    ]) {
      state = restoreAgentSelection({
        persisted: state.selection,
        persistedIsUserSet: state.isUserSet,
        ...stage,
        isPresetAgent,
      });
      expect(state).toEqual({ selection: persisted, isUserSet: true });
    }
  });
});
