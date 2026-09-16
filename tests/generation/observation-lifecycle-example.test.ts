import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { parseObservation } from '../../lib/interactive/observation';

it('the actual prompt timing example preserves the whole old render until completion', () => {
  const md = readFileSync(
    'packages/@openmaic/generation/snippets/interactive-observation.md',
    'utf8',
  );
  const example = md
    .split('### Render lifecycle example')[1]
    .match(/```javascript\n([\s\S]*?)```/)![1];
  let now = 100;
  const publications: unknown[] = [];
  const api = runInNewContext(
    example + '\n({commitCurrent, beginRender, completeRender, publishEvidence})',
    {
      structuredClone,
      Date: { now: () => now },
      publishState: (value: unknown) => publications.push(structuredClone(value)),
    },
  );
  const graph = (value: number, missing: unknown[] = []) => ({
    objects: [
      {
        id: 'parameter',
        label: 'Parameter',
        facts: [{ key: 'value', label: 'Value', status: 'known', value }],
      },
    ],
    relations: { status: 'complete', items: [] },
    missing,
  });
  function latest() {
    const parsed = parseObservation(JSON.stringify(publications.at(-1)), 'experiment');
    expect(parsed.status).not.toBe('unavailable');
    if (parsed.status === 'unavailable') throw new Error('Invalid example');
    return parsed.observation;
  }
  api.commitCurrent(graph(1000));
  expect(latest().rendered.status).toBe('unknown');
  api.completeRender(api.beginRender(), graph(1000));
  const old = latest().rendered;
  now = 200;
  api.commitCurrent(graph(1400, ['Some optional information was not measured']));
  expect(latest().rendered).toEqual(old);
  expect(latest().current.revision).toBe(1);
  api.publishEvidence();
  expect(latest().rendered).toEqual(old);
  const work = api.beginRender();
  now = 300;
  api.commitCurrent(graph(600)); // another edit while a render is pending
  now = 400;
  api.completeRender(work, work.graph);
  expect(latest().current.revision).toBe(2);
  expect(latest().rendered).toMatchObject({
    basedOnRevision: 1,
    renderedAt: 400,
    graph: graph(1400, ['Some optional information was not measured']),
  });
  work.graph.objects[0].facts[0].value = 999; // detached render does not follow later mutation
  api.publishEvidence();
  expect(latest().rendered).toMatchObject({
    graph: graph(1400, ['Some optional information was not measured']),
  });
  api.commitCurrent(graph(600, [{ key: 'refresh-needed', reason: 'old picture' }]));
  expect(parseObservation(JSON.stringify(publications.at(-1)), 'experiment')).toMatchObject({
    status: 'unavailable',
    reason: 'invalid-data',
  });
});
