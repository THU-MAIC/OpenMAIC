/**
 * Frozen schema snapshots: the DDL each earlier line provisioned at startup,
 * copied verbatim from its sources at the commits named below, from before
 * schema versions were recorded. Generated once; never edit a snapshot to
 * match current code -- that would defeat the upgrade tests built on them.
 *
 * Each snapshot lists its stores' scripts in that line's bootstrap order. The
 * statements a start ran every time are part of the scripts (v1.1.2's
 * ownership INSERT is in its `stage_meta` script); the later lines ran their
 * ownership adoption from code, which a fixture without legacy rows never
 * needs.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

/** v1.1.2 */
export const RELEASE_1_1_2_SCHEMA: readonly (readonly [store: string, sql: string])[] = [
  [
    'runtime',
    `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`,
  ],
  [
    'document',
    `
CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS folder_order DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS document_folders_owner_order_idx
  ON document_folders (owner_id, folder_order, id);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  owner_id TEXT,
  folder_id TEXT,
  data JSONB NOT NULL
);

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS folder_id TEXT;

CREATE INDEX IF NOT EXISTS document_stages_owner_idx
  ON document_stages (owner_id, id) WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_stages_owner_folder_idx
  ON document_stages (owner_id, folder_id, id)
  WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);

-- Per-scene monotonic revision signal, at the DB layer (ported from the
-- reference implementation's migration 0071).
--
-- WHY THE DB LAYER: course content has several write seams that share no
-- application-level signal (HTTP routes, agent tools, jobs, migration
-- scripts, manual psql). Only a trigger can make "wrote but never signaled"
-- unexpressible. These companion tables and triggers keep a monotonic
-- per-stage revision and a per-scene revision on every insert/update/delete
-- of document_stages / document_scenes. Companion tables instead of columns
-- keep the document tables' authoritative DDL untouched.
--
-- LOCK ORDER INVARIANT: the scene trigger bumps document_stage_revision (SR)
-- BEFORE document_scene_revision (SCR) — the same order saveDocument uses
-- (stage upsert first, then per-scene upserts). Any future code that writes
-- these two companion tables must take SR before SCR, or the deadlock (40P01)
-- between concurrent stage-first and scene-first writers comes back.
--
-- NOTIFY: each bump emits a JSON route {kind:'stage',stageId} on the
-- agent-event wakeup channel (the same channel the reference's agent event
-- notify bus LISTENs on), so a stage notification wakes exactly the
-- subscribers listening for that stage. The payload is built with
-- json_build_object — never hand-concatenated, because a stageId containing
-- quotes or backslashes would yield invalid JSON.
--
-- NOTIFY SUPPRESSION SWITCH: both triggers check
-- current_setting('openmaic.suppress_stage_notify', true) before pg_notify.
-- Batch/backfill writers MUST run SET LOCAL openmaic.suppress_stage_notify =
-- 'on' inside each batch transaction: the revision still bumps, only the
-- notification is skipped. NOTE: SET LOCAL outside a transaction block only
-- emits a warning and has NO effect.
--
-- TRUNCATE DOES NOT FIRE ROW TRIGGERS: a TRUNCATE reset of document_scenes /
-- document_stages leaves the companion revision rows behind, so any TRUNCATE
-- reset must also truncate document_scene_revision and
-- document_stage_revision.
--
-- IDEMPOTENT BY CONSTRUCTION: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS — replayable in any environment.

CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id TEXT PRIMARY KEY NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL,
  CONSTRAINT document_scene_revision_pkey PRIMARY KEY (stage_id, scene_id)
);

CREATE OR REPLACE FUNCTION openmaic_bump_scene_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
  v_scene_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.stage_id;
    v_scene_id := OLD.id;
  ELSE
    v_stage_id := NEW.stage_id;
    v_scene_id := NEW.id;
  END IF;
  -- LOCK ORDER INVARIANT: SR row BEFORE the SCR row (see the header comment).
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  INSERT INTO document_scene_revision (stage_id, scene_id, rev)
  VALUES (v_stage_id, v_scene_id, 1)
  ON CONFLICT (stage_id, scene_id) DO UPDATE SET rev = document_scene_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION openmaic_bump_stage_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.id;
  ELSE
    v_stage_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes;

CREATE TRIGGER openmaic_scene_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_scenes
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_scene_revision();

DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages;

CREATE TRIGGER openmaic_stage_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_stages
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_stage_revision();
`,
  ],
  [
    'stage-meta',
    `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);

CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;

INSERT INTO stage_meta (stage_id, owner_id)
SELECT id, owner_id
  FROM document_stages
 WHERE owner_id IS NOT NULL
ON CONFLICT (stage_id) DO NOTHING;
`,
  ],
  [
    'owner-material',
    `
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  oss_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);

-- Databases created before the byte-store model have this table without
-- oss_key (they tracked an asset id instead); CREATE TABLE IF NOT EXISTS
-- leaves such tables untouched, so the column must be added here. The ''
-- default is the existing "no bytes recorded" sentinel the stale-upload
-- sweeper already understands. The old NOT NULL asset_id column must also
-- go, or its constraint rejects every insert of the new row shape.
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS oss_key TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_material DROP COLUMN IF EXISTS asset_id;
`,
  ],
  [
    'asset',
    [
      `CREATE TABLE IF NOT EXISTS asset_blobs (
     content_hash TEXT PRIMARY KEY,
     byte_size BIGINT NOT NULL,
     bytes BYTEA,
     unreferenced_at TIMESTAMPTZ
   )`,
      `CREATE TABLE IF NOT EXISTS asset_entries (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
     mime TEXT NOT NULL,
     meta JSONB NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created_at DOUBLE PRECISION NOT NULL
   )`,
      `CREATE INDEX IF NOT EXISTS asset_entries_principal_idx
     ON asset_entries (principal, id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_content_hash_idx
     ON asset_entries (content_hash)`,
      `CREATE INDEX IF NOT EXISTS asset_blobs_unreferenced_idx
     ON asset_blobs (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS unreferenced_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS document_asset_refs (
     stage_id TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('stage', 'scene')),
     scene_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE CASCADE,
     PRIMARY KEY (stage_id, scope, scene_id, asset_id)
   )`,
      `CREATE INDEX IF NOT EXISTS document_asset_refs_asset_idx
     ON document_asset_refs (asset_id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_expires_idx
     ON asset_entries (expires_at) WHERE expires_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_unreferenced_idx
     ON asset_entries (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_legacy_idx
     ON asset_entries (id) WHERE committed_at IS NULL AND expires_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS asset_reference_tracking (
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     enabled_at TIMESTAMPTZ NOT NULL
   )`,
      `CREATE TABLE IF NOT EXISTS document_asset_withdrawals (
     stage_id TEXT NOT NULL PRIMARY KEY,
     withdrawn_at TIMESTAMPTZ NOT NULL
   )`,
    ].join(';\n'),
  ],
  [
    'agent-session',
    `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  title               TEXT,
  title_state         TEXT NOT NULL DEFAULT 'manual',
  stage_id            TEXT NOT NULL,
  active_stage_id     TEXT,
  skill_id            TEXT,
  origin              TEXT,
  existing_course     BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempt             INTEGER NOT NULL DEFAULT 0,
  delivered_user_message_seq INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_worker_pid    INTEGER,
  lease_heartbeat_at  BIGINT,
  cancel_requested_at BIGINT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT agent_sessions_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT agent_sessions_title_state_known
    CHECK (title_state IN ('pending','automatic','manual')),
  CONSTRAINT agent_sessions_status_known
    CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
);

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS delivered_user_message_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title TEXT;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title_state TEXT NOT NULL DEFAULT 'manual';

DO $agent_session_title_state_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
  ) THEN
    LOCK TABLE agent_sessions IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_sessions'::regclass
        AND conname = 'agent_sessions_title_state_known'
    ) THEN
      ALTER TABLE agent_sessions
        ADD CONSTRAINT agent_sessions_title_state_known
        CHECK (title_state IN ('pending','automatic','manual'))
        NOT VALID;
    END IF;
  END IF;
END
$agent_session_title_state_constraint$;

DO $agent_session_title_state_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_sessions
      VALIDATE CONSTRAINT agent_sessions_title_state_known;
  END IF;
END
$agent_session_title_state_validation$;

CREATE INDEX IF NOT EXISTS agent_sessions_status_live_idx
  ON agent_sessions (status, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_sessions_owner_live_idx
  ON agent_sessions (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         BIGINT NOT NULL,
  attempt    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_session_entries (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  attempt    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_entries_entry_id_unique UNIQUE (session_id, entry_id),
  CONSTRAINT agent_session_entries_parent_fk
    FOREIGN KEY (session_id, parent_id)
    REFERENCES agent_session_entries (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS agent_session_entries_type_idx
  ON agent_session_entries (session_id, type, seq);

CREATE TABLE IF NOT EXISTS agent_owner_session_event_counters (
  owner_id TEXT PRIMARY KEY,
  n        BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT agent_owner_session_event_counters_nonnegative CHECK (n >= 0)
);

CREATE TABLE IF NOT EXISTS agent_owner_session_events (
  owner_id   TEXT NOT NULL,
  id         BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT,
  attempt    INTEGER,
  data       JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
    ('session_created','session_status','session_deleted',
     'session_active_stage','session_cancel_requested','session_title')),
  CONSTRAINT agent_owner_session_events_status_known CHECK (status IS NULL OR status IN
    ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT agent_owner_session_events_attempt_nonnegative
    CHECK (attempt IS NULL OR attempt >= 0)
);

DO $agent_session_owner_event_type_constraint$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known'::name
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
  ) THEN
    LOCK TABLE agent_owner_session_events IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known_v2'
    ) THEN
      ALTER TABLE agent_owner_session_events
        ADD CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
          ('session_created','session_status','session_deleted',
           'session_active_stage','session_cancel_requested','session_title'))
        NOT VALID;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known'::name
    ) THEN
      ALTER TABLE agent_owner_session_events
        DROP CONSTRAINT agent_owner_session_events_type_known;
    END IF;
  END IF;
END
$agent_session_owner_event_type_constraint$;

-- Installing the superset above is a catalog-only operation while the short
-- ACCESS EXCLUSIVE lock is held. Validate separately so PostgreSQL scans an
-- existing projection table under VALIDATE CONSTRAINT's weaker lock instead.
-- Once validated, later initializers avoid taking that table lock altogether.
DO $agent_session_owner_event_type_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_owner_session_events
      VALIDATE CONSTRAINT agent_owner_session_events_type_known_v2;
  END IF;
END
$agent_session_owner_event_type_validation$;

CREATE TABLE IF NOT EXISTS agent_session_urls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url),
  CONSTRAINT agent_session_urls_source_known CHECK (source IN ('user','web_search'))
);

CREATE INDEX IF NOT EXISTS agent_session_urls_session_created_idx
  ON agent_session_urls (session_id, created_at);
`,
  ],
  [
    'agent-session-material',
    `
CREATE TABLE IF NOT EXISTS agent_session_materials (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT,
  owner_material_id TEXT,
  source_url    TEXT,
  text_asset_id TEXT,
  raw_asset_id  TEXT,
  text_chars    INTEGER NOT NULL DEFAULT 0,
  derived_from  TEXT REFERENCES agent_session_materials(id) ON DELETE CASCADE,
  extraction_status TEXT NOT NULL DEFAULT 'done',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  extraction_stats JSONB,
  extractor_version TEXT,
  extraction_lease_worker_id TEXT,
  extraction_lease_worker_pid INTEGER,
  extraction_lease_heartbeat_at BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_materials_kind_known CHECK (kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_materials_text_chars_nonnegative CHECK (text_chars >= 0)
  ,CONSTRAINT agent_session_materials_extraction_status_known CHECK (extraction_status IN
    ('idle','pending','running','done','failed'))
  ,CONSTRAINT agent_session_materials_extraction_attempts_nonnegative CHECK (extraction_attempts >= 0)
);

ALTER TABLE agent_session_materials ADD COLUMN IF NOT EXISTS owner_material_id TEXT;

CREATE INDEX IF NOT EXISTS agent_session_materials_session_created_idx
  ON agent_session_materials (session_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_session_materials_session_owner_material_idx
  ON agent_session_materials (session_id, owner_material_id)
  WHERE owner_material_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_session_materials_extraction_queue_idx
  ON agent_session_materials (created_at)
  WHERE kind = 'source' AND extraction_status IN ('pending','running');
`,
  ],
  [
    'user-skill',
    `
CREATE TABLE IF NOT EXISTS agent_user_skill (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT agent_user_skill_version_check CHECK (version = 1),
  CONSTRAINT agent_user_skill_name_check
    CHECK (name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(name) <= 64),
  CONSTRAINT agent_user_skill_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT agent_user_skill_description_check
    CHECK (length(description) BETWEEN 1 AND 500 AND description !~ '[\r\n]'),
  CONSTRAINT agent_user_skill_content_check CHECK (octet_length(content) BETWEEN 1 AND 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_user_skill_owner_name_unique
  ON agent_user_skill (owner_id, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_user_skill_owner
  ON agent_user_skill (owner_id, created_at) WHERE deleted_at IS NULL;
`,
  ],
];

/** main @ 1635b168 */
export const MAIN_SCHEMA: readonly (readonly [store: string, sql: string])[] = [
  [
    'runtime',
    `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`,
  ],
  [
    'document',
    `
CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS folder_order DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS document_folders_owner_order_idx
  ON document_folders (owner_id, folder_order, id);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  folder_id TEXT,
  data JSONB NOT NULL
);

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS folder_id TEXT;

-- Document ownership is not recorded here: a host keeps it in its own
-- relation (see DocumentOwnershipRelation). An installation created before
-- that keeps its owner_id column for one release -- so a rollback still finds
-- it, and a host can copy it into its relation first -- but nothing reads or
-- writes it any more, and the next release drops it. A NOT NULL or a default
-- a host added to it would fail or mislabel every new document, so both are
-- relaxed. The catalog is asked first, and each ALTER runs only when it has
-- something to change: an ALTER naming a column that is not there is an error,
-- and one with nothing to change would still take an exclusive table lock on
-- every boot. The indexes below served only the column.
DO $document_stages_owner_retirement$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = to_regclass('document_stages')
       AND attname = 'owner_id'
       AND NOT attisdropped
       AND attnotnull
  ) THEN
    ALTER TABLE document_stages ALTER COLUMN owner_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = to_regclass('document_stages')
       AND attname = 'owner_id'
       AND NOT attisdropped
       AND atthasdef
  ) THEN
    ALTER TABLE document_stages ALTER COLUMN owner_id DROP DEFAULT;
  END IF;
END
$document_stages_owner_retirement$;

DROP INDEX IF EXISTS document_stages_owner_idx;

DROP INDEX IF EXISTS document_stages_owner_folder_idx;

CREATE INDEX IF NOT EXISTS document_stages_folder_idx
  ON document_stages (folder_id, id) WHERE folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);

-- Per-scene monotonic revision signal, at the DB layer (ported from the
-- reference implementation's migration 0071).
--
-- WHY THE DB LAYER: course content has several write seams that share no
-- application-level signal (HTTP routes, agent tools, jobs, migration
-- scripts, manual psql). Only a trigger can make "wrote but never signaled"
-- unexpressible. These companion tables and triggers keep a monotonic
-- per-stage revision and a per-scene revision on every insert/update/delete
-- of document_stages / document_scenes. Companion tables instead of columns
-- keep the document tables' authoritative DDL untouched.
--
-- LOCK ORDER INVARIANT: the scene trigger bumps document_stage_revision (SR)
-- BEFORE document_scene_revision (SCR) — the same order saveDocument uses
-- (stage upsert first, then per-scene upserts). Any future code that writes
-- these two companion tables must take SR before SCR, or the deadlock (40P01)
-- between concurrent stage-first and scene-first writers comes back.
--
-- NOTIFY: each bump emits a JSON route {kind:'stage',stageId} on the
-- agent-event wakeup channel (the same channel the reference's agent event
-- notify bus LISTENs on), so a stage notification wakes exactly the
-- subscribers listening for that stage. The payload is built with
-- json_build_object — never hand-concatenated, because a stageId containing
-- quotes or backslashes would yield invalid JSON.
--
-- NOTIFY SUPPRESSION SWITCH: both triggers check
-- current_setting('openmaic.suppress_stage_notify', true) before pg_notify.
-- Batch/backfill writers MUST run SET LOCAL openmaic.suppress_stage_notify =
-- 'on' inside each batch transaction: the revision still bumps, only the
-- notification is skipped. NOTE: SET LOCAL outside a transaction block only
-- emits a warning and has NO effect.
--
-- TRUNCATE DOES NOT FIRE ROW TRIGGERS: a TRUNCATE reset of document_scenes /
-- document_stages leaves the companion revision rows behind, so any TRUNCATE
-- reset must also truncate document_scene_revision and
-- document_stage_revision.
--
-- IDEMPOTENT BY CONSTRUCTION: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS — replayable in any environment.

CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id TEXT PRIMARY KEY NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL,
  CONSTRAINT document_scene_revision_pkey PRIMARY KEY (stage_id, scene_id)
);

CREATE OR REPLACE FUNCTION openmaic_bump_scene_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
  v_scene_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.stage_id;
    v_scene_id := OLD.id;
  ELSE
    v_stage_id := NEW.stage_id;
    v_scene_id := NEW.id;
  END IF;
  -- LOCK ORDER INVARIANT: SR row BEFORE the SCR row (see the header comment).
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  INSERT INTO document_scene_revision (stage_id, scene_id, rev)
  VALUES (v_stage_id, v_scene_id, 1)
  ON CONFLICT (stage_id, scene_id) DO UPDATE SET rev = document_scene_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION openmaic_bump_stage_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.id;
  ELSE
    v_stage_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes;

CREATE TRIGGER openmaic_scene_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_scenes
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_scene_revision();

DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages;

CREATE TRIGGER openmaic_stage_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_stages
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_stage_revision();
`,
  ],
  [
    'stage-meta',
    `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);

CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;
`,
  ],
  [
    'owner-merges',
    `
CREATE TABLE IF NOT EXISTS owner_merges (
  from_owner_id TEXT PRIMARY KEY,
  to_owner_id TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_assurance TEXT,
  moved JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT owner_merges_distinct CHECK (from_owner_id <> to_owner_id)
);

CREATE INDEX IF NOT EXISTS owner_merges_to_idx ON owner_merges (to_owner_id);
`,
  ],
  [
    'legacy-import-bindings',
    `
CREATE TABLE IF NOT EXISTS legacy_import_bindings (
  browser_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_import_bindings_owner_idx
  ON legacy_import_bindings (owner_id);
`,
  ],
  [
    'owner-material',
    `
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  oss_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);

-- Databases created before the byte-store model have this table without
-- oss_key (they tracked an asset id instead); CREATE TABLE IF NOT EXISTS
-- leaves such tables untouched, so the column must be added here. The ''
-- default is the existing "no bytes recorded" sentinel the stale-upload
-- sweeper already understands. The old NOT NULL asset_id column must also
-- go, or its constraint rejects every insert of the new row shape.
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS oss_key TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_material DROP COLUMN IF EXISTS asset_id;
`,
  ],
  [
    'asset',
    [
      `CREATE TABLE IF NOT EXISTS asset_blobs (
     content_hash TEXT PRIMARY KEY,
     byte_size BIGINT NOT NULL,
     bytes BYTEA,
     unreferenced_at TIMESTAMPTZ
   )`,
      `CREATE TABLE IF NOT EXISTS asset_entries (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
     mime TEXT NOT NULL,
     meta JSONB NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created_at DOUBLE PRECISION NOT NULL
   )`,
      `CREATE INDEX IF NOT EXISTS asset_entries_principal_idx
     ON asset_entries (principal, id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_content_hash_idx
     ON asset_entries (content_hash)`,
      `CREATE INDEX IF NOT EXISTS asset_blobs_unreferenced_idx
     ON asset_blobs (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS unreferenced_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS document_asset_refs (
     stage_id TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('stage', 'scene')),
     scene_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE CASCADE,
     PRIMARY KEY (stage_id, scope, scene_id, asset_id)
   )`,
      `CREATE INDEX IF NOT EXISTS document_asset_refs_asset_idx
     ON document_asset_refs (asset_id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_expires_idx
     ON asset_entries (expires_at) WHERE expires_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_unreferenced_idx
     ON asset_entries (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_legacy_idx
     ON asset_entries (id) WHERE committed_at IS NULL AND expires_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS asset_reference_tracking (
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     enabled_at TIMESTAMPTZ NOT NULL
   )`,
      `CREATE TABLE IF NOT EXISTS document_asset_withdrawals (
     stage_id TEXT NOT NULL PRIMARY KEY,
     withdrawn_at TIMESTAMPTZ NOT NULL
   )`,
    ].join(';\n'),
  ],
  [
    'agent-session',
    `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  title               TEXT,
  title_state         TEXT NOT NULL DEFAULT 'manual',
  stage_id            TEXT NOT NULL,
  active_stage_id     TEXT,
  skill_id            TEXT,
  origin              TEXT,
  existing_course     BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempt             INTEGER NOT NULL DEFAULT 0,
  delivered_user_message_seq INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_worker_pid    INTEGER,
  lease_heartbeat_at  BIGINT,
  cancel_requested_at BIGINT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT agent_sessions_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT agent_sessions_title_state_known
    CHECK (title_state IN ('pending','automatic','manual')),
  CONSTRAINT agent_sessions_status_known
    CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
);

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS delivered_user_message_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title TEXT;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title_state TEXT NOT NULL DEFAULT 'manual';

DO $agent_session_title_state_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
  ) THEN
    LOCK TABLE agent_sessions IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_sessions'::regclass
        AND conname = 'agent_sessions_title_state_known'
    ) THEN
      ALTER TABLE agent_sessions
        ADD CONSTRAINT agent_sessions_title_state_known
        CHECK (title_state IN ('pending','automatic','manual'))
        NOT VALID;
    END IF;
  END IF;
END
$agent_session_title_state_constraint$;

DO $agent_session_title_state_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_sessions
      VALIDATE CONSTRAINT agent_sessions_title_state_known;
  END IF;
END
$agent_session_title_state_validation$;

CREATE INDEX IF NOT EXISTS agent_sessions_status_live_idx
  ON agent_sessions (status, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_sessions_owner_live_idx
  ON agent_sessions (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         BIGINT NOT NULL,
  attempt    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_session_entries (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  attempt    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_entries_entry_id_unique UNIQUE (session_id, entry_id),
  CONSTRAINT agent_session_entries_parent_fk
    FOREIGN KEY (session_id, parent_id)
    REFERENCES agent_session_entries (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS agent_session_entries_type_idx
  ON agent_session_entries (session_id, type, seq);

CREATE TABLE IF NOT EXISTS agent_owner_session_event_counters (
  owner_id TEXT PRIMARY KEY,
  n        BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT agent_owner_session_event_counters_nonnegative CHECK (n >= 0)
);

CREATE TABLE IF NOT EXISTS agent_owner_session_events (
  owner_id   TEXT NOT NULL,
  id         BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT,
  attempt    INTEGER,
  data       JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
    ('session_created','session_status','session_deleted',
     'session_active_stage','session_cancel_requested','session_title')),
  CONSTRAINT agent_owner_session_events_status_known CHECK (status IS NULL OR status IN
    ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT agent_owner_session_events_attempt_nonnegative
    CHECK (attempt IS NULL OR attempt >= 0)
);

DO $agent_session_owner_event_type_constraint$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known'::name
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
  ) THEN
    LOCK TABLE agent_owner_session_events IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known_v2'
    ) THEN
      ALTER TABLE agent_owner_session_events
        ADD CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
          ('session_created','session_status','session_deleted',
           'session_active_stage','session_cancel_requested','session_title'))
        NOT VALID;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known'::name
    ) THEN
      ALTER TABLE agent_owner_session_events
        DROP CONSTRAINT agent_owner_session_events_type_known;
    END IF;
  END IF;
END
$agent_session_owner_event_type_constraint$;

-- Installing the superset above is a catalog-only operation while the short
-- ACCESS EXCLUSIVE lock is held. Validate separately so PostgreSQL scans an
-- existing projection table under VALIDATE CONSTRAINT's weaker lock instead.
-- Once validated, later initializers avoid taking that table lock altogether.
DO $agent_session_owner_event_type_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_owner_session_events
      VALIDATE CONSTRAINT agent_owner_session_events_type_known_v2;
  END IF;
END
$agent_session_owner_event_type_validation$;

CREATE TABLE IF NOT EXISTS agent_session_urls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url),
  CONSTRAINT agent_session_urls_source_known CHECK (source IN ('user','web_search'))
);

CREATE INDEX IF NOT EXISTS agent_session_urls_session_created_idx
  ON agent_session_urls (session_id, created_at);
`,
  ],
  [
    'agent-session-material',
    `
CREATE TABLE IF NOT EXISTS agent_session_materials (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT,
  owner_material_id TEXT,
  source_url    TEXT,
  text_asset_id TEXT,
  raw_asset_id  TEXT,
  text_chars    INTEGER NOT NULL DEFAULT 0,
  derived_from  TEXT REFERENCES agent_session_materials(id) ON DELETE CASCADE,
  extraction_status TEXT NOT NULL DEFAULT 'done',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  extraction_stats JSONB,
  extractor_version TEXT,
  extraction_lease_worker_id TEXT,
  extraction_lease_worker_pid INTEGER,
  extraction_lease_heartbeat_at BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_materials_kind_known CHECK (kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_materials_text_chars_nonnegative CHECK (text_chars >= 0)
  ,CONSTRAINT agent_session_materials_extraction_status_known CHECK (extraction_status IN
    ('idle','pending','running','done','failed'))
  ,CONSTRAINT agent_session_materials_extraction_attempts_nonnegative CHECK (extraction_attempts >= 0)
);

ALTER TABLE agent_session_materials ADD COLUMN IF NOT EXISTS owner_material_id TEXT;

CREATE INDEX IF NOT EXISTS agent_session_materials_session_created_idx
  ON agent_session_materials (session_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_session_materials_session_owner_material_idx
  ON agent_session_materials (session_id, owner_material_id)
  WHERE owner_material_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_session_materials_extraction_queue_idx
  ON agent_session_materials (created_at)
  WHERE kind = 'source' AND extraction_status IN ('pending','running');
`,
  ],
  [
    'user-skill',
    `
CREATE TABLE IF NOT EXISTS agent_user_skill (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT agent_user_skill_version_check CHECK (version = 1),
  CONSTRAINT agent_user_skill_name_check
    CHECK (name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(name) <= 64),
  CONSTRAINT agent_user_skill_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT agent_user_skill_description_check
    CHECK (length(description) BETWEEN 1 AND 500 AND description !~ '[\r\n]'),
  CONSTRAINT agent_user_skill_content_check CHECK (octet_length(content) BETWEEN 1 AND 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_user_skill_owner_name_unique
  ON agent_user_skill (owner_id, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_user_skill_owner
  ON agent_user_skill (owner_id, created_at) WHERE deleted_at IS NULL;
`,
  ],
];

/** integration/provider-config @ 20535902 */
export const PROVIDER_CONFIG_SCHEMA: readonly (readonly [store: string, sql: string])[] = [
  [
    'runtime',
    `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`,
  ],
  [
    'document',
    `
CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

ALTER TABLE document_folders
  ADD COLUMN IF NOT EXISTS folder_order DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS document_folders_owner_order_idx
  ON document_folders (owner_id, folder_order, id);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  folder_id TEXT,
  data JSONB NOT NULL
);

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS folder_id TEXT;

-- Document ownership is not recorded here: a host keeps it in its own
-- relation (see DocumentOwnershipRelation). An installation created before
-- that keeps its owner_id column for one release -- so a rollback still finds
-- it, and a host can copy it into its relation first -- but nothing reads or
-- writes it any more, and the next release drops it. A NOT NULL or a default
-- a host added to it would fail or mislabel every new document, so both are
-- relaxed. The catalog is asked first, and each ALTER runs only when it has
-- something to change: an ALTER naming a column that is not there is an error,
-- and one with nothing to change would still take an exclusive table lock on
-- every boot. The indexes below served only the column.
DO $document_stages_owner_retirement$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = to_regclass('document_stages')
       AND attname = 'owner_id'
       AND NOT attisdropped
       AND attnotnull
  ) THEN
    ALTER TABLE document_stages ALTER COLUMN owner_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = to_regclass('document_stages')
       AND attname = 'owner_id'
       AND NOT attisdropped
       AND atthasdef
  ) THEN
    ALTER TABLE document_stages ALTER COLUMN owner_id DROP DEFAULT;
  END IF;
END
$document_stages_owner_retirement$;

DROP INDEX IF EXISTS document_stages_owner_idx;

DROP INDEX IF EXISTS document_stages_owner_folder_idx;

CREATE INDEX IF NOT EXISTS document_stages_folder_idx
  ON document_stages (folder_id, id) WHERE folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);

-- Per-scene monotonic revision signal, at the DB layer (ported from the
-- reference implementation's migration 0071).
--
-- WHY THE DB LAYER: course content has several write seams that share no
-- application-level signal (HTTP routes, agent tools, jobs, migration
-- scripts, manual psql). Only a trigger can make "wrote but never signaled"
-- unexpressible. These companion tables and triggers keep a monotonic
-- per-stage revision and a per-scene revision on every insert/update/delete
-- of document_stages / document_scenes. Companion tables instead of columns
-- keep the document tables' authoritative DDL untouched.
--
-- LOCK ORDER INVARIANT: the scene trigger bumps document_stage_revision (SR)
-- BEFORE document_scene_revision (SCR) — the same order saveDocument uses
-- (stage upsert first, then per-scene upserts). Any future code that writes
-- these two companion tables must take SR before SCR, or the deadlock (40P01)
-- between concurrent stage-first and scene-first writers comes back.
--
-- NOTIFY: each bump emits a JSON route {kind:'stage',stageId} on the
-- agent-event wakeup channel (the same channel the reference's agent event
-- notify bus LISTENs on), so a stage notification wakes exactly the
-- subscribers listening for that stage. The payload is built with
-- json_build_object — never hand-concatenated, because a stageId containing
-- quotes or backslashes would yield invalid JSON.
--
-- NOTIFY SUPPRESSION SWITCH: both triggers check
-- current_setting('openmaic.suppress_stage_notify', true) before pg_notify.
-- Batch/backfill writers MUST run SET LOCAL openmaic.suppress_stage_notify =
-- 'on' inside each batch transaction: the revision still bumps, only the
-- notification is skipped. NOTE: SET LOCAL outside a transaction block only
-- emits a warning and has NO effect.
--
-- TRUNCATE DOES NOT FIRE ROW TRIGGERS: a TRUNCATE reset of document_scenes /
-- document_stages leaves the companion revision rows behind, so any TRUNCATE
-- reset must also truncate document_scene_revision and
-- document_stage_revision.
--
-- IDEMPOTENT BY CONSTRUCTION: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS — replayable in any environment.

CREATE TABLE IF NOT EXISTS document_stage_revision (
  stage_id TEXT PRIMARY KEY NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS document_scene_revision (
  stage_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  rev BIGINT DEFAULT 0 NOT NULL,
  CONSTRAINT document_scene_revision_pkey PRIMARY KEY (stage_id, scene_id)
);

CREATE OR REPLACE FUNCTION openmaic_bump_scene_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
  v_scene_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.stage_id;
    v_scene_id := OLD.id;
  ELSE
    v_stage_id := NEW.stage_id;
    v_scene_id := NEW.id;
  END IF;
  -- LOCK ORDER INVARIANT: SR row BEFORE the SCR row (see the header comment).
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  INSERT INTO document_scene_revision (stage_id, scene_id, rev)
  VALUES (v_stage_id, v_scene_id, 1)
  ON CONFLICT (stage_id, scene_id) DO UPDATE SET rev = document_scene_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION openmaic_bump_stage_revision() RETURNS trigger AS $$
DECLARE
  v_stage_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_stage_id := OLD.id;
  ELSE
    v_stage_id := NEW.id;
  END IF;
  INSERT INTO document_stage_revision (stage_id, rev)
  VALUES (v_stage_id, 1)
  ON CONFLICT (stage_id) DO UPDATE SET rev = document_stage_revision.rev + 1;
  IF coalesce(current_setting('openmaic.suppress_stage_notify', true), '') <> 'on' THEN
    PERFORM pg_notify('openmaic_agent_event_wakeup', json_build_object('kind', 'stage', 'stageId', v_stage_id)::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes;

CREATE TRIGGER openmaic_scene_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_scenes
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_scene_revision();

DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages;

CREATE TRIGGER openmaic_stage_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON document_stages
FOR EACH ROW EXECUTE FUNCTION openmaic_bump_stage_revision();
`,
  ],
  [
    'stage-meta',
    `
CREATE TABLE IF NOT EXISTS stage_meta (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  is_public BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS published_at DOUBLE PRECISION;

ALTER TABLE stage_meta
  ADD COLUMN IF NOT EXISTS generation_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS stage_meta_owner_idx ON stage_meta (owner_id, stage_id);

CREATE INDEX IF NOT EXISTS stage_meta_public_live_idx
  ON stage_meta (stage_id) WHERE is_public AND deleted_at IS NULL;
`,
  ],
  [
    'owner-merges',
    `
CREATE TABLE IF NOT EXISTS owner_merges (
  from_owner_id TEXT PRIMARY KEY,
  to_owner_id TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_assurance TEXT,
  moved JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT owner_merges_distinct CHECK (from_owner_id <> to_owner_id)
);

CREATE INDEX IF NOT EXISTS owner_merges_to_idx ON owner_merges (to_owner_id);
`,
  ],
  [
    'legacy-import-bindings',
    `
CREATE TABLE IF NOT EXISTS legacy_import_bindings (
  browser_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_import_bindings_owner_idx
  ON legacy_import_bindings (owner_id);
`,
  ],
  [
    'owner-material',
    `
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  oss_key TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);

-- Databases created before the byte-store model have this table without
-- oss_key (they tracked an asset id instead); CREATE TABLE IF NOT EXISTS
-- leaves such tables untouched, so the column must be added here. The ''
-- default is the existing "no bytes recorded" sentinel the stale-upload
-- sweeper already understands. The old NOT NULL asset_id column must also
-- go, or its constraint rejects every insert of the new row shape.
ALTER TABLE owner_material ADD COLUMN IF NOT EXISTS oss_key TEXT NOT NULL DEFAULT '';
ALTER TABLE owner_material DROP COLUMN IF EXISTS asset_id;
`,
  ],
  [
    'asset',
    [
      `CREATE TABLE IF NOT EXISTS asset_blobs (
     content_hash TEXT PRIMARY KEY,
     byte_size BIGINT NOT NULL,
     bytes BYTEA,
     unreferenced_at TIMESTAMPTZ
   )`,
      `CREATE TABLE IF NOT EXISTS asset_entries (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash),
     mime TEXT NOT NULL,
     meta JSONB NOT NULL,
     revision INTEGER NOT NULL DEFAULT 1,
     created_at DOUBLE PRECISION NOT NULL
   )`,
      `CREATE INDEX IF NOT EXISTS asset_entries_principal_idx
     ON asset_entries (principal, id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_content_hash_idx
     ON asset_entries (content_hash)`,
      `CREATE INDEX IF NOT EXISTS asset_blobs_unreferenced_idx
     ON asset_blobs (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
      `ALTER TABLE asset_entries
     ADD COLUMN IF NOT EXISTS unreferenced_at TIMESTAMPTZ`,
      `CREATE TABLE IF NOT EXISTS document_asset_refs (
     stage_id TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('stage', 'scene')),
     scene_id TEXT NOT NULL,
     asset_id TEXT NOT NULL REFERENCES asset_entries(id) ON DELETE CASCADE,
     PRIMARY KEY (stage_id, scope, scene_id, asset_id)
   )`,
      `CREATE INDEX IF NOT EXISTS document_asset_refs_asset_idx
     ON document_asset_refs (asset_id)`,
      `CREATE INDEX IF NOT EXISTS asset_entries_expires_idx
     ON asset_entries (expires_at) WHERE expires_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_unreferenced_idx
     ON asset_entries (unreferenced_at) WHERE unreferenced_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS asset_entries_legacy_idx
     ON asset_entries (id) WHERE committed_at IS NULL AND expires_at IS NULL`,
      `CREATE TABLE IF NOT EXISTS asset_reference_tracking (
     singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
     enabled_at TIMESTAMPTZ NOT NULL
   )`,
      `CREATE TABLE IF NOT EXISTS document_asset_withdrawals (
     stage_id TEXT NOT NULL PRIMARY KEY,
     withdrawn_at TIMESTAMPTZ NOT NULL
   )`,
    ].join(';\n'),
  ],
  [
    'classroom-generation-jobs',
    `
CREATE TABLE IF NOT EXISTS classroom_generation_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  ],
  [
    'legacy-classroom-imports',
    `
CREATE TABLE IF NOT EXISTS legacy_classroom_imports (
  legacy_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  stage_id TEXT,
  owner_id TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  ],
  [
    'workspace-model-config',
    `
CREATE TABLE IF NOT EXISTS workspace_model_config (
  owner_id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  secrets JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`,
  ],
  [
    'agent-session',
    `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  title               TEXT,
  title_state         TEXT NOT NULL DEFAULT 'manual',
  stage_id            TEXT NOT NULL,
  active_stage_id     TEXT,
  skill_id            TEXT,
  origin              TEXT,
  existing_course     BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempt             INTEGER NOT NULL DEFAULT 0,
  delivered_user_message_seq INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_worker_pid    INTEGER,
  lease_heartbeat_at  BIGINT,
  cancel_requested_at BIGINT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT agent_sessions_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT agent_sessions_title_state_known
    CHECK (title_state IN ('pending','automatic','manual')),
  CONSTRAINT agent_sessions_status_known
    CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
);

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS delivered_user_message_seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title TEXT;

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS title_state TEXT NOT NULL DEFAULT 'manual';

DO $agent_session_title_state_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
  ) THEN
    LOCK TABLE agent_sessions IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_sessions'::regclass
        AND conname = 'agent_sessions_title_state_known'
    ) THEN
      ALTER TABLE agent_sessions
        ADD CONSTRAINT agent_sessions_title_state_known
        CHECK (title_state IN ('pending','automatic','manual'))
        NOT VALID;
    END IF;
  END IF;
END
$agent_session_title_state_constraint$;

DO $agent_session_title_state_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_sessions'::regclass
      AND conname = 'agent_sessions_title_state_known'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_sessions
      VALIDATE CONSTRAINT agent_sessions_title_state_known;
  END IF;
END
$agent_session_title_state_validation$;

CREATE INDEX IF NOT EXISTS agent_sessions_status_live_idx
  ON agent_sessions (status, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_sessions_owner_live_idx
  ON agent_sessions (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         BIGINT NOT NULL,
  attempt    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_session_entries (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  attempt    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_entries_entry_id_unique UNIQUE (session_id, entry_id),
  CONSTRAINT agent_session_entries_parent_fk
    FOREIGN KEY (session_id, parent_id)
    REFERENCES agent_session_entries (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS agent_session_entries_type_idx
  ON agent_session_entries (session_id, type, seq);

CREATE TABLE IF NOT EXISTS agent_owner_session_event_counters (
  owner_id TEXT PRIMARY KEY,
  n        BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT agent_owner_session_event_counters_nonnegative CHECK (n >= 0)
);

CREATE TABLE IF NOT EXISTS agent_owner_session_events (
  owner_id   TEXT NOT NULL,
  id         BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT,
  attempt    INTEGER,
  data       JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
    ('session_created','session_status','session_deleted',
     'session_active_stage','session_cancel_requested','session_title')),
  CONSTRAINT agent_owner_session_events_status_known CHECK (status IS NULL OR status IN
    ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT agent_owner_session_events_attempt_nonnegative
    CHECK (attempt IS NULL OR attempt >= 0)
);

DO $agent_session_owner_event_type_constraint$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known'::name
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
  ) THEN
    LOCK TABLE agent_owner_session_events IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known_v2'
    ) THEN
      ALTER TABLE agent_owner_session_events
        ADD CONSTRAINT agent_owner_session_events_type_known_v2 CHECK (type IN
          ('session_created','session_status','session_deleted',
           'session_active_stage','session_cancel_requested','session_title'))
        NOT VALID;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'agent_owner_session_events'::regclass
        AND conname = 'agent_owner_session_events_type_known'::name
    ) THEN
      ALTER TABLE agent_owner_session_events
        DROP CONSTRAINT agent_owner_session_events_type_known;
    END IF;
  END IF;
END
$agent_session_owner_event_type_constraint$;

-- Installing the superset above is a catalog-only operation while the short
-- ACCESS EXCLUSIVE lock is held. Validate separately so PostgreSQL scans an
-- existing projection table under VALIDATE CONSTRAINT's weaker lock instead.
-- Once validated, later initializers avoid taking that table lock altogether.
DO $agent_session_owner_event_type_validation$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_owner_session_events'::regclass
      AND conname = 'agent_owner_session_events_type_known_v2'
      AND NOT convalidated
  ) THEN
    ALTER TABLE agent_owner_session_events
      VALIDATE CONSTRAINT agent_owner_session_events_type_known_v2;
  END IF;
END
$agent_session_owner_event_type_validation$;

CREATE TABLE IF NOT EXISTS agent_session_urls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url),
  CONSTRAINT agent_session_urls_source_known CHECK (source IN ('user','web_search'))
);

CREATE INDEX IF NOT EXISTS agent_session_urls_session_created_idx
  ON agent_session_urls (session_id, created_at);
`,
  ],
  [
    'agent-session-material',
    `
CREATE TABLE IF NOT EXISTS agent_session_materials (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT,
  owner_material_id TEXT,
  source_url    TEXT,
  text_asset_id TEXT,
  raw_asset_id  TEXT,
  text_chars    INTEGER NOT NULL DEFAULT 0,
  derived_from  TEXT REFERENCES agent_session_materials(id) ON DELETE CASCADE,
  extraction_status TEXT NOT NULL DEFAULT 'done',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  extraction_stats JSONB,
  extractor_version TEXT,
  extraction_lease_worker_id TEXT,
  extraction_lease_worker_pid INTEGER,
  extraction_lease_heartbeat_at BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_materials_kind_known CHECK (kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_materials_text_chars_nonnegative CHECK (text_chars >= 0)
  ,CONSTRAINT agent_session_materials_extraction_status_known CHECK (extraction_status IN
    ('idle','pending','running','done','failed'))
  ,CONSTRAINT agent_session_materials_extraction_attempts_nonnegative CHECK (extraction_attempts >= 0)
);

ALTER TABLE agent_session_materials ADD COLUMN IF NOT EXISTS owner_material_id TEXT;

CREATE INDEX IF NOT EXISTS agent_session_materials_session_created_idx
  ON agent_session_materials (session_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS agent_session_materials_session_owner_material_idx
  ON agent_session_materials (session_id, owner_material_id)
  WHERE owner_material_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_session_materials_extraction_queue_idx
  ON agent_session_materials (created_at)
  WHERE kind = 'source' AND extraction_status IN ('pending','running');
`,
  ],
  [
    'user-skill',
    `
CREATE TABLE IF NOT EXISTS agent_user_skill (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT agent_user_skill_version_check CHECK (version = 1),
  CONSTRAINT agent_user_skill_name_check
    CHECK (name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(name) <= 64),
  CONSTRAINT agent_user_skill_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT agent_user_skill_description_check
    CHECK (length(description) BETWEEN 1 AND 500 AND description !~ '[\r\n]'),
  CONSTRAINT agent_user_skill_content_check CHECK (octet_length(content) BETWEEN 1 AND 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_user_skill_owner_name_unique
  ON agent_user_skill (owner_id, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_user_skill_owner
  ON agent_user_skill (owner_id, created_at) WHERE deleted_at IS NULL;
`,
  ],
];

/**
 * The pre-byte-store `owner_material` (from before the material byte store),
 * which tracked an asset id instead of an object key.
 */
export const PRE_BYTE_STORE_OWNER_MATERIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_material (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  derived_from TEXT,
  mime TEXT,
  bytes DOUBLE PRECISION NOT NULL,
  original_name TEXT,
  asset_id TEXT NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  extraction JSONB,
  created_at DOUBLE PRECISION NOT NULL,
  deleted_at DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS owner_material_owner_created_idx
  ON owner_material (owner_id, created_at);
`;

/** Run a snapshot's scripts in order, one statement at a time, as its bootstrap did. */
export async function provisionSnapshot(
  queryable: Queryable,
  snapshot: readonly (readonly [store: string, sql: string])[],
): Promise<void> {
  for (const [, sql] of snapshot) {
    for (const statement of splitSqlStatements(sql)) await queryable.query(statement);
  }
}
