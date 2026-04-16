-- Record a calendar day of learning for streaks (UTC date).
-- Called from analytics / quiz-score when the user performs qualifying activity.
-- Idempotent per UTC day: multiple calls the same day do not inflate the streak.

CREATE OR REPLACE FUNCTION public.record_learning_day(u_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today date := (timezone('utc', now()))::date;
  last_d date;
  cur_s integer;
  hi_s integer;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> u_id THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT last_activity_date, current_streak, highest_streak
  INTO last_d, cur_s, hi_s
  FROM public.user_scores
  WHERE user_id = u_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.user_scores (user_id, current_streak, highest_streak, last_activity_date)
    VALUES (u_id, 1, 1, today);
    RETURN;
  END IF;

  IF last_d = today THEN
    RETURN;
  END IF;

  IF last_d IS NULL OR last_d < today - 1 THEN
    cur_s := 1;
  ELSE
    -- last_d = yesterday
    cur_s := cur_s + 1;
  END IF;

  hi_s := GREATEST(COALESCE(hi_s, 0), cur_s);

  UPDATE public.user_scores
  SET
    current_streak = cur_s,
    highest_streak = hi_s,
    last_activity_date = today,
    updated_at = now()
  WHERE user_id = u_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_learning_day(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_learning_day(uuid) TO authenticated;
