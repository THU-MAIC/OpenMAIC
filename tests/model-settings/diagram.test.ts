import { describe, expect, it } from 'vitest';

import { MODEL_SLOTS } from '@/lib/config/model-slots';
import { FLOW, STATIONS, edgeKind, placeStations } from '@/lib/model-settings/diagram';

import { emptySlots, makeView } from './fixtures';

describe('model map layout', () => {
  it('places every visible slot exactly once, and no configuration-only slot', () => {
    const stations = placeStations(makeView());
    const placed = stations.flatMap((station) => [
      ...station.lines.map((line) => line.slot),
      ...station.children.map((child) => child.slot),
    ]);
    const visible = MODEL_SLOTS.filter((slot) => !('configOnly' in slot && slot.configOnly)).map(
      (slot) => slot.id,
    );
    expect([...placed].sort()).toEqual([...visible].sort());
    expect(placed).not.toContain('agent.title');
  });

  it('nests the page types under the content station', () => {
    const content = placeStations(makeView()).find((station) => station.id === 'content');
    expect(content?.children.map((child) => child.slot)).toEqual([
      'course.content.slide',
      'course.content.quiz',
      'course.content.interactive',
      'course.content.pbl',
    ]);
  });

  it('runs the flow left to right on the first row and right to left on the second', () => {
    const byId = new Map(STATIONS.map((station) => [station.id, station]));
    const rows = FLOW.map((id) => byId.get(id)!);
    for (let i = 0; i < rows.length - 1; i++) {
      const [a, b] = [rows[i], rows[i + 1]];
      if (a.row === 1 && b.row === 1) expect(b.x).toBeGreaterThan(a.x);
      if (a.row === 2 && b.row === 2) expect(b.x).toBeLessThan(a.x);
    }
  });

  it('draws a slot the station table does not know in an extra row', () => {
    const view = makeView({
      slots: [
        ...emptySlots(),
        {
          slot: 'course.future' as never,
          parent: 'llm',
          capability: 'chat',
          configOnly: false,
          locked: false,
          source: { kind: 'unconfigured' },
          effective: { status: 'unassigned' },
        },
      ],
    });
    const extra = placeStations(view).find((station) => station.id === 'extra:course.future');
    expect(extra?.lines[0].slot).toBe('course.future');
  });

  it('draws inheritance solid and own settings dashed', () => {
    const [llm] = emptySlots();
    const assigned = (resolvedAt: 'llm' | 'classroom') => ({
      status: 'assigned' as const,
      resolvedAt,
      source: 'workspace' as const,
      requirements: [],
      providerId: 'a',
      providerSource: 'workspace' as const,
      presetId: 'a',
      registryId: 'a',
      modelId: 'm',
    });
    const classroom = { ...llm, slot: 'classroom' as const, parent: 'llm' as const };
    expect(edgeKind({ ...classroom, effective: assigned('llm') })).toBe('inherit');
    expect(edgeKind({ ...classroom, assignment: 'a:m', effective: assigned('classroom') })).toBe(
      'detached',
    );
    expect(edgeKind(classroom)).toBe('none');
    expect(
      edgeKind({
        ...classroom,
        assignment: null,
        effective: { status: 'disabled', resolvedAt: 'classroom', source: 'workspace' },
      }),
    ).toBe('detached');
  });
});
