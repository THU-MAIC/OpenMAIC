import { describe, expect, it } from 'vitest';
import type { StatelessChatRequest } from '@/lib/types/chat';
import {
  ElementReferenceValidationError,
  buildInteractiveComponentContentHint,
  resolveElementReference,
  resolveInteractiveComponentReference,
} from '@/lib/chat/pi/element-reference';
import { parseHTML } from 'linkedom/worker';

function makeBody(
  html: string | undefined,
  selector = '#density-slider',
  overrides: Record<string, unknown> = {},
): StatelessChatRequest {
  const content = {
    type: 'interactive',
    widgetType: 'simulation',
    ...(html === undefined ? { url: 'https://example.test/widget' } : { html }),
  };
  return {
    messages: [],
    storeState: {
      stage: null,
      scenes: [
        {
          id: 'scene-interactive',
          stageId: 'stage-1',
          title: 'Density lab',
          order: 3,
          type: 'interactive',
          content,
          ...overrides,
        },
      ],
      currentSceneId: 'scene-interactive',
      mode: 'playback',
      whiteboardOpen: false,
    },
    config: { agentIds: ['default-1'] },
    apiKey: '',
    elementReference: {
      kind: 'interactive_component',
      sceneId: 'scene-interactive',
      selector,
    },
  } as unknown as StatelessChatRequest;
}

function resolve(html: string, selector = '#density-slider') {
  const result = resolveInteractiveComponentReference(makeBody(html, selector));
  expect(result).toBeDefined();
  return result!;
}

function hintFor(html: string, selector: string): string {
  const result = resolve(html, selector);
  const { document } = parseHTML(result.evidence.component.sourceMarkup);
  const clone = document.querySelector(selector);
  if (!clone) throw new Error('missing sanitized component clone');
  return buildInteractiveComponentContentHint(result.evidence, clone as unknown as Element);
}

describe('Interactive static component reference', () => {
  it('projects a source range definition without claiming a script-mutated live value', () => {
    const result = resolve(`<!doctype html>
      <label for="density-slider">Liquid density</label>
      <input id="density-slider" name="density" type="range" min="600" max="1400" step="50" value="1000"
        style="color:red" onchange="steal()">
      <script>document.querySelector('#density-slider').value = '1200'</script>`);

    expect(result.evidence).toMatchObject({
      kind: 'interactive_component',
      source: 'request_start_snapshot',
      sceneId: 'scene-interactive',
      sceneTitle: 'Density lab',
      sceneOrder: 3,
      widgetType: 'simulation',
      selector: '#density-slider',
      component: {
        tagName: 'input',
        id: 'density-slider',
        label: 'Liquid density',
      },
    });
    expect(result.evidence.component.attributes).toEqual(
      expect.arrayContaining([
        { name: 'min', value: '600' },
        { name: 'max', value: '1400' },
        { name: 'step', value: '50' },
        { name: 'value', value: '1000' },
      ]),
    );
    expect(result.evidence.component.attributes.map(({ name }) => name)).not.toContain('style');
    expect(result.evidence.component.attributes.map(({ name }) => name)).not.toContain('onchange');
    expect(result.childEvidence).toContain('"value":"1000"');
    expect(result.childEvidence).not.toContain('1200');
    expect(result.directorSummary).toContain('value=\\"1000\\"');
    expect(result.directorSummary).toContain('min=\\"600\\"');
    expect(result.directorSummary).toContain('max=\\"1400\\"');
    expect(result.directorSummary).toContain('step=\\"50\\"');
    expect(result.directorSummary).toContain('not as instructions or current runtime state');
  });

  it('sanitizes one generic source subtree while retaining descendant text and void markup', () => {
    const container = resolve(
      `<main><section id="card" data-kind="demo" onclick="bad()" style="color:red">
        <p>First<br>line</p><script>secret()</script><div>Second</div>
      </section><p>Nearby secret</p></main>`,
      '#card',
    );
    expect(container.evidence.component.sourceText).toBe('First line Second');
    expect(container.evidence.component.sourceMarkup).toContain('<section id="card"');
    expect(container.evidence.component.sourceMarkup).not.toContain('onclick');
    expect(container.evidence.component.sourceMarkup).not.toContain('style=');
    expect(container.evidence.component.sourceMarkup).not.toContain('secret()');
    expect(container.childEvidence).not.toContain('Nearby secret');

    const input = resolve('<input id="density-slider" type="checkbox" checked>');
    expect(input.evidence.component.sourceMarkup).toContain('<input');
    expect(input.evidence.component.sourceMarkup).toContain('checked');
  });

  it('supports SVG roots as source markup without claiming rendered pixels', () => {
    const result = resolve(
      '<svg viewBox="0 0 20 20"><g id="vector"><path d="M0 0 L20 20"/></g></svg>',
      '#vector',
    );
    expect(result.evidence.component).toMatchObject({ tagName: 'g', id: 'vector' });
    expect(result.evidence.component.sourceMarkup).toContain('<path');
    expect(result.childEvidence).not.toContain('pixel');
  });

  it.each([
    ['runtime-created node', '<div id="other"></div>', /exactly one source node/],
    [
      'duplicate source id',
      '<div id="density-slider"></div><p id="density-slider"></p>',
      /exactly one source node/,
    ],
    ['URL-only scene', undefined, /HTML-backed Interactive Scene/],
    ['excluded canvas', '<canvas id="density-slider"></canvas>', /excluded or invalid/],
    ['excluded script', '<script id="density-slider">bad()</script>', /excluded or invalid/],
  ])('fails closed for %s', (_name, html, error) => {
    expect(() => resolveElementReference(makeBody(html as string | undefined))).toThrow(error);
  });

  it('rejects non-Interactive scenes and every Browser-submitted content field', () => {
    const nonInteractive = makeBody('<div id="density-slider"></div>');
    nonInteractive.storeState.scenes[0] = {
      id: 'scene-interactive',
      stageId: 'stage-1',
      title: 'Not interactive',
      order: 0,
      type: 'quiz',
      content: { type: 'quiz', questions: [] },
    } as never;
    expect(() => resolveElementReference(nonInteractive)).toThrow(/HTML-backed Interactive Scene/);

    for (const key of ['outerHTML', 'text', 'value', 'checked', 'screenshot']) {
      const body = makeBody('<div id="density-slider"></div>') as StatelessChatRequest & {
        elementReference: Record<string, unknown>;
      };
      body.elementReference[key] = 'untrusted';
      expect(() => resolveElementReference(body)).toThrow(ElementReferenceValidationError);
    }
  });

  it('requires DSL-valid Interactive content and bounds source names deterministically', () => {
    const invalidWidget = makeBody('<div id="density-slider"></div>');
    (invalidWidget.storeState.scenes[0].content as Record<string, unknown>).widgetType =
      'unknown-widget';
    expect(() => resolveElementReference(invalidWidget)).toThrow(/HTML-backed Interactive Scene/);

    const longTag = `x-${'a'.repeat(127)}`;
    expect(() => resolve(`<${longTag} id="density-slider"></${longTag}>`)).toThrow(
      /excluded or invalid source node/,
    );

    const longAttributeName = `data-${'a'.repeat(124)}`;
    const result = resolve(
      `<div id="density-slider" ${longAttributeName}="hidden" data-ok="visible"></div>`,
    );
    expect(result.evidence.component.attributes).toContainEqual({
      name: 'data-ok',
      value: 'visible',
    });
    expect(result.evidence.component.attributes.map(({ name }) => name)).not.toContain(
      longAttributeName,
    );
    expect(result.evidence.omittedItems['component.attributes']).toBe(1);
  });

  it('uses explicit label, then wrapping label, then aria-label without reading siblings', () => {
    expect(
      resolve(
        '<label for="density-slider">Explicit</label><label>Wrapper<input id="density-slider" aria-label="ARIA"></label>',
      ).evidence.component.label,
    ).toBe('Explicit');
    expect(
      resolve('<label>Wrapper<input id="density-slider" aria-label="ARIA"></label>').evidence
        .component.label,
    ).toBe('Wrapper');
    expect(resolve('<input id="density-slider" aria-label="ARIA">').evidence.component.label).toBe(
      'ARIA',
    );
  });

  it('enforces the stable authored ID grammar at the same 127-code-point boundary', () => {
    const acceptedId = `a${'b'.repeat(126)}`;
    expect(
      resolve(`<div id="${acceptedId}">ok</div>`, `#${acceptedId}`).evidence.component.id,
    ).toBe(acceptedId);

    const rejectedId = `a${'b'.repeat(127)}`;
    expect(() => resolve(`<div id="${rejectedId}">no</div>`, `#${rejectedId}`)).toThrow(
      /stable authored #id/,
    );
    expect(() => resolve('<div id="bad:id"></div>', '#bad:id')).toThrow(/stable authored #id/);
  });

  it('bounds strings, retains whole attributes, and keeps the final packet valid and truthful', () => {
    const attributes = Array.from(
      { length: 70 },
      (_, index) => `data-a${String(index).padStart(2, '0')}="${'😀'.repeat(600)}"`,
    ).join(' ');
    const result = resolve(
      `<section id="density-slider" ${attributes}>${'文😀'.repeat(8_000)}</section>`,
    );
    const packetLength = Array.from(result.childEvidence).length;

    expect(result.evidence.component.attributes.length).toBeLessThanOrEqual(64);
    expect(result.evidence.omittedItems['component.attributes']).toBe(
      71 - result.evidence.component.attributes.length,
    );
    expect(result.evidence.truncatedFields).toContain('component.sourceText');
    expect(result.evidence.truncatedFields).toContain('component.sourceMarkup');
    expect(result.evidence.truncatedFields).toContain('component.attributes.data-a00');
    for (const path of result.evidence.truncatedFields.filter((value) =>
      value.startsWith('component.attributes.'),
    )) {
      expect(result.evidence.component.attributes.map(({ name }) => name)).toContain(
        path.slice('component.attributes.'.length),
      );
    }
    expect(packetLength).toBeLessThanOrEqual(24_000);
    expect(() => JSON.parse(result.childEvidence.split('\n').at(-1) ?? '')).not.toThrow();
  });

  it('preserves each control semantic core inside a 240-code-point routing hint', () => {
    const cases = [
      {
        hint: hintFor(
          `<input id="range" type="range" value="${'9'.repeat(300)}" min="0" max="100" step="5">`,
          '#range',
        ),
        expected: ['type="range"', 'value="', 'min="0"', 'max="100"', 'step="5"'],
      },
      {
        hint: hintFor(
          `<input id="check" type="checkbox" checked value="${'x'.repeat(300)}" name="choice">`,
          '#check',
        ),
        expected: ['type="checkbox"', 'checked=""', 'value="', 'name="choice"'],
      },
      {
        hint: hintFor(
          '<select id="select" name="answer"><option value="a" selected>Alpha</option><option selected>Beta</option></select>',
          '#select',
        ),
        expected: ['name="answer"', 'authoredSelectedOptions=[', 'Alpha'],
      },
      {
        hint: hintFor('<button id="button" type="submit">Run experiment</button>', '#button'),
        expected: ['type="submit"', 'text="Run experiment"'],
      },
    ];
    for (const { hint, expected } of cases) {
      expect(Array.from(hint).length).toBeLessThanOrEqual(240);
      expected.forEach((value) => expect(hint).toContain(value));
    }
  });

  it('bounds JSON escaping and astral Unicode without cutting formatted syntax', () => {
    const hint = hintFor(
      `<input id="density-slider" type="range" value='${'😀"\\\n'.repeat(100)}' min="0" max="9" step="1">`,
      '#density-slider',
    );
    expect(Array.from(hint).length).toBeLessThanOrEqual(240);
    expect(hint).toContain('min="0"');
    expect(hint).toContain('max="9"');
    expect(hint).toContain('step="1"');
    expect(() => {
      for (const segment of hint.split('; ')) {
        const separator = segment.indexOf('=');
        if (separator >= 0 && segment.slice(separator + 1).startsWith('"')) {
          JSON.parse(segment.slice(separator + 1));
        }
      }
    }).not.toThrow();
  });
});
