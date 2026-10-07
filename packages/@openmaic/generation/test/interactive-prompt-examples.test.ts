import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';

function javascriptExamples(path: string): string[] {
  const markdown = readFileSync(new URL(path, import.meta.url), 'utf8');
  return [...markdown.matchAll(/```javascript\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

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
