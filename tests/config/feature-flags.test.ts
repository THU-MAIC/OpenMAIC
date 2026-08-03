import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isMaicEditorEnabled,
  isPlaybackRendererEnabled,
  isPiChatEnabled,
  isPptxImportEnabled,
  isPiWebSearchEnabled,
  isVideoExportEnabled,
  isVocationalTaskEngineEnabled,
  resolveVocationalActive,
  shouldShowVocationalTestUi,
} from '@/lib/config/feature-flags';

const FLAG = 'NEXT_PUBLIC_MAIC_EDITOR_ENABLED';

describe('isMaicEditorEnabled', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = original;
    }
  });

  it('returns false when the env var is unset', () => {
    delete process.env[FLAG];
    expect(isMaicEditorEnabled()).toBe(false);
  });

  it("returns true for 'true'", () => {
    process.env[FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
  });

  it("returns true for '1'", () => {
    process.env[FLAG] = '1';
    expect(isMaicEditorEnabled()).toBe(true);
  });

  it("returns false for 'false'", () => {
    process.env[FLAG] = 'false';
    expect(isMaicEditorEnabled()).toBe(false);
  });

  it('returns false for an unrecognized string', () => {
    process.env[FLAG] = 'yes';
    expect(isMaicEditorEnabled()).toBe(false);
  });
});

describe('isPlaybackRendererEnabled', () => {
  const flag = 'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isPlaybackRendererEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isPlaybackRendererEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isPlaybackRendererEnabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env[flag] = 'false';
    expect(isPlaybackRendererEnabled()).toBe(false);

    process.env[flag] = 'yes';
    expect(isPlaybackRendererEnabled()).toBe(false);
  });
});

describe('isPiChatEnabled', () => {
  const flag = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isPiChatEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isPiChatEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isPiChatEnabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env[flag] = 'false';
    expect(isPiChatEnabled()).toBe(false);

    process.env[flag] = 'yes';
    expect(isPiChatEnabled()).toBe(false);
  });
});

describe('isPiWebSearchEnabled', () => {
  const flag = 'OPENMAIC_ENABLE_PI_WEB_SEARCH';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it('defaults off and accepts only the standard true values', () => {
    delete process.env[flag];
    expect(isPiWebSearchEnabled()).toBe(false);

    process.env[flag] = 'true';
    expect(isPiWebSearchEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isPiWebSearchEnabled()).toBe(true);

    process.env[flag] = 'yes';
    expect(isPiWebSearchEnabled()).toBe(false);
  });
});

describe('isVocationalTaskEngineEnabled', () => {
  const flag = 'OPENMAIC_ENABLE_VOCATIONAL';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isVocationalTaskEngineEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isVocationalTaskEngineEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isVocationalTaskEngineEnabled()).toBe(true);
  });

  it("returns false for 'false'", () => {
    process.env[flag] = 'false';
    expect(isVocationalTaskEngineEnabled()).toBe(false);
  });

  it('resolves active mode from both request intent and server flag', () => {
    process.env[flag] = 'true';
    expect(resolveVocationalActive({ taskEngineMode: true })).toBe(true);
    expect(resolveVocationalActive({ taskEngineMode: false })).toBe(false);
    expect(resolveVocationalActive(undefined)).toBe(false);

    process.env[flag] = 'false';
    expect(resolveVocationalActive({ taskEngineMode: true })).toBe(false);
  });
});

describe('shouldShowVocationalTestUi', () => {
  const flag = 'NEXT_PUBLIC_SHOW_VOCATIONAL_TEST_UI';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(shouldShowVocationalTestUi()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(shouldShowVocationalTestUi()).toBe(true);

    process.env[flag] = '1';
    expect(shouldShowVocationalTestUi()).toBe(true);
  });
});

describe('isVideoExportEnabled', () => {
  const flag = 'NEXT_PUBLIC_ENABLE_VIDEO_EXPORT';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[flag];
    } else {
      process.env[flag] = original;
    }
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isVideoExportEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isVideoExportEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isVideoExportEnabled()).toBe(true);
  });

  it("returns false for 'false' and unrecognized strings", () => {
    process.env[flag] = 'false';
    expect(isVideoExportEnabled()).toBe(false);

    process.env[flag] = 'yes';
    expect(isVideoExportEnabled()).toBe(false);
  });
});

describe('isPptxImportEnabled', () => {
  const flag = 'NEXT_PUBLIC_ENABLE_PPTX_IMPORT';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isPptxImportEnabled()).toBe(true);
    process.env[flag] = '1';
    expect(isPptxImportEnabled()).toBe(true);
  });

  it('returns false when unset or disabled', () => {
    delete process.env[flag];
    expect(isPptxImportEnabled()).toBe(false);
    process.env[flag] = 'false';
    expect(isPptxImportEnabled()).toBe(false);
  });
});
