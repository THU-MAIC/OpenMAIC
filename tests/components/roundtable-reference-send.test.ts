// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  onTranscription: undefined as ((text: string) => void) | undefined,
}));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: (options: { onTranscription: (text: string) => void }) => {
    audio.onTranscription = options.onTranscription;
    return {
      isRecording: false,
      isProcessing: false,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    };
  },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/components/ui/avatar-display', () => ({ AvatarDisplay: () => null }));
vi.mock('@/components/chat/proactive-card', () => ({ ProactiveCard: () => null }));
vi.mock('@/components/roundtable/presentation-speech-overlay', () => ({
  PresentationSpeechOverlay: () => null,
}));
import { Roundtable } from '@/components/roundtable';

describe('reference rejection preserves the question composer', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps typed text and allows sending it after the reference is fixed', async () => {
    const canSendMessage = vi.fn(() => false);
    const onMessageSend = vi.fn();
    await act(async () =>
      root.render(createElement(Roundtable, { canSendMessage, onMessageSend })),
    );
    act(() =>
      (
        container.querySelector('svg.lucide-message-square')!.closest('button') as HTMLElement
      ).click(),
    );
    const input = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Why this formula?',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onMessageSend).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Why this formula?');
    canSendMessage.mockReturnValue(true);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onMessageSend).toHaveBeenCalledExactlyOnceWith('Why this formula?');
  });

  it('moves a rejected voice question into the editable composer without sending', async () => {
    const onMessageSend = vi.fn();
    await act(async () =>
      root.render(createElement(Roundtable, { canSendMessage: () => false, onMessageSend })),
    );
    act(() => audio.onTranscription?.('Explain the selected equation.'));
    expect(onMessageSend).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('Explain the selected equation.');
  });
});
