-- =============================================================================
-- User Plans & Billing
-- Tracks account type (FREE / PLUS / ADMIN), Stripe subscription info,
-- and course-generation credit usage per user.
-- =============================================================================

-- ── 1. account_type enum ─────────────────────────────────────────────────────
CREATE TYPE public.account_type AS ENUM ('FREE', 'PLUS', 'ADMIN');

-- ── 2. user_plans table ───────────────────────────────────────────────────────
CREATE TABLE public.user_plans (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

  -- Account classification
  account_type                public.account_type NOT NULL DEFAULT 'FREE',

  -- Stripe identifiers
  stripe_customer_id          text,
  stripe_subscription_id      text,
  stripe_price_id             text,
  subscription_status         text,          -- active | canceled | past_due | trialing | …
  subscription_period         text,          -- 'monthly' | 'yearly' | 'lifetime' | null
  current_period_end          timestamptz,   -- when the current billing cycle ends

  -- Course-generation credits
  courses_generated_total     integer NOT NULL DEFAULT 0,   -- lifetime total
  courses_generated_month     integer NOT NULL DEFAULT 0,   -- resets each billing month
  courses_month_reset_at      timestamptz    NOT NULL DEFAULT now(),

  -- Lifetime plan gate (max 100 purchasers)
  lifetime_claimed            boolean        NOT NULL DEFAULT false,

  created_at                  timestamptz    NOT NULL DEFAULT now(),
  updated_at                  timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT user_plans_user_id_key UNIQUE (user_id)
);

-- ── 3. lifetime_slots tracker ─────────────────────────────────────────────────
-- A single-row table that records how many lifetime slots have been sold.
CREATE TABLE public.lifetime_slots (
  id            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  slots_taken   integer NOT NULL DEFAULT 0,
  max_slots     integer NOT NULL DEFAULT 100
);

INSERT INTO public.lifetime_slots (id, slots_taken, max_slots) VALUES (1, 0, 100);

-- ── 4. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX idx_user_plans_user_id             ON public.user_plans (user_id);
CREATE INDEX idx_user_plans_stripe_customer_id  ON public.user_plans (stripe_customer_id);
CREATE INDEX idx_user_plans_stripe_sub_id       ON public.user_plans (stripe_subscription_id);
CREATE INDEX idx_user_plans_account_type        ON public.user_plans (account_type);

-- ── 5. updated_at trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_plans_updated_at
  BEFORE UPDATE ON public.user_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 6. Auto-create FREE plan row on new signup ────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user_plan()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_plans (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_create_user_plan_on_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_plan();

-- ── 7. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_plans ENABLE ROW LEVEL SECURITY;

-- Users can read their own plan
CREATE POLICY "user_plans_select_own"
  ON public.user_plans FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can insert / update / delete (webhooks run as service role)
CREATE POLICY "user_plans_service_role_all"
  ON public.user_plans FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

ALTER TABLE public.lifetime_slots ENABLE ROW LEVEL SECURITY;

-- Anyone can read (to show "X slots remaining")
CREATE POLICY "lifetime_slots_select_all"
  ON public.lifetime_slots FOR SELECT
  USING (true);

CREATE POLICY "lifetime_slots_service_role_all"
  ON public.lifetime_slots FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ── 8. Helper: atomically claim a lifetime slot ───────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_lifetime_slot()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _slots_taken integer;
  _max_slots   integer;
BEGIN
  SELECT slots_taken, max_slots
  INTO _slots_taken, _max_slots
  FROM public.lifetime_slots
  WHERE id = 1
  FOR UPDATE;

  IF _slots_taken >= _max_slots THEN
    RETURN false;
  END IF;

  UPDATE public.lifetime_slots
  SET slots_taken = slots_taken + 1
  WHERE id = 1;

  RETURN true;
END;
$$;

-- ── 9. Helper: increment course credit & check limit ──────────────────────────
CREATE OR REPLACE FUNCTION public.increment_course_credit(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  plan         public.user_plans%ROWTYPE;
  now_ts       timestamptz := now();
  monthly_cap  integer;
  allowed      boolean;
BEGIN
  SELECT * INTO plan FROM public.user_plans WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    -- Auto-create FREE plan row if missing
    INSERT INTO public.user_plans (user_id) VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING
    RETURNING * INTO plan;
  END IF;

  -- Reset monthly counter if it's a new billing month
  IF now_ts - plan.courses_month_reset_at > interval '30 days' THEN
    UPDATE public.user_plans
    SET courses_generated_month = 0,
        courses_month_reset_at  = now_ts
    WHERE user_id = p_user_id
    RETURNING * INTO plan;
  END IF;

  -- Determine cap based on account type
  CASE plan.account_type
    WHEN 'FREE'  THEN monthly_cap := 2;       -- 2 total (tracked via total)
    WHEN 'PLUS'  THEN monthly_cap := 30;
    WHEN 'ADMIN' THEN monthly_cap := 99999;
  END CASE;

  -- FREE accounts cap on total, not monthly
  IF plan.account_type = 'FREE' THEN
    allowed := plan.courses_generated_total < 2;
  ELSE
    -- Check subscription still active for PLUS
    IF plan.account_type = 'PLUS'
       AND plan.subscription_period != 'lifetime'
       AND (plan.subscription_status IS NULL OR plan.subscription_status NOT IN ('active', 'trialing'))
    THEN
      allowed := false;
    ELSE
      allowed := plan.courses_generated_month < monthly_cap;
    END IF;
  END IF;

  IF NOT allowed THEN
    RETURN jsonb_build_object('allowed', false, 'reason',
      CASE
        WHEN plan.account_type = 'FREE' THEN 'free_limit_reached'
        ELSE 'monthly_limit_reached'
      END
    );
  END IF;

  -- Increment counters
  UPDATE public.user_plans
  SET courses_generated_total = courses_generated_total + 1,
      courses_generated_month = courses_generated_month + 1
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

-- ── 10. Grants ────────────────────────────────────────────────────────────────
GRANT SELECT ON public.user_plans     TO authenticated;
GRANT SELECT ON public.lifetime_slots TO authenticated, anon;
GRANT ALL    ON public.user_plans     TO service_role;
GRANT ALL    ON public.lifetime_slots TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_lifetime_slot()           TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_course_credit(uuid)   TO service_role;
