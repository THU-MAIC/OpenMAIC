import { describe, expect, test } from 'vitest';

import { extractWidgetConfig, generateWidgetContent, type AICallFn } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';

const renderDiagramPrompt = async (widgetOutline: SceneOutline['widgetOutline']) => {
  let capturedPrompt = '';
  const aiCall: AICallFn = async (_system, user) => {
    capturedPrompt = user;
    return `<!DOCTYPE html>
<html>
  <body>
    <script type="application/json" id="widget-config">
      {"nodes":[],"edges":[],"revealOrder":[]}
    </script>
  </body>
</html>`;
  };

  const outline: SceneOutline = {
    id: 'diagram-scene',
    type: 'interactive',
    title: 'System Map',
    description: 'Explore the system hierarchy.',
    keyPoints: ['Root', 'Branch'],
    order: 1,
    widgetType: 'diagram',
    widgetOutline,
  };

  await generateWidgetContent(outline, aiCall);
  return capturedPrompt;
};

describe('diagram widget node constraints', () => {
  test('forwards the requested count and prescribed nodes to the content prompt', async () => {
    const prompt = await renderDiagramPrompt({
      diagramType: 'hierarchy',
      nodeCount: 3,
      nodes: [
        { id: 'root', label: 'Root' },
        { id: 'branch', label: 'Branch', parentId: 'root' },
      ],
    });

    expect(prompt).toContain('Maximum node count: 3');
    expect(prompt).toContain('"id": "root"');
    expect(prompt).toContain('"parentId": "root"');
    expect(prompt).toContain('Do not add, remove, or replace prescribed nodes');
    expect(prompt).not.toContain('{{');
  });

  test('forwards a count constraint without requiring prescribed nodes', async () => {
    const prompt = await renderDiagramPrompt({
      diagramType: 'flowchart',
      nodeCount: 4,
    });

    expect(prompt).toContain('Maximum node count: 4');
    expect(prompt).not.toContain('## Prescribed Nodes');
    expect(prompt).not.toContain('{{');
  });

  test('omits node constraints when the outline does not provide them', async () => {
    const prompt = await renderDiagramPrompt({ diagramType: 'system' });

    expect(prompt).not.toContain('## Node Count Constraint');
    expect(prompt).not.toContain('## Prescribed Nodes');
    expect(prompt).not.toContain('{{');
  });
});

describe('extractWidgetConfig', () => {
  const configHtml = (json: string) => `<!doctype html>
<script type="application/json" id="widget-config">${json}</script>`;

  test('seeds a missing type from the routed widget type', () => {
    expect(
      extractWidgetConfig(configHtml('{"nodes":[],"edges":[],"revealOrder":[]}'), 'diagram'),
    ).toEqual({ type: 'diagram', nodes: [], edges: [], revealOrder: [] });
  });

  test('preserves an existing valid type', () => {
    expect(extractWidgetConfig(configHtml('{"type":"game","questions":[]}'), 'diagram')).toEqual({
      type: 'game',
      questions: [],
    });
  });

  test.each(['[]', '"diagram"', '42'])('drops non-object config JSON %s', (json) => {
    expect(extractWidgetConfig(configHtml(json), 'diagram')).toBeUndefined();
  });
});
