// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from '@/lib/store/stage';
import { useCourseTimeline } from '@/lib/edit/course-timeline';

const mocks = vi.hoisted(() => ({
  regenerateSpeechAudio: vi.fn(),
  audioExists: vi.fn(async () => false),
  audioObjectUrl: vi.fn(async () => null),
  resolveSpeechAudioId: vi.fn((_order: number, a: { audioId?: string }) => a.audioId),
  resolveLegacySpeechAudioId: vi.fn(async () => undefined),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/classroom/generation-permission', () => ({
  useMayGenerateForStage: () => true,
  mayGenerateForStage: () => true,
}));

vi.mock('@/lib/audio/regenerate-speech-tts', () => ({
  isManagedTtsActive: () => true,
  audioExists: mocks.audioExists,
  audioObjectUrl: mocks.audioObjectUrl,
  regenerateSpeechAudio: mocks.regenerateSpeechAudio,
  resolveSpeechAudioId: mocks.resolveSpeechAudioId,
  resolveLegacySpeechAudioId: mocks.resolveLegacySpeechAudioId,
}));

vi.mock('@/components/edit/EditDock/dock-context', () => ({
  DOCK_BAR_ACTION: '',
  DockBarTip: ({ children }: { children: React.ReactNode }) => children,
  useEditDock: () => ({ expand: vi.fn(), dockBarSlot: null }),
}));

import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';

describe('ActionsBar reading-only formula pair edit + regeneration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.regenerateSpeechAudio.mockReset().mockResolvedValue('ast_regen_1');
    mocks.audioExists.mockReset().mockResolvedValue(false);
    useCourseTimeline.setState({ lines: {}, agentRun: null });
    useStageStore.setState({
      stage: { id: 'stage-pair', name: 'Math', createdAt: 1, updatedAt: 1 } as never,
      currentSceneId: 'scene-1',
      scenes: [
        {
          id: 'scene-1',
          stageId: 'stage-1',
          type: 'slide',
          title: 'Slide 1',
          order: 1,
          content: {
            type: 'slide',
            canvas: { id: 'c1', width: 1000, height: 562.5, elements: [] },
          },
          actions: [
            {
              id: 'sp-1',
              type: 'speech',
              text: '$x^2$',
              spokenText: 'x squared',
              audioId: 'ast_0',
            },
          ],
        } as never,
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('resyncs the local draft after normalizing a reading-only pair edit and stamps regenerated audio', async () => {
    await act(async () => {
      root.render(createElement(ActionsBar, { sceneId: 'scene-1' } as never));
    });

    const textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe('$x^2$');

    // Simulate typing `[[$x^2$ | x times x]]` and blurring.
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    await act(async () => {
      textarea.focus();
      nativeValueSetter.call(textarea, '[[$x^2$ | x times x]]');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textarea.blur();
      textarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    });

    // Draft resyncs back to `$x^2$` even though the stored caption `$x^2$` did not change.
    expect(textarea.value).toBe('$x^2$');
    const afterCommit = useStageStore.getState().scenes[0]!.actions![0]!;
    expect(afterCommit).toMatchObject({
      id: 'sp-1',
      type: 'speech',
      text: '$x^2$',
      spokenText: 'x times x',
    });
    expect(afterCommit).not.toHaveProperty('audioId');

    // Clicking single-row regenerate synthesizes the new reading and attaches `ast_regen_1`.
    const regenBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="edit.tts.regenerate"]',
    )!;
    await act(async () => {
      regenBtn.click();
    });

    expect(mocks.regenerateSpeechAudio).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ id: 'sp-1', text: '$x^2$', spokenText: 'x times x' }),
      undefined,
    );
    const afterRegen = useStageStore.getState().scenes[0]!.actions![0]!;
    expect(afterRegen).toMatchObject({
      id: 'sp-1',
      type: 'speech',
      text: '$x^2$',
      spokenText: 'x times x',
      audioId: 'ast_regen_1',
    });
  });
});
