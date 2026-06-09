import { describe, expect, it } from 'vitest';
import { mml2omml } from 'mathml2omml';

/**
 * Regression for #680: parse.js indexed `textContainerNames.includes[...]`
 * instead of calling `.includes(...)`, so the "trailing text node" branch was
 * always skipped and trailing text inside a text container was dropped.
 */
describe('mml2omml trailing text in text containers (#680)', () => {
  it('preserves text that trails a child element inside <mtext>', () => {
    const omml = mml2omml('<math><mtext>a<mspace/>b</mtext></math>');
    // The trailing "b" used to be silently dropped.
    expect(omml).toContain('b');
    expect(omml).toContain('a');
  });

  it('preserves trailing text inside <mi>', () => {
    const omml = mml2omml('<math><mi>f<mspace/>g</mi></math>');
    expect(omml).toContain('g');
  });

  it('still emits valid OMML for a plain text container', () => {
    const omml = mml2omml('<math><mtext>hello</mtext></math>');
    expect(omml).toContain('hello');
    expect(omml).toContain('m:oMath');
  });
});
