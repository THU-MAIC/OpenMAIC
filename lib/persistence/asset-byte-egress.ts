/**
 * ASSET_BYTE_EGRESS: set to `redirect` to answer asset byte GETs with a 302 to
 * a short-lived signed URL, when the byte layer can sign (S3 can; the
 * PostgreSQL byte column cannot, and falls back to direct bytes). Anything
 * else, including unset and `direct`, keeps the default byte-for-byte
 * behavior. The tradeoff this opts into -- the redirect target names the
 * content hash -- is specified in the storage package's asset HTTP contract.
 *
 * Shared by the persistence route, which applies it, and boot validation,
 * which refuses it for a host byte store that cannot sign.
 */
export function configuredAssetByteEgress(value: string | undefined): 'redirect' | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === 'redirect') return 'redirect';
  if (raw === undefined || raw === '' || raw === 'direct') return undefined;
  console.warn(`ASSET_BYTE_EGRESS=${value} is not recognized; using direct byte egress`);
  return undefined;
}
