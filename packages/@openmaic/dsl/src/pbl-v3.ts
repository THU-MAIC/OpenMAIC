/** Portable project identity; learner state never belongs in this reference. */
export interface PBLV3Reference {
  id: string;
  version: string;
  /** Installed template asset, scoped by the classroom owner. */
  assetId?: string;
  checksum?: string;
  /** Archive-local binding, replaced with assetId/checksum on installation. */
  packageId?: string;
}

export const PBL_PROJECT_PACKAGE_CAPABILITY = 'pbl-v3-projects@1';

export interface PBLProjectPackageEntry {
  id: string;
  version: string;
  /** SHA-256 of the canonical entrypoint and sorted file index. */
  checksum: string;
  root: string;
  entrypoint: 'project.json';
  files: Record<string, { size: number; sha256: string }>;
}

/** First package version supports bounded UTF-8 course resources. */
export interface PBLProjectPackage {
  entry: PBLProjectPackageEntry;
  files: Record<string, string>;
}

export function isPBLV3Reference(value: unknown): value is PBLV3Reference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  return (
    typeof ref.id === 'string' &&
    /^[a-z0-9-]{1,80}$/.test(ref.id) &&
    typeof ref.version === 'string' &&
    /^[a-zA-Z0-9.-]{1,40}$/.test(ref.version) &&
    (ref.assetId === undefined
      ? ref.checksum === undefined
      : typeof ref.assetId === 'string' && ref.assetId.length > 0 && hash(ref.checksum)) &&
    (ref.packageId === undefined || (ref.assetId === undefined && hash(ref.packageId)))
  );
}
