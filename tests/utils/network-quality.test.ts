import { describe, expect, it } from 'vitest';

import { deriveNetworkQuality } from '@/lib/utils/network-quality';

describe('deriveNetworkQuality', () => {
  it('treats a 4g link as fast (no data-saver)', () => {
    const q = deriveNetworkQuality({ effectiveType: '4g', saveData: false, supported: true });
    expect(q).toMatchObject({
      effectiveType: '4g',
      isSlow: false,
      saveData: false,
      isDataSaver: false,
      supported: true,
    });
  });

  it('flags 3g / 2g / slow-2g as slow and data-saver', () => {
    for (const et of ['3g', '2g', 'slow-2g'] as const) {
      const q = deriveNetworkQuality({ effectiveType: et, supported: true });
      expect(q.isSlow).toBe(true);
      expect(q.isDataSaver).toBe(true);
    }
  });

  it('honours Save-Data even on a fast link', () => {
    const q = deriveNetworkQuality({ effectiveType: '4g', saveData: true, supported: true });
    expect(q.isSlow).toBe(false); // link itself is fast
    expect(q.saveData).toBe(true);
    expect(q.isDataSaver).toBe(true); // but the user asked to save data
  });

  it('does NOT assume slow when the API is unavailable (graceful default)', () => {
    const q = deriveNetworkQuality({});
    expect(q).toMatchObject({
      effectiveType: 'unknown',
      isSlow: false,
      saveData: false,
      isDataSaver: false,
      supported: false,
    });
  });

  it('coerces an unrecognised effectiveType to unknown', () => {
    const q = deriveNetworkQuality({ effectiveType: '5g', supported: true });
    expect(q.effectiveType).toBe('unknown');
    expect(q.isSlow).toBe(false);
  });
});
