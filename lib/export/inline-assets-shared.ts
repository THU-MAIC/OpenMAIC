export interface InlineReport {
  inlined: string[];
  failed: { url: string; reason: string }[];
}

export interface InlineOptions {
  fetchImpl?: typeof fetch;
  maxAssetBytes?: number;
  fetcher?: FetchAsset;
}

export type FetchAsset = (
  url: string,
) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

/** Encode bytes as a data: URI. */
export function toDataUri(bytes: Uint8Array, contentType: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  const b64 = typeof btoa !== 'undefined' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return `data:${contentType};base64,${b64}`;
}
