-- Migration: Add Certificates and Engagement Tracking
-- Date: 2026-04-16
-- Goal: Support course completion rewards and grading.

-- 1. Add engagement_count to user_analytics
ALTER TABLE public.user_analytics 
ADD COLUMN IF NOT EXISTS engagement_count INTEGER DEFAULT 0;

-- 2. Create RPC for incrementing engagement count
CREATE OR REPLACE FUNCTION public.increment_engagement_count(u_id UUID, c_id TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO public.user_analytics (user_id, course_id, engagement_count)
  VALUES (u_id, c_id, 1)
  ON CONFLICT (user_id, course_id)
  DO UPDATE SET engagement_count = public.user_analytics.engagement_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Create Certificates table
CREATE TABLE IF NOT EXISTS public.certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  course_name TEXT NOT NULL,
  student_name TEXT NOT NULL,
  score INTEGER,
  grade TEXT,
  topics JSONB DEFAULT '[]'::jsonb,
  watch_time_percentage INTEGER,
  quiz_score_average INTEGER,
  engagement_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Prevent multiple certificates for the same user/course if we want uniqueness
  UNIQUE(user_id, course_id)
);

-- 4. Enable RLS
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;

-- 5. Policies
-- Everyone can read certificates (for public sharing)
DROP POLICY IF EXISTS "Certificates are publicly readable" ON public.certificates;
CREATE POLICY "Certificates are publicly readable" ON public.certificates FOR SELECT USING (true);

-- Users can only insert their own certificates
DROP POLICY IF EXISTS "Users can insert their own certificates" ON public.certificates;
CREATE POLICY "Users can insert their own certificates" ON public.certificates FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_certificates_user ON public.certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_course ON public.certificates(course_id);
