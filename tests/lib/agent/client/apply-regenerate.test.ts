import { describe, expect, it } from 'vitest';

import { toRuntimeSlideContent, planRegenerateApply } from '@/lib/agent/client/apply-regenerate';
import type { GeneratedSlideContent } from '@/lib/types/generation';
import type { Scene, SceneContent } from '@/lib/types/stage';

const GEN: GeneratedSlideContent = {
  elements: [{ id: 'e_new', type: 'text', left: 0, top: 0, width: 1, height: 1 } as never],
  background: { type: 'solid', color: '#abcdef' } as never,
  remark: '',
};

function slideScene(): Pick<Scene, 'content' | 'actions'> {
  return {
    content: {
      type: 'slide',
      canvas: {
        id: 'existing-canvas',
        viewportSize: 1234,
        viewportRatio: 0.5625,
        theme: { fontName: 'KeepMe' },
        elements: [{ id: 'e_old' }],
        animations: [{ id: 'anim_old', elId: 'e_old', type: 'in', effect: 'fadeIn' }],
      },
    } as unknown as SceneContent,
    actions: [{ type: 'speech', id: 'a_old' } as never],
  };
}

describe('toRuntimeSlideContent', () => {
  it('preserves the existing canvas (id/viewport/theme) and overrides elements + background', () => {
    const existingCanvas = {
      id: 'existing-canvas',
      viewportSize: 1234,
      theme: { fontName: 'KeepMe' },
    };
    const rt = toRuntimeSlideContent(GEN, existingCanvas) as unknown as {
      type: string;
      canvas: Record<string, unknown>;
    };
    expect(rt.type).toBe('slide');
    expect(rt.canvas.id).toBe('existing-canvas');
    expect(rt.canvas.viewportSize).toBe(1234);
    expect((rt.canvas.theme as { fontName: string }).fontName).toBe('KeepMe');
    expect((rt.canvas.elements as { id: string }[])[0].id).toBe('e_new');
    expect((rt.canvas.background as { color: string }).color).toBe('#abcdef');
  });

  it('mints a default canvas when the scene has none', () => {
    const rt = toRuntimeSlideContent(GEN, undefined) as unknown as {
      schemaVersion?: number;
      canvas: Record<string, unknown>;
    };
    expect(rt.canvas.viewportSize).toBe(1000);
    expect(rt.canvas.viewportRatio).toBe(0.5625);
    expect(rt.canvas.id).toBeTruthy();
    // schemaVersion lives at the SlideContent top level (sibling of canvas),
    // not inside the canvas object — matching slide-defaults / migrateSlideContent.
    expect(rt.schemaVersion).toBe(1);
    expect(rt.canvas.schemaVersion).toBeUndefined();
  });

  it('clears stale animations referencing the replaced (now-gone) element ids', () => {
    // The existing canvas has animations bound to old element ids. Every regen
    // element gets a brand-new id, so preserving the animations would strand
    // them — they must be cleared.
    const existingCanvas = {
      id: 'cv',
      animations: [{ id: 'anim_old', elId: 'e_old', type: 'in', effect: 'fadeIn' }],
    };
    const rt = toRuntimeSlideContent(GEN, existingCanvas) as unknown as {
      canvas: Record<string, unknown>;
    };
    expect(rt.canvas.animations).toEqual([]);
  });

  it('keeps the existing background when the gen omits it (no wipe)', () => {
    const genNoBg: GeneratedSlideContent = {
      elements: [{ id: 'e_new', type: 'text', left: 0, top: 0, width: 1, height: 1 } as never],
      background: undefined,
      remark: '',
    };
    const existingCanvas = { id: 'cv', background: '#abc' };
    const rt = toRuntimeSlideContent(genNoBg, existingCanvas) as unknown as {
      canvas: Record<string, unknown>;
    };
    expect(rt.canvas.background).toBe('#abc');
  });
});

describe('planRegenerateApply', () => {
  it('regenerate_scene: snapshots pre-state and applies converted content + actions', () => {
    const scene = slideScene();
    const plan = planRegenerateApply(
      { sceneId: 's1', content: GEN, actions: [{ type: 'speech', id: 'a_new' } as never] },
      scene,
    );
    // snapshot is the PRE-regenerate scene, for restore.
    expect(plan.snapshot?.sceneId).toBe('s1');
    expect((plan.snapshot?.actions[0] as { id: string }).id).toBe('a_old');
    expect(
      (plan.snapshot?.content as { canvas: { elements: { id: string }[] } }).canvas.elements[0].id,
    ).toBe('e_old');
    // patch applies the new content + actions.
    const patch = plan.patch as {
      content: { canvas: { elements: { id: string }[]; animations: unknown[] } };
      actions: { id: string }[];
    };
    expect(patch.content.canvas.elements[0].id).toBe('e_new');
    expect(patch.actions[0].id).toBe('a_new');
    // Stale animations bound to the replaced element ids are cleared.
    expect(patch.content.canvas.animations).toEqual([]);
    // ...while the snapshot retains the original animations for restore.
    expect(
      (plan.snapshot?.content as { canvas: { animations: { id: string }[] } }).canvas.animations[0]
        .id,
    ).toBe('anim_old');
  });

  it('regenerate_scene with empty actions applies content but not actions (no wipe)', () => {
    const plan = planRegenerateApply({ sceneId: 's1', content: GEN, actions: [] }, slideScene());
    expect(plan.patch).toBeTruthy();
    expect((plan.patch as Record<string, unknown>).content).toBeTruthy();
    expect((plan.patch as Record<string, unknown>).actions).toBeUndefined();
  });

  it('regenerate_scene_actions: actions-only patch + a snapshot of the prior narration', () => {
    const scene = slideScene();
    const plan = planRegenerateApply(
      { sceneId: 's1', actions: [{ type: 'speech', id: 'a_new' } as never] },
      scene,
    );
    // No content change, but a snapshot (current content + prior actions) so the
    // narration regen can be reverted too.
    expect(plan.patch).toEqual({ actions: [{ type: 'speech', id: 'a_new' }] });
    expect(plan.snapshot).toEqual({
      sceneId: 's1',
      content: scene.content,
      actions: scene.actions ?? [],
      // narration-only → restore reverts actions only, not slide content
      actionsOnly: true,
    });
  });

  it('does nothing without a sceneId', () => {
    expect(planRegenerateApply({ actions: [{ id: 'a' } as never] }, slideScene())).toEqual({
      snapshot: null,
      patch: null,
    });
  });

  it('actions-only with empty actions is a no-op', () => {
    expect(planRegenerateApply({ sceneId: 's1', actions: [] }, slideScene())).toEqual({
      snapshot: null,
      patch: null,
    });
  });
});

function interactiveScene(): Pick<Scene, 'content' | 'actions'> {
  return {
    content: {
      type: 'interactive',
      url: 'about:blank',
      html: '<html><!-- old --></html>',
      widgetType: 'simulation',
      widgetConfig: {
        type: 'simulation',
        concept: 'energy',
        description: 'Energy simulation',
        variables: [],
      },
    } as unknown as SceneContent,
    actions: [{ type: 'speech', id: 'a_old' } as never],
  };
}

describe('planRegenerateApply — edit_interactive_html', () => {
  it('writes the fixed html and preserves the other interactive fields', () => {
    const plan = planRegenerateApply(
      { sceneId: 'w1', html: '<html><!-- fixed --></html>' },
      interactiveScene(),
      'edit_interactive_html',
    );
    const content = plan.patch?.content as unknown as {
      type: string;
      url: string;
      html: string;
      widgetType?: string;
      widgetConfig?: { type: string };
    };
    expect(content.type).toBe('interactive');
    expect(content.html).toContain('fixed');
    expect(content.url).toBe('about:blank');
    expect(content.widgetType).toBe('simulation');
    expect(content.widgetConfig?.type).toBe('simulation');
  });

  it('snapshots the pre-fix content for restore', () => {
    const scene = interactiveScene();
    const plan = planRegenerateApply(
      { sceneId: 'w1', html: '<html><!-- fixed --></html>' },
      scene,
      'edit_interactive_html',
    );
    expect(plan.snapshot).toEqual({
      sceneId: 'w1',
      content: scene.content,
      actions: scene.actions,
    });
  });

  it('does nothing when the scene is not interactive', () => {
    expect(
      planRegenerateApply(
        { sceneId: 's1', html: '<html></html>' },
        slideScene(),
        'edit_interactive_html',
      ),
    ).toEqual({ snapshot: null, patch: null });
  });
});
