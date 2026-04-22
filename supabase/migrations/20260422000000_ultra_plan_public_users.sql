-- =============================================================================
-- Ultra Plan + Public/Private User Visibility
-- Adds ULTRA account type, is_public flag on user_plans,
-- and updates credit logic to handle ULTRA.
-- =============================================================================

-- ── 1. Extend account_type enum with ULTRA ────────────────────────────────────
ALTER TYPE public.account_type ADD VALUE IF NOT EXISTS 'ULTRA';

-- ── 2. Add is_public column to user_plans (default private) ──────────────────
ALTER TABLE public.user_plans
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- ── 3. Add ultra-aware logic to increment_course_credit ──────────────────────
-- Update the function to treat ULTRA like ADMIN (unlimited)
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
    WHEN 'FREE'  THEN monthly_cap := 2;
    WHEN 'PLUS'  THEN monthly_cap := 30;
    WHEN 'ULTRA' THEN monthly_cap := 99999;
    WHEN 'ADMIN' THEN monthly_cap := 99999;
  END CASE;

  -- FREE caps on total lifetime count
  IF plan.account_type = 'FREE' THEN
    allowed := (plan.courses_generated_total + COALESCE(plan.extra_credits, 0)) > plan.courses_generated_total
               AND plan.courses_generated_total < (2 + COALESCE(plan.extra_credits, 0));
  ELSIF plan.account_type IN ('ULTRA', 'ADMIN') THEN
    allowed := true;
  ELSE
    -- PLUS: check subscription still active
    IF plan.subscription_period != 'lifetime'
       AND (plan.subscription_status IS NULL OR plan.subscription_status NOT IN ('active', 'trialing'))
    THEN
      allowed := false;
    ELSE
      allowed := (plan.courses_generated_month < monthly_cap)
                 OR (COALESCE(plan.extra_credits, 0) > 0);
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

  -- Consume extra credit first for PLUS if monthly cap exceeded
  IF plan.account_type = 'PLUS'
     AND plan.courses_generated_month >= monthly_cap
     AND COALESCE(plan.extra_credits, 0) > 0
  THEN
    UPDATE public.user_plans
    SET courses_generated_total = courses_generated_total + 1,
        courses_generated_month = courses_generated_month + 1,
        extra_credits           = GREATEST(extra_credits - 1, 0)
    WHERE user_id = p_user_id;
  ELSE
    UPDATE public.user_plans
    SET courses_generated_total = courses_generated_total + 1,
        courses_generated_month = courses_generated_month + 1
    WHERE user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

-- ── 4. Index for public catalog queries ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_plans_is_public ON public.user_plans (is_public);
