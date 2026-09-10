import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAgentRuntimeConfigured,
  isAgentRuntimeEnabled,
  isEditorRendererEnabled,
  isMaicEditorEnabled,
  isPlaybackRendererEnabled,
  isPiChatEnabled,
  isPiNativeChildRuntimeEnabled,
  isPiNativeChildSpotlightEnabled,
  isPptxImportEnabled,
  isVideoExportEnabled,
  isVocationalTaskEngineEnabled,
  resolveVocationalActive,
  shouldShowVocationalTestUi,
} from '@/lib/config/feature-flags';

const FLAG = 'NEXT_PUBLIC_MAIC_EDITOR_ENABLED';

describe('agent runtime configuration predicate', () => {
  const ENV_KEYS = ['OPENMAIC_AGENT_RUNTIME_ENABLED', 'DATABASE_URL'] as const;
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originals.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    originals.clear();
  });

  it.each([
    ['the flag is off with no DATABASE_URL', undefined, undefined, false, false],
    ['the flag is off with DATABASE_URL set', undefined, 'postgres://runtime', false, false],
    ['the flag is on with no DATABASE_URL', 'true', undefined, true, false],
    ['the flag is on with a blank DATABASE_URL', 'true', '   ', true, false],
    ['the flag is on with DATABASE_URL set', 'true', 'postgres://runtime', true, true],
  ])(
    '%s: enabled = %s, configured = %s',
    (_case, runtimeFlag, databaseUrl, enabled, configured) => {
      if (runtimeFlag !== undefined) process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = runtimeFlag;
      if (databaseUrl !== undefined) process.env.DATABASE_URL = databaseUrl;

      expect(isAgentRuntimeEnabled()).toBe(enabled);
      expect(isAgentRuntimeConfigured()).toBe(configured);
    },
  );
});

describe('isMaicEditorEnabled', () => {
  const PRO_FLAG = 'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED';
  let original: string | undefined;
  let originalPro: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    originalPro = process.env[PRO_FLAG];
    delete process.env[PRO_FLAG];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = original;
    }
    if (originalPro === undefined) {
      delete process.env[PRO_FLAG];
    } else {
      process.env[PRO_FLAG] = originalPro;
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

  it('is implied by the Pro workbench flag when its own flag is unset', () => {
    delete process.env[FLAG];
    process.env[PRO_FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
  });

  it('stays on under the Pro workbench flag even with its own flag set false', () => {
    process.env[FLAG] = 'false';
    process.env[PRO_FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
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

describe('isEditorRendererEnabled', () => {
  const flag = 'NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED';
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
    expect(isEditorRendererEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isEditorRendererEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isEditorRendererEnabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env[flag] = 'false';
    expect(isEditorRendererEnabled()).toBe(false);

    process.env[flag] = 'yes';
    expect(isEditorRendererEnabled()).toBe(false);
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

describe.each([
  ['OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', isPiNativeChildRuntimeEnabled],
  ['OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT', isPiNativeChildSpotlightEnabled],
])('%s', (flag, readFlag) => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it('is default-off and accepts only the standard true values', () => {
    delete process.env[flag];
    expect(readFlag()).toBe(false);

    process.env[flag] = 'true';
    expect(readFlag()).toBe(true);
    process.env[flag] = '1';
    expect(readFlag()).toBe(true);
    process.env[flag] = 'yes';
    expect(readFlag()).toBe(false);
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
