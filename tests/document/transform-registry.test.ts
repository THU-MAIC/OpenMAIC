import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOCUMENT_TRANSFORMS,
  DocumentTransformRegistry,
  createDefaultDocumentTransformRegistry,
} from '@/lib/document';

describe('document transform registry', () => {
  it('exposes the deterministic default transform order', () => {
    const registry = createDefaultDocumentTransformRegistry();

    expect(registry.list().map((transform) => transform.id)).toEqual([
      'normalize',
      'remove-noise',
      'detect-structure',
    ]);
    expect(DEFAULT_DOCUMENT_TRANSFORMS).toHaveLength(3);
  });

  it('rejects duplicate IDs and reports missing required transforms', () => {
    const transform = DEFAULT_DOCUMENT_TRANSFORMS[0];
    const registry = new DocumentTransformRegistry([transform]);

    expect(() => registry.register(transform)).toThrow(/already registered/);
    expect(() => registry.require('missing')).toThrow(/Unknown document transform/);
  });
});
