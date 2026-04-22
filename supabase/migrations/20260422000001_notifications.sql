-- =============================================================================
-- User Notifications
-- Stores in-app notifications (e.g. "Your classroom is ready").
-- Email sending is handled server-side; this table is the source of truth
-- for the notification bell UI.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type         text        NOT NULL,           -- 'classroom_ready' | 'system' | …
  title        text        NOT NULL,
  body         text,
  action_url   text,                           -- e.g. /classroom/<id>
  metadata     jsonb       DEFAULT '{}'::jsonb,
  is_read      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON public.notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread    ON public.notifications (user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS idx_notifications_created   ON public.notifications (user_id, created_at DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users can read their own notifications
CREATE POLICY "notifications_select_own"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

-- Users can mark their own notifications as read
CREATE POLICY "notifications_update_own"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role can insert and manage all notifications
CREATE POLICY "notifications_service_role_all"
  ON public.notifications FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── Grants ─────────────────────────────────────────────────────────────────────
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL            ON public.notifications TO service_role;

-- =============================================================================
-- Classroom Jobs
-- Tracks background "Create Classroom" jobs so users can see pending generations.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.classroom_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  temporal_id   text        NOT NULL UNIQUE,   -- Temporal workflow ID
  status        text        NOT NULL DEFAULT 'queued',  -- queued | running | succeeded | failed
  classroom_id  text,                          -- set when completed
  classroom_url text,
  requirement   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classroom_jobs_user_id ON public.classroom_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_classroom_jobs_status  ON public.classroom_jobs (status);

ALTER TABLE public.classroom_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "classroom_jobs_select_own"
  ON public.classroom_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "classroom_jobs_service_role_all"
  ON public.classroom_jobs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

GRANT SELECT ON public.classroom_jobs TO authenticated;
GRANT ALL    ON public.classroom_jobs TO service_role;

-- updated_at trigger for classroom_jobs
CREATE TRIGGER trg_classroom_jobs_updated_at
  BEFORE UPDATE ON public.classroom_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
