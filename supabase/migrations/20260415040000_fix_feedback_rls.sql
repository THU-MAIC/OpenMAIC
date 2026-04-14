-- Fix feedback RLS to allow anonymous submissions
-- The original policy was restricted to authenticated users only,
-- but the API supports anonymous feedback (user_id = NULL).

DROP POLICY IF EXISTS "Users can submit feedback" ON public.feedbacks;

-- Allow both authenticated users (user_id must match their uid)
-- and anonymous users (user_id must be null)
CREATE POLICY "Users can submit feedback"
ON public.feedbacks FOR INSERT
WITH CHECK (
  (auth.uid() IS NOT NULL AND auth.uid() = user_id)
  OR
  (auth.uid() IS NULL AND user_id IS NULL)
);
