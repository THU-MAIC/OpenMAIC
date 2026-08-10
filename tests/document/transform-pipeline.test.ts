import { describe, expect, it, vi } from 'vitest';

import { transformDocument } from '@/lib/document';
import type { DocumentArtifact, DocumentTransform } from '@/lib/document';

function artifact(text = 'Original'): DocumentArtifact {
  return {
    metadata: { fileName: 'manual.md', mimeType: 'text/markdown' },
    blocks: [{ id: 'text_1', type: 'markdown', text }],
    assets: [],
  };
}

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

describe('document transform pipeline', () => {
  it('runs transforms in order, records lineage, metrics, and keeps the input immutable', async () => {
    const input = artifact();
    const append = (id: string, suffix: string): DocumentTransform => ({
      id,
      displayName: id,
      version: '1.0.0',
      capabilities: {},
      apply(current) {
        current.blocks[0].text += suffix;
        return { artifact: current };
      },
    });

    const result = await transformDocument(
      input,
      [append('first', ' A'), append('second', ' B')],
      context,
    );

    expect(input.blocks[0].text).toBe('Original');
    expect(result.artifact.blocks[0].text).toBe('Original A B');
    expect(result.artifact.transforms?.map((record) => record.transformId)).toEqual([
      'first',
      'second',
    ]);
    expect(result.artifact.transforms?.every((record) => record.status === 'applied')).toBe(true);
    expect(result.metrics).toMatchObject({
      inputChars: 8,
      outputChars: 12,
      inputAssets: 0,
      outputAssets: 0,
    });
  });

  it('continues after a failed transform in best-effort mode and records the failure', async () => {
    const failing: DocumentTransform = {
      id: 'failing',
      displayName: 'Failing',
      version: '1.0.0',
      capabilities: {},
      apply() {
        throw new Error('broken input');
      },
    };
    const following: DocumentTransform = {
      id: 'following',
      displayName: 'Following',
      version: '1.0.0',
      capabilities: {},
      apply(current) {
        current.blocks[0].text = 'Recovered';
        return { artifact: current };
      },
    };

    const result = await transformDocument(artifact(), [failing, following], context, {
      failurePolicy: 'best-effort',
    });

    expect(result.artifact.blocks[0].text).toBe('Recovered');
    expect(result.artifact.transforms?.map((record) => record.status)).toEqual([
      'failed',
      'applied',
    ]);
    expect(result.diagnostics[0].message).toContain('broken input');
  });

  it('fails fast by default and does not run later transforms', async () => {
    const laterApply = vi.fn();
    const transforms: DocumentTransform[] = [
      {
        id: 'failing',
        displayName: 'Failing',
        version: '1.0.0',
        capabilities: {},
        apply() {
          throw new Error('stop');
        },
      },
      {
        id: 'later',
        displayName: 'Later',
        version: '1.0.0',
        capabilities: {},
        apply(current) {
          laterApply();
          return { artifact: current };
        },
      },
    ];

    await expect(transformDocument(artifact(), transforms, context)).rejects.toThrow('stop');
    expect(laterApply).not.toHaveBeenCalled();
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      transformDocument(artifact(), [], { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves pipeline-owned history when a transform rebuilds the artifact', async () => {
    const rebuild: DocumentTransform = {
      id: 'rebuild',
      displayName: 'Rebuild',
      version: '1.0.0',
      capabilities: {},
      apply(current) {
        return {
          artifact: {
            metadata: { ...current.metadata },
            blocks: current.blocks.map((block) => ({ ...block, text: `${block.text} rebuilt` })),
            assets: [],
          },
        };
      },
    };
    const first: DocumentTransform = {
      id: 'first',
      displayName: 'First',
      version: '1.0.0',
      capabilities: {},
      apply(current) {
        return { artifact: current };
      },
    };

    const result = await transformDocument(artifact(), [first, rebuild], context);

    expect(result.artifact.transforms?.map((record) => record.transformId)).toEqual([
      'first',
      'rebuild',
    ]);
  });
});
