import { describe, expect, it } from 'vitest';

import { shouldCancelRecordingOnDisable } from '@/components/audio/speech-button';

describe('SpeechButton — cancel-on-disable gating', () => {
  it('cancels an in-flight continuous recording once the button is disabled', () => {
    // PBL case: continuous recognizer is still running when chat starts
    // streaming (disabled flips true) → must cancel so the mic stops and no
    // further transcription is appended during the reply.
    expect(
      shouldCancelRecordingOnDisable({ continuous: true, disabled: true, isRecording: true }),
    ).toBe(true);
  });

  it('does nothing while the continuous recording is still usable', () => {
    expect(
      shouldCancelRecordingOnDisable({ continuous: true, disabled: false, isRecording: true }),
    ).toBe(false);
    expect(
      shouldCancelRecordingOnDisable({ continuous: true, disabled: true, isRecording: false }),
    ).toBe(false);
  });

  it('never touches non-continuous consumers (roundtable / quiz / homepage)', () => {
    // Those buttons auto-stop on pause; disabling them must not change their
    // recording lifecycle, so the gate stays closed for continuous=false.
    expect(
      shouldCancelRecordingOnDisable({ continuous: false, disabled: true, isRecording: true }),
    ).toBe(false);
    expect(
      shouldCancelRecordingOnDisable({ continuous: undefined, disabled: true, isRecording: true }),
    ).toBe(false);
  });
});
