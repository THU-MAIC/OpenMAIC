/**
 * The interactive-actions prompt always receives an element inventory computed
 * from the scene's current html — never a persisted field. This test locks in
 * that behavior: any interactive scene with html gets real selectors, and the
 * "(no interactive elements detected)" sentinel is only used when the html is
 * absent or truly has no inventoried elements.
 */
import { describe, expect, it } from 'vitest';

import { generateSceneActions } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedInteractiveContent, SceneOutline } from '@/lib/types/generation';

function baseOutline(): SceneOutline {
  return {
    id: 'scene-inventory-recompute',
    type: 'interactive',
    title: 'Inventory recompute test',
    description: 'always recompute from html',
    keyPoints: ['key point'],
    order: 0,
    widgetType: 'game',
    widgetOutline: { gameType: 'puzzle' },
  };
}

describe('generateSceneActions — element inventory', () => {
  it('recomputes the inventory from content.html on every call', async () => {
    let lastUser = '';
    const aiCall: AICallFn = async (_system, user) => {
      lastUser = user;
      return '[]';
    };

    const content: GeneratedInteractiveContent = {
      html:
        '<div id="game-container">' +
        '  <button id="check-btn">Check</button>' +
        '  <div id="active-zone" class="dropzone"></div>' +
        '  <span id="score-val">0</span>' +
        '</div>',
      widgetType: 'game',
      widgetConfig: {
        type: 'game',
        gameType: 'puzzle',
        description: 'd',
        scoring: { correctPoints: 10, speedBonus: 5 },
      },
    };

    await generateSceneActions(baseOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    // Prompt should carry the real selectors, not the fallback sentinel.
    expect(lastUser).toContain('#game-container');
    expect(lastUser).toContain('#check-btn');
    expect(lastUser).toContain('#active-zone');
    expect(lastUser).toContain('#score-val');
    expect(lastUser).not.toContain('(no interactive elements detected)');
  });

  it('shows the sentinel only when there is no html at all', async () => {
    let lastUser = '';
    const aiCall: AICallFn = async (_system, user) => {
      lastUser = user;
      return '[]';
    };

    const content: GeneratedInteractiveContent = {
      html: '',
      widgetType: 'game',
      widgetConfig: {
        type: 'game',
        gameType: 'puzzle',
        description: 'd',
        scoring: { correctPoints: 10, speedBonus: 5 },
      },
    };

    await generateSceneActions(baseOutline(), content, aiCall, {
      languageDirective: 'Teach in English.',
    });

    expect(lastUser).toContain('(no interactive elements detected)');
  });
});
