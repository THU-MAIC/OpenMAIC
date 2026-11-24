import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function javascriptExamples(path: string): string[] {
  const markdown = readFileSync(new URL(path, import.meta.url), 'utf8');
  return [...markdown.matchAll(/```javascript\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

it('shares diagram step state across classic scripts for narration and controls', () => {
  const listener = javascriptExamples('../templates/diagram-content/system.md').find((source) =>
    source.includes("case 'REVEAL_ELEMENT'"),
  );
  expect(listener).toBeDefined();

  const context = createContext({
    document: {
      createElement: () => ({}),
      head: { appendChild: () => {} },
      querySelector: () => null,
    },
  });
  runInContext(
    `const config = { revealOrder: ['first', 'second', 'third'] };
     const revealOrder = config.revealOrder;
     let revealedCount = 1;
     let visibleNodes;
     function renderStep() { visibleNodes = revealOrder.slice(0, revealedCount); }
     function next() { revealedCount++; renderStep(); }
     function back() { revealedCount--; renderStep(); }
     function reset() { revealedCount = 1; renderStep(); }
     const window = {
       addEventListener(type, listener) { this[type] = listener; }
     };
     renderStep();`,
    context,
  );
  runInContext(listener!, context);
  expect(runInContext('visibleNodes', context)).toEqual(['first']);
  runInContext('next()', context);
  expect(runInContext('visibleNodes', context)).toEqual(['first', 'second']);
  runInContext(
    `window.message({ data: { type: 'REVEAL_ELEMENT', target: '#node-third' } })`,
    context,
  );
  expect(runInContext('visibleNodes', context)).toEqual(['first', 'second', 'third']);
  runInContext(
    `window.message({ data: { type: 'REVEAL_ELEMENT', target: '#node-second' } })`,
    context,
  );
  expect(runInContext('visibleNodes', context)).toEqual(['first', 'second', 'third']);
  runInContext('back()', context);
  expect(runInContext('visibleNodes', context)).toEqual(['first', 'second']);
  runInContext('reset()', context);
  expect(runInContext('visibleNodes', context)).toEqual(['first']);
});

it('runs the 3D listener with scene-local state and the platform message fields', () => {
  const listener = javascriptExamples('../templates/visualization3d-content/system.md').find(
    (source) => source.includes("addEventListener('message'"),
  );
  expect(listener).toBeDefined();

  const setPosition = vi.fn();
  const setScale = vi.fn();
  const setEmissive = vi.fn();
  const updateControls = vi.fn();
  const render = vi.fn();
  const canvas = { style: { outline: '' }, removeAttribute: vi.fn() };
  const info = { textContent: '' };
  const context = createContext({
    setPosition,
    setScale,
    setEmissive,
    updateControls,
    render,
    document: {
      querySelector: (selector: string) => (selector === '#canvas-container' ? canvas : null),
      getElementById: () => info,
    },
    setTimeout: () => {},
  });
  runInContext(
    `const window = {
       addEventListener(type, listener) { this[type] = listener; }
     };
     function initScene() {
       const camera = { position: { set: setPosition } };
       const controls = { update: updateControls };
       const renderer = { render };
       const scene = {};
       const objects = {
         '#earth': [{ material: { emissive: { set: setEmissive } } }],
         cellGroup: { scale: { setScalar: setScale } },
       };
       ${listener}
     }
     initScene();
     window.message({ data: { type: 'SET_WIDGET_STATE', state: { cameraPosition: [1, 2, 3], scale: 2 } } });
     window.message({ data: { type: 'HIGHLIGHT_ELEMENT', target: '#earth' } });
     window.message({ data: { type: 'HIGHLIGHT_ELEMENT', target: '#canvas-container' } });
     window.message({ data: { type: 'ANNOTATE_ELEMENT', target: '#canvas-container', content: 'Orbit' } });
     window.message({ data: { type: 'REVEAL_ELEMENT', target: '#canvas-container' } });`,
    context,
  );
  expect(setPosition).toHaveBeenCalledWith(1, 2, 3);
  expect(setScale).toHaveBeenCalledWith(2);
  expect(updateControls).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledTimes(2);
  expect(setEmissive).toHaveBeenCalledWith(0xffff00);
  expect(canvas.style.outline).toBe('3px solid #a78bfa');
  expect(info.textContent).toBe('Orbit');
  expect(canvas.removeAttribute).toHaveBeenCalledWith('hidden');
});

it('executes the canonical projection on initial render, update, reset, and timer paths', async () => {
  const examples = javascriptExamples('../snippets/interactive-observation.md');
  const projection = examples.find((source) => source.includes('function publishCurrentState()'));
  expect(projection).toBeDefined();
  const publications: unknown[] = [];
  const stepNode = { textContent: '' };
  const context = createContext({
    setTimeout,
    document: { getElementById: () => stepNode },
    publishState: (observation: unknown) => publications.push(observation),
  });
  runInContext(projection!, context);
  for (const [action, step] of [
    ['', 1],
    ['advanceStep()', 2],
    ['resetActivity()', 1],
    ['new Promise(resolve => setTimeout(() => { advanceStep(); resolve(); }, 0))', 2],
  ] as const) {
    if (action) await runInContext(action, context);
    expect(publications.at(-1)).toEqual({ summary: `Step ${step}`, state: { step } });
    expect(String(stepNode.textContent)).toBe(String(step));
  }
  expect(publications).toHaveLength(4);
});

const gameStartExamples = javascriptExamples('../templates/game-content/system.md').filter(
  (source) => source.includes('function init()') && source.includes('function startGame()'),
);
it('provides two game-start examples with explicit state construction', () => {
  expect(gameStartExamples).toHaveLength(2);
});

for (const [index, source] of gameStartExamples.entries()) {
  it(`game-start example ${index + 1} constructs state before render, Start, and reset`, () => {
    const context = createContext({
      document: { getElementById: () => ({ classList: { add: () => {} } }) },
      requestAnimationFrame: () => {},
    });
    runInContext(
      `let publications = [];
       function publishCurrentState() {
         publications.push({ summary: state.gameActive ? 'Playing' : 'Ready', state: { ...state } });
       }
       function render() {
         if (state === null) throw new Error('render before state construction');
         publishCurrentState();
       }
       function initLevel() {
         if (state === null) throw new Error('level before state construction');
       }
       function gameLoop() {}`,
      context,
    );
    runInContext(source, context);
    expect(runInContext('publications.at(-1).state.gameActive', context)).toBe(false);
    // Test each entry point starting from an unconstructed state as in #1697.
    runInContext('state = null; startGame()', context);
    expect(runInContext('publications.at(-1).state.gameActive', context)).toBe(true);
    expect(runInContext('typeof publications.at(-1).state.startTime', context)).toBe('number');
    runInContext('state = null; resetGame()', context);
    expect(runInContext('publications.at(-1)', context)).toEqual({
      summary: 'Ready',
      state: { gameActive: false, startTime: null },
    });
    expect(runInContext('publications.length', context)).toBe(3);
  });
}
