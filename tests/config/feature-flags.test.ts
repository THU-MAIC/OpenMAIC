import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isAgentRuntimeConfigured,
  isAgentRuntimeEnabled,
  isEditorRendererEnabled,
  isCoursewareReferenceEnabled,
  isMaicEditorEnabled,
  isPlaybackRendererEnabled,
  isPiNativeChildRuntimeEnabled,
  isPiNativeChildSpotlightEnabled,
  isPptxImportEnabled,
  isVideoExportEnabled,
  isVocationalTaskEngineEnabled,
  isWorkbenchEnabled,
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
  const WORKBENCH_FLAG = 'NEXT_PUBLIC_WORKBENCH_ENABLED';
  const LEGACY_WORKBENCH_FLAG = 'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED';
  let original: string | undefined;
  let originalWorkbench: string | undefined;
  let originalLegacyWorkbench: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    originalWorkbench = process.env[WORKBENCH_FLAG];
    originalLegacyWorkbench = process.env[LEGACY_WORKBENCH_FLAG];
    delete process.env[WORKBENCH_FLAG];
    delete process.env[LEGACY_WORKBENCH_FLAG];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = original;
    }
    if (originalWorkbench === undefined) {
      delete process.env[WORKBENCH_FLAG];
    } else {
      process.env[WORKBENCH_FLAG] = originalWorkbench;
    }
    if (originalLegacyWorkbench === undefined) {
      delete process.env[LEGACY_WORKBENCH_FLAG];
    } else {
      process.env[LEGACY_WORKBENCH_FLAG] = originalLegacyWorkbench;
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

  it('is implied by the workbench flag when its own flag is unset', () => {
    delete process.env[FLAG];
    process.env[WORKBENCH_FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
  });

  it('stays on under the workbench flag even with its own flag set false', () => {
    process.env[FLAG] = 'false';
    process.env[WORKBENCH_FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
  });

  it('is implied by the previous workbench flag name', () => {
    delete process.env[FLAG];
    process.env[LEGACY_WORKBENCH_FLAG] = 'true';
    expect(isMaicEditorEnabled()).toBe(true);
  });
});

describe('isWorkbenchEnabled', () => {
  const WORKBENCH_FLAG = 'NEXT_PUBLIC_WORKBENCH_ENABLED';
  const LEGACY_WORKBENCH_FLAG = 'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED';
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of [WORKBENCH_FLAG, LEGACY_WORKBENCH_FLAG]) {
      originals.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of originals) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originals.clear();
  });

  it.each([
    ['both names are unset', undefined, undefined, false],
    ['only the new name is on', 'true', undefined, true],
    ['only the previous name is on', undefined, 'true', true],
    ['the previous name is on and the new name is blank', '', '1', true],
    ['the new name is off and the previous name is on', 'false', 'true', false],
    ['the new name is on and the previous name is off', '1', 'false', true],
  ])('when %s', (_case, workbench, legacyWorkbench, expected) => {
    if (workbench !== undefined) process.env[WORKBENCH_FLAG] = workbench;
    if (legacyWorkbench !== undefined) process.env[LEGACY_WORKBENCH_FLAG] = legacyWorkbench;
    expect(isWorkbenchEnabled()).toBe(expected);
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

describe('isCoursewareReferenceEnabled', () => {
  const flag = 'NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[flag];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  });

  it('defaults off when unset', () => {
    delete process.env[flag];
    expect(isCoursewareReferenceEnabled()).toBe(false);
  });

  it("returns true for 'true' and '1'", () => {
    process.env[flag] = 'true';
    expect(isCoursewareReferenceEnabled()).toBe(true);

    process.env[flag] = '1';
    expect(isCoursewareReferenceEnabled()).toBe(true);
  });

  it('returns false for other values', () => {
    process.env[flag] = 'false';
    expect(isCoursewareReferenceEnabled()).toBe(false);

    process.env[flag] = 'yes';
    expect(isCoursewareReferenceEnabled()).toBe(false);
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
