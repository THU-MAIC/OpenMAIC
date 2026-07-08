/**
 * Network-quality detection for adapting behaviour on weak 3G/4G links.
 *
 * Reads the (Chromium-only) Network Information API plus the user's Save-Data
 * preference. It is intentionally conservative: when the API is unavailable
 * (Safari, Firefox desktop) we report `unknown` and DO NOT assume the link is
 * slow — features must degrade gracefully, never block, on missing data.
 *
 * The pure `deriveNetworkQuality` core is unit-tested in
 * `tests/utils/network-quality.test.ts`; `readNetworkQuality` is the thin
 * browser binding.
 */

export type EffectiveConnectionType = 'slow-2g' | '2g' | '3g' | '4g' | 'unknown';

export interface NetworkQuality {
  /** Browser's effective connection class, or 'unknown' if unavailable. */
  effectiveType: EffectiveConnectionType;
  /** User has explicitly asked to save data (Save-Data: on). */
  saveData: boolean;
  /** Positive evidence of a slow link (slow-2g / 2g / 3g). */
  isSlow: boolean;
  /** Conserve data: Save-Data is on, or the link is measurably slow. */
  isDataSaver: boolean;
  /** Whether the Network Information API was available to read. */
  supported: boolean;
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

function isEffectiveType(value: unknown): value is EffectiveConnectionType {
  return value === 'slow-2g' || value === '2g' || value === '3g' || value === '4g';
}

/**
 * Pure derivation of {@link NetworkQuality} from raw inputs — no browser
 * globals, so it can be unit-tested and reused server-side (e.g. from a
 * `Save-Data` request header, passing `{ saveData, supported: false }`).
 */
export function deriveNetworkQuality(input: {
  effectiveType?: string;
  saveData?: boolean;
  supported?: boolean;
}): NetworkQuality {
  const effectiveType = isEffectiveType(input.effectiveType) ? input.effectiveType : 'unknown';
  const saveData = input.saveData === true;
  const isSlow = effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g';
  return {
    effectiveType,
    saveData,
    isSlow,
    isDataSaver: saveData || isSlow,
    supported: input.supported ?? false,
  };
}

/** Access the Network Information API across vendor prefixes, if present. */
export function getConnection(): NetworkInformationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

/** Read the current network quality from the browser. */
export function readNetworkQuality(): NetworkQuality {
  const conn = getConnection();
  return deriveNetworkQuality({
    effectiveType: conn?.effectiveType,
    saveData: conn?.saveData,
    supported: !!conn,
  });
}
