import { describe, it, expect } from 'vitest';
import { applySearchReplace } from '@/lib/repair/search-replace';

const BLOCK = (s: string, r: string) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

describe('applySearchReplace', () => {
  it('applies a single unique replacement', () => {
    const out = applySearchReplace(
      '<button>X</button>',
      BLOCK('<button>X</button>', '<button id="b">X</button>'),
    );
    expect(out).toEqual({ ok: true, result: '<button id="b">X</button>' });
  });

  it('fails when SEARCH is not found', () => {
    const out = applySearchReplace('<div></div>', BLOCK('<span></span>', '<span>y</span>'));
    expect(out.ok).toBe(false);
  });

  it('fails when SEARCH matches more than once (ambiguous)', () => {
    const out = applySearchReplace('<i></i><i></i>', BLOCK('<i></i>', '<b></b>'));
    expect(out.ok).toBe(false);
  });

  it('applies multiple blocks in order', () => {
    const src = 'A B';
    const out = applySearchReplace(src, `${BLOCK('A', 'X')}\n${BLOCK('B', 'Y')}`);
    expect(out).toEqual({ ok: true, result: 'X Y' });
  });

  it('treats replacement $ sequences as literal', () => {
    const out = applySearchReplace('PRICE', BLOCK('PRICE', 'cost $& and $1 and $$'));
    expect(out).toEqual({ ok: true, result: 'cost $& and $1 and $$' });
  });
});
