/**
 * The grammar of a material id as `createMaterialId` (@openmaic/storage) mints
 * it: `mat_` plus 26 lowercase Crockford base32 characters (128 random bits).
 * Routes check caller-supplied ids against it before any query, so a
 * malformed id (a NUL byte, say) never reaches the database.
 */
const MATERIAL_ID_PATTERN = /^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

export function isMaterialId(value: string): boolean {
  return MATERIAL_ID_PATTERN.test(value);
}
