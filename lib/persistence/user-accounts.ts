/**
 * SSO user accounts and server-side sessions.
 *
 * The app's first real account table. Every SSO login upserts the vendor
 * profile keyed on the Eduku **userid** (the stable numeric vendor id) and
 * mints a `user_sessions` row; the httpOnly cookie carries only a signed
 * pointer (`sid`), so revoking a session (logout) is a row delete and the
 * Node routes re-check it per request.
 *
 * ## Role mapping
 *
 * The live accesstoken payload carries `usertype` (e.g. `"1"` = 学校管理员),
 * not the `role` field the original integration doc described:
 *
 *  - `usertype === '1'` → internal role `'0'` (admin) — may open the
 *    courseware-generation homepage;
 *  - any other usertype → internal role `'3'` (viewer) — may watch any
 *    courseware, and all interactions are recorded per account.
 *
 * `id` is an app-generated UUID — the vendor userid stays a unique attribute
 * rather than the primary key, so a future second SSO provider can link rows
 * without a migration.
 */

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { randomUUID } from 'crypto';

import { type EdukuUserRole } from '@/lib/config/sso';

export const USER_AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_accounts (
  id TEXT PRIMARY KEY,
  eduku_userid TEXT NOT NULL,
  eduku_openid TEXT,
  userno TEXT,
  username TEXT,
  nick TEXT,
  headimg TEXT,
  role TEXT NOT NULL,
  rolename TEXT,
  usertype TEXT,
  school_id TEXT,
  class_id TEXT,
  school_name TEXT,
  class_name TEXT,
  wx_unionid TEXT,
  update_phone_tag BOOLEAN NOT NULL DEFAULT false,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);

-- Databases created by the first revision of this feature have
-- eduku_openid TEXT NOT NULL UNIQUE and no vendor-userid column. The live
-- vendor payload carries userid (never an openid), so the old NOT NULL
-- constraint must go and the new identity column must land. The explicit
-- unique index (instead of an in-table UNIQUE) is the single uniqueness
-- authority for both fresh and migrated tables.
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS eduku_userid TEXT;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS usertype TEXT;
ALTER TABLE user_accounts ALTER COLUMN eduku_openid DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_accounts_eduku_userid_uniq
  ON user_accounts (eduku_userid);

CREATE INDEX IF NOT EXISTS user_accounts_role_idx ON user_accounts (role);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
  created_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL,
  last_seen_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions (expires_at);
`;

export async function ensureUserAuthSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(USER_AUTH_SCHEMA)) {
    await queryable.query(statement);
  }
}

export interface EdukuUserProfile {
  /** Stable vendor numeric user id — the upsert key. */
  edukuUserid: string;
  /** Absent in live payloads; kept for forward compatibility with the doc. */
  edukuOpenid?: string | null;
  userno?: string | null;
  username?: string | null;
  nick?: string | null;
  headimg?: string | null;
  /** Derived: `usertype === '1'` → `'0'` (admin), anything else → `'3'`. */
  role: EdukuUserRole;
  rolename?: string | null;
  /** Raw vendor usertype, preserved for analytics. */
  usertype?: string | null;
  schoolid?: number | string | null;
  classid?: number | string | null;
  schoolName?: string | null;
  className?: string | null;
  wxunionid?: string | null;
  updatephonetag?: boolean | null;
}

export interface UserAccountRow {
  id: string;
  edukuUserid: string;
  edukuOpenid: string | null;
  userno: string | null;
  username: string | null;
  nick: string | null;
  headimg: string | null;
  role: EdukuUserRole;
  rolename: string | null;
  usertype: string | null;
  schoolId: string | null;
  classId: string | null;
  schoolName: string | null;
  className: string | null;
  wxUnionid: string | null;
  updatePhoneTag: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UserSessionRow {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

interface RawUserAccountRow extends Record<string, unknown> {
  id: string;
  eduku_userid: string;
  eduku_openid: string | null;
  userno: string | null;
  username: string | null;
  nick: string | null;
  headimg: string | null;
  role: string;
  rolename: string | null;
  usertype: string | null;
  school_id: string | null;
  class_id: string | null;
  school_name: string | null;
  class_name: string | null;
  wx_unionid: string | null;
  update_phone_tag: boolean;
  created_at: number | string;
  updated_at: number | string;
}

interface RawUserSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  created_at: number | string;
  expires_at: number | string;
  last_seen_at: number | string;
}

interface RawUserSessionJoinRow extends RawUserSessionRow {
  account_id: string;
  account_created_at: number | string;
  account_updated_at: number | string;
}

const USER_ACCOUNT_COLUMNS = `id,
  eduku_userid,
  eduku_openid,
  userno,
  username,
  nick,
  headimg,
  role,
  rolename,
  usertype,
  school_id,
  class_id,
  school_name,
  class_name,
  wx_unionid,
  update_phone_tag,
  created_at,
  updated_at`;

function rowToAccount(row: RawUserAccountRow): UserAccountRow {
  return {
    id: row.id,
    edukuUserid: row.eduku_userid,
    edukuOpenid: row.eduku_openid,
    userno: row.userno,
    username: row.username,
    nick: row.nick,
    headimg: row.headimg,
    role: row.role as EdukuUserRole,
    rolename: row.rolename,
    usertype: row.usertype,
    schoolId: row.school_id,
    classId: row.class_id,
    schoolName: row.school_name,
    className: row.class_name,
    wxUnionid: row.wx_unionid,
    updatePhoneTag: row.update_phone_tag === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSession(row: RawUserSessionRow): UserSessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Vendor numeric ids (userid/institutionId/classid) arrive as JSON numbers. */
function optionalId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return optionalText(value);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = optionalText(value);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Normalize the live accesstoken payload into storable shape.
 *
 * The doc's profile fields (`edukuopenid`, `role`…) are not present in the
 * real response; the actual discriminator is `usertype`:
 *   `"1"` (学校管理员) → admin role `'0'`, everything else → viewer `'3'`.
 * `userid` is required — without it the account cannot be identified.
 */
export function normalizeEdukuProfile(raw: Record<string, unknown>): EdukuUserProfile | null {
  const edukuUserid = optionalId(raw.userid);
  if (!edukuUserid) return null;

  const usertype = optionalId(raw.usertype) ?? firstText(raw.usertype);
  const updatephonetag = raw.updatephonetag;

  return {
    edukuUserid,
    edukuOpenid: optionalText(raw.edukuopenid),
    userno: optionalText(raw.userno),
    username: firstText(raw.uname, raw.username),
    nick: firstText(raw.nick, raw.name),
    headimg: firstText(raw.headimg, raw.avatar),
    role: usertype === '1' ? '0' : '3',
    rolename: firstText(raw.rolename, raw.usertypename),
    usertype,
    schoolid: optionalId(raw.institutionId) ?? optionalId(raw.schoolid),
    classid: optionalId(raw.classid),
    schoolName: firstText(raw.schoolName, raw.institutionName, raw.schoolname),
    className: firstText(raw.className, raw.classname),
    wxunionid: optionalText(raw.wxunionid),
    updatephonetag: updatephonetag === true || updatephonetag === 'true',
  };
}

/**
 * Insert-or-update the account keyed on the vendor userid and return the
 * current row. Re-login refreshes profile fields (role included) in place.
 */
export async function upsertEdukuUser(
  queryable: Queryable,
  profile: EdukuUserProfile,
): Promise<UserAccountRow> {
  const now = Date.now();
  const id = randomUUID();
  const result = await queryable.query<RawUserAccountRow>(
    `INSERT INTO user_accounts
       (id, eduku_userid, eduku_openid, userno, username, nick, headimg, role,
        rolename, usertype, school_id, class_id, school_name, class_name,
        wx_unionid, update_phone_tag, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $17)
     ON CONFLICT (eduku_userid) DO UPDATE SET
       eduku_openid = EXCLUDED.eduku_openid,
       userno = EXCLUDED.userno,
       username = EXCLUDED.username,
       nick = EXCLUDED.nick,
       headimg = EXCLUDED.headimg,
       role = EXCLUDED.role,
       rolename = EXCLUDED.rolename,
       usertype = EXCLUDED.usertype,
       school_id = EXCLUDED.school_id,
       class_id = EXCLUDED.class_id,
       school_name = EXCLUDED.school_name,
       class_name = EXCLUDED.class_name,
       wx_unionid = EXCLUDED.wx_unionid,
       update_phone_tag = EXCLUDED.update_phone_tag,
       updated_at = EXCLUDED.updated_at
     RETURNING ${USER_ACCOUNT_COLUMNS}`,
    [
      id,
      profile.edukuUserid,
      profile.edukuOpenid ?? null,
      profile.userno ?? null,
      profile.username ?? null,
      profile.nick ?? null,
      profile.headimg ?? null,
      profile.role,
      profile.rolename ?? null,
      profile.usertype ?? null,
      profile.schoolid ?? null,
      profile.classid ?? null,
      profile.schoolName ?? null,
      profile.className ?? null,
      profile.wxunionid ?? null,
      profile.updatephonetag === true,
      now,
    ],
  );
  return rowToAccount(result.rows[0]);
}

export async function getUserAccountById(
  queryable: Queryable,
  id: string,
): Promise<UserAccountRow | null> {
  const result = await queryable.query<RawUserAccountRow>(
    `SELECT ${USER_ACCOUNT_COLUMNS} FROM user_accounts WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? rowToAccount(row) : null;
}

export async function getUserAccountByEdukuOpenid(
  queryable: Queryable,
  edukuOpenid: string,
): Promise<UserAccountRow | null> {
  const result = await queryable.query<RawUserAccountRow>(
    `SELECT ${USER_ACCOUNT_COLUMNS} FROM user_accounts WHERE eduku_openid = $1`,
    [edukuOpenid],
  );
  const row = result.rows[0];
  return row ? rowToAccount(row) : null;
}

/** Mint a session row. The caller signs the cookie with the returned id. */
export async function createUserSession(
  queryable: Queryable,
  userId: string,
  ttlMs: number,
): Promise<UserSessionRow> {
  const now = Date.now();
  const result = await queryable.query<RawUserSessionRow>(
    `INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $3)
     RETURNING id, user_id, created_at, expires_at, last_seen_at`,
    [randomUUID(), userId, now, now + ttlMs],
  );
  return rowToSession(result.rows[0]);
}

export interface UserSessionWithUser {
  session: UserSessionRow;
  user: UserAccountRow;
}

/** Load a live session together with its account; expired rows answer null. */
export async function findLiveUserSession(
  queryable: Queryable,
  sessionId: string,
  now = Date.now(),
): Promise<UserSessionWithUser | null> {
  const result = await queryable.query<RawUserSessionJoinRow & RawUserAccountRow>(
    `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at,
            u.id AS account_id,
            u.eduku_userid,
            u.eduku_openid,
            u.userno,
            u.username,
            u.nick,
            u.headimg,
            u.role,
            u.rolename,
            u.usertype,
            u.school_id,
            u.class_id,
            u.school_name,
            u.class_name,
            u.wx_unionid,
            u.update_phone_tag,
            u.created_at AS account_created_at,
            u.updated_at AS account_updated_at
       FROM user_sessions s
       JOIN user_accounts u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > $2`,
    [sessionId, now],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    session: rowToSession(row),
    user: rowToAccount({
      ...row,
      id: row.account_id,
      created_at: row.account_created_at,
      updated_at: row.account_updated_at,
    }),
  };
}

/** Opportunistic last-activity bump; never fails a request. */
export async function touchUserSession(
  queryable: Queryable,
  sessionId: string,
  now = Date.now(),
): Promise<void> {
  await queryable.query(
    `UPDATE user_sessions SET last_seen_at = $2 WHERE id = $1 AND expires_at > $2`,
    [sessionId, now],
  );
}

export async function revokeUserSession(queryable: Queryable, sessionId: string): Promise<void> {
  await queryable.query(`DELETE FROM user_sessions WHERE id = $1`, [sessionId]);
}

export async function deleteExpiredUserSessions(
  queryable: Queryable,
  now = Date.now(),
): Promise<number> {
  const result = await queryable.query<{ count: number | string }>(
    `WITH deleted AS (DELETE FROM user_sessions WHERE expires_at <= $1 RETURNING 1)
     SELECT COUNT(*)::text AS count FROM deleted`,
    [now],
  );
  return Number(result.rows[0]?.count ?? 0);
}
