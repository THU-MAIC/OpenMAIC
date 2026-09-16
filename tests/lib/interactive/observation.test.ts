import { describe, expect, it } from 'vitest';
import {
  freezeEvidence,
  parseObservation,
  type Observation,
} from '../../../lib/interactive/observation';
const fixture = (): Observation => ({
  version: 1,
  scope: { id: 'experiment', label: 'Experiment' },
  current: {
    revision: 2,
    updatedAt: 100,
    graph: {
      objects: [
        {
          id: 'source',
          label: 'Source',
          facts: [{ key: 'voltage', label: 'Voltage', status: 'known', value: 6, unit: 'V' }],
        },
        {
          id: 'switch',
          label: 'Switch',
          facts: [{ key: 'closed', label: 'Closed', status: 'known', value: false }],
        },
      ],
      relations: {
        status: 'complete',
        items: [{ from: 'source', to: 'switch', kind: 'wire', label: 'Connection' }],
      },
      missing: [],
    },
  },
  rendered: { status: 'unknown', reason: 'Not rendered yet' },
});
const parse = (x: unknown) => parseObservation(JSON.stringify(x), 'experiment');
describe('experimental semantic observation boundary', () => {
  it('preserves object identity, typed facts and exact relation endpoints without widget types', () => {
    const x = fixture();
    x.rendered = {
      status: 'known',
      basedOnRevision: 2,
      renderedAt: 101,
      graph: structuredClone(x.current.graph),
    };
    expect(parse(x)).toEqual({ status: 'available', observation: x });
  });
  it('preserves current and last-rendered facts separately, even when revisions differ', () => {
    const x = fixture();
    x.rendered = {
      status: 'known',
      basedOnRevision: 1,
      renderedAt: 90,
      graph: structuredClone(x.current.graph),
    };
    x.rendered.graph.objects[0].facts[0] = {
      key: 'voltage',
      label: 'Voltage',
      status: 'known',
      value: 3,
      unit: 'V',
    };
    const r = parse(x);
    expect(r.status).toBe('available');
    if (r.status !== 'unavailable' && r.observation.rendered.status === 'known') {
      expect(r.observation.current.graph.objects[0].facts[0]).toHaveProperty('value', 6);
      expect(r.observation.rendered.graph.objects[0].facts[0]).toHaveProperty('value', 3);
    }
  });
  it('keeps missing rendered data unknown, not a copy of current or source defaults', () => {
    expect(parse(fixture())).toMatchObject({
      status: 'partial',
      observation: { rendered: { status: 'unknown' } },
    });
  });
  it('distinguishes unknown relations from a known empty relation set', () => {
    const x = fixture();
    x.current.graph.relations = { status: 'unknown', reason: 'Unavailable' };
    const r = parse(x);
    expect(r).toMatchObject({ status: 'partial' });
    if (r.status !== 'unavailable')
      expect(r.observation.current.graph.relations).not.toHaveProperty('items');
  });
  it.each([
    'duplicate-object',
    'duplicate-fact',
    'dangling-edge',
    'duplicate-edge',
    'future-render',
  ])('rejects %s', (kind) => {
    const x = fixture();
    if (kind === 'duplicate-object') x.current.graph.objects.push(x.current.graph.objects[0]);
    if (kind === 'duplicate-fact')
      x.current.graph.objects[0].facts.push(x.current.graph.objects[0].facts[0]);
    if (x.current.graph.relations.status === 'complete') {
      if (kind === 'dangling-edge') x.current.graph.relations.items[0].to = 'not-in-scope';
      if (kind === 'duplicate-edge')
        x.current.graph.relations.items.push(x.current.graph.relations.items[0]);
    }
    if (kind === 'future-render')
      x.rendered = { status: 'known', basedOnRevision: 3, renderedAt: 100, graph: x.current.graph };
    expect(parse(x)).toEqual({ status: 'unavailable', reason: 'invalid-data' });
  });
  it('rejects extra authority fields and wrong scope/version rather than stripping them', () => {
    expect(parse({ ...fixture(), spotlightElementIds: ['anything'] }).status).toBe('unavailable');
    expect(parse({ ...fixture(), version: 2 }).status).toBe('unavailable');
    const x = fixture();
    x.scope.id = 'other';
    expect(parse(x).status).toBe('unavailable');
  });
  it('bounds UTF-8 bytes and rejects malformed JSON', () => {
    expect(parseObservation('\u4e2d'.repeat(12000), 'experiment')).toEqual({
      status: 'unavailable',
      reason: 'too-large',
    });
    expect(parseObservation('{', 'experiment')).toEqual({
      status: 'unavailable',
      reason: 'invalid-data',
    });
  });
  it('does not reinterpret instruction-like labels as commands, and freezes the detached result', () => {
    const x = fixture();
    x.current.graph.objects[0].label = '<img onerror="sendSecrets()">';
    const r = freezeEvidence(parse(x));
    if (r.status !== 'unavailable') {
      expect(Object.isFrozen(r.observation.current.graph.objects[0])).toBe(true);
      expect(r.observation.current.graph.objects[0].label).toContain('<img');
      x.current.graph.objects[0].label = 'changed later';
      expect(r.observation.current.graph.objects[0].label).toContain('<img');
    }
  });
});
