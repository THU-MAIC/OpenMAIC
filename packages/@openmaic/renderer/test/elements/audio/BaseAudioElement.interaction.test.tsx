// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTAudioElement } from '@openmaic/dsl';
import { BaseAudioElement } from '../../../src/elements/audio/BaseAudioElement';

const audio: PPTAudioElement = {
  id: 'audio-1',
  type: 'audio',
  left: 40,
  top: 80,
  width: 48,
  height: 48,
  rotate: 0,
  fixedRatio: true,
  color: '#7c3aed',
  loop: false,
  autoplay: false,
  src: 'https://cdn.example.com/lesson-intro.mp3',
};

class MockAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  loop = false;
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
}

afterEach(() => vi.unstubAllGlobals());

describe('BaseAudioElement preview control', () => {
  it('switches from the speaker to a pause control while previewing', async () => {
    const instance = new MockAudio();
    const AudioMock = vi.fn(function AudioMock() {
      return instance;
    });
    vi.stubGlobal('Audio', AudioMock);
    render(<BaseAudioElement elementInfo={audio} />);

    const button = screen.getByRole('button', { name: 'Play audio' });
    fireEvent.click(button);

    expect(AudioMock).toHaveBeenCalledWith(audio.src);
    expect(
      (await screen.findByRole('button', { name: 'Pause audio' })).getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Pause audio' }));
    expect(instance.pause).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Play audio' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
