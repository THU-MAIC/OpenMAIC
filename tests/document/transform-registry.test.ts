import { describe, expect, it } from 'vitest';

import * as documentApi from '@/lib/document';
import {
  DEFAULT_DOCUMENT_TRANSFORMS,
  DocumentTransformRegistry,
  createDefaultDocumentTransformRegistry,
} from '@/lib/document';

describe('document transform registry', () => {
  it('exposes the deterministic default transform order', () => {
    const registry = createDefaultDocumentTransformRegistry();

    expect(registry.list().map((transform) => transform.id)).toEqual(['normalize', 'remove-noise']);
    expect(DEFAULT_DOCUMENT_TRANSFORMS).toHaveLength(2);
    expect(documentApi).not.toHaveProperty('detectDocumentStructureTransform');
  });

  it('rejects duplicate IDs and reports missing required transforms', () => {
    const transform = DEFAULT_DOCUMENT_TRANSFORMS[0];
    const registry = new DocumentTransformRegistry([transform]);

    expect(() => registry.register(transform)).toThrow(/already registered/);
    expect(() => registry.require('missing')).toThrow(/Unknown document transform/);
  });
});
