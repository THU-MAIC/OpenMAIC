import { describe, it, expect, beforeEach } from 'vitest';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';

describe('useSceneRuntimeErrors', () => {
  beforeEach(() => useSceneRuntimeErrors.setState({ errors: {} }));

  it('records errors per scene', () => {
    useSceneRuntimeErrors.getState().addError('s1', 'JSON.parse SyntaxError');
    useSceneRuntimeErrors.getState().addError('s2', 'ReferenceError: katex');
    expect(useSceneRuntimeErrors.getState().errors).toEqual({
      s1: ['JSON.parse SyntaxError'],
      s2: ['ReferenceError: katex'],
    });
  });

  it('dedups identical errors (a render loop logging the same thing)', () => {
    const add = useSceneRuntimeErrors.getState().addError;
    add('s1', 'boom');
    add('s1', 'boom');
    add('s1', 'boom');
    expect(useSceneRuntimeErrors.getState().errors.s1).toEqual(['boom']);
  });

  it('ignores blank messages', () => {
    useSceneRuntimeErrors.getState().addError('s1', '   ');
    expect(useSceneRuntimeErrors.getState().errors.s1).toBeUndefined();
  });

  it('caps to the most recent 8 distinct errors', () => {
    for (let i = 0; i < 12; i++) useSceneRuntimeErrors.getState().addError('s1', `err ${i}`);
    const e = useSceneRuntimeErrors.getState().errors.s1;
    expect(e).toHaveLength(8);
    expect(e[0]).toBe('err 4');
    expect(e[7]).toBe('err 11');
  });

  it('clearScene drops only that scene; clearAll drops everything', () => {
    const { addError, clearScene, clearAll } = useSceneRuntimeErrors.getState();
    addError('s1', 'a');
    addError('s2', 'b');
    clearScene('s1');
    expect(useSceneRuntimeErrors.getState().errors).toEqual({ s2: ['b'] });
    clearAll();
    expect(useSceneRuntimeErrors.getState().errors).toEqual({});
  });
});
