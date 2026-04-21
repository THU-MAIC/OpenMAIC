-- Waitlist + status checks (migrated from legacy MongoDB FastAPI service)

CREATE TABLE IF NOT EXISTS public.waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_joined_at ON public.waitlist (joined_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_lower_unique ON public.waitlist ((lower(email)));

CREATE TABLE IF NOT EXISTS public.status_checks (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_checks_timestamp ON public.status_checks ("timestamp" DESC);

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_checks ENABLE ROW LEVEL SECURITY;

-- No policies: only service_role (bypasses RLS) accesses these from server routes.

COMMENT ON TABLE public.waitlist IS 'SLATE UP marketing waitlist (legacy Mongo parity)';
COMMENT ON TABLE public.status_checks IS 'Client status check pings (legacy Mongo parity)';
