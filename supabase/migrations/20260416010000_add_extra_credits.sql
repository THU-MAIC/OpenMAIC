-- ── Add extra_credits column ──────────────────────────────────────────────────
ALTER TABLE public.user_plans ADD COLUMN extra_credits integer NOT NULL DEFAULT 0;

-- ── Update increment_course_credit RPC ─────────────────────────────────────────
-- Now accounts for extra_credits first.
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

  -- 1. Check extra_credits first (purchased top-ups)
  IF plan.extra_credits > 0 THEN
    UPDATE public.user_plans
    SET extra_credits = extra_credits - 1,
        courses_generated_total = courses_generated_total + 1
    WHERE user_id = p_user_id;
    
    RETURN jsonb_build_object('allowed', true, 'used_extra', true);
  END IF;

  -- 2. Regular plan logic
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
    WHEN 'FREE'  THEN monthly_cap := 2;       -- 2 lifetime (tracked via total)
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

  -- Increment daily/monthly counters
  UPDATE public.user_plans
  SET courses_generated_total = courses_generated_total + 1,
      courses_generated_month = courses_generated_month + 1
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object('allowed', true);
END;
$$;
