-- Migration: Analytics and Leaderboards
-- Date: 2026-04-15
-- Goal: Track student engagement and performance for the Hall of Fame.

-- 1. Track overall course engagement per user
CREATE TABLE IF NOT EXISTS public.user_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  course_name TEXT,
  total_slides INTEGER DEFAULT 0,
  slides_viewed INTEGER DEFAULT 0,
  last_slide_index INTEGER DEFAULT 0,
  watch_duration_seconds INTEGER DEFAULT 0,
  quizzes_solved INTEGER DEFAULT 0,
  first_viewed_at TIMESTAMPTZ DEFAULT NOW(),
  last_viewed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, course_id)
);

-- 2. Track individual quiz attempts
CREATE TABLE IF NOT EXISTS public.quiz_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  percentage INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Aggregate scores for the leaderboard
CREATE TABLE IF NOT EXISTS public.user_scores (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Student',
  avatar_url TEXT,
  total_score INTEGER NOT NULL DEFAULT 0,
  quizzes_completed INTEGER NOT NULL DEFAULT 0,
  courses_completed INTEGER NOT NULL DEFAULT 0,
  country_code TEXT DEFAULT 'XX',
  country_name TEXT DEFAULT 'Unknown',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Enable RLS
ALTER TABLE public.user_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_scores ENABLE ROW LEVEL SECURITY;

-- 5. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_scores_total ON public.user_scores(total_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_scores_country ON public.user_scores(country_code, total_score DESC);
CREATE INDEX IF NOT EXISTS idx_user_analytics_user ON public.user_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_scores_user ON public.quiz_scores(user_id, course_id);

-- 6. Policies
-- User Analytics: Users can only see/update their own data
DROP POLICY IF EXISTS "Users can only see their own analytics" ON public.user_analytics;
CREATE POLICY "Users can only see their own analytics" ON public.user_analytics FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can only insert their own analytics" ON public.user_analytics;
CREATE POLICY "Users can only insert their own analytics" ON public.user_analytics FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can only update their own analytics" ON public.user_analytics;
CREATE POLICY "Users can only update their own analytics" ON public.user_analytics FOR UPDATE USING (auth.uid() = user_id);

-- Quiz Scores: Users can only see/insert their own quiz scores
DROP POLICY IF EXISTS "Users can only see their own quiz scores" ON public.quiz_scores;
CREATE POLICY "Users can only see their own quiz scores" ON public.quiz_scores FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can only insert their own quiz scores" ON public.quiz_scores;
CREATE POLICY "Users can only insert their own quiz scores" ON public.quiz_scores FOR INSERT WITH CHECK (auth.uid() = user_id);

-- User Scores: Everyone can read (for leaderboard), but only the user can update (via API)
DROP POLICY IF EXISTS "Everyone can read user scores for leaderboard" ON public.user_scores;
CREATE POLICY "Everyone can read user scores for leaderboard" ON public.user_scores FOR SELECT USING (true);
DROP POLICY IF EXISTS "Users can only update their own score" ON public.user_scores;
CREATE POLICY "Users can only update their own score" ON public.user_scores FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert their own initial score" ON public.user_scores;
CREATE POLICY "Users can insert their own initial score" ON public.user_scores FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 7. RPC for incrementing quiz counts atomically
CREATE OR REPLACE FUNCTION public.increment_quiz_count(u_id UUID, c_id TEXT)
RETURNS void AS $$
BEGIN
  INSERT INTO public.user_analytics (user_id, course_id, quizzes_solved)
  VALUES (u_id, c_id, 1)
  ON CONFLICT (user_id, course_id)
  DO UPDATE SET quizzes_solved = public.user_analytics.quizzes_solved + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. RPC for incrementing slide views atomically
CREATE OR REPLACE FUNCTION public.increment_slide_view(u_id UUID, c_id TEXT, s_idx INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO public.user_analytics (user_id, course_id, last_slide_index, slides_viewed)
  VALUES (u_id, c_id, s_idx, 1)
  ON CONFLICT (user_id, course_id)
  DO UPDATE SET 
    last_slide_index = s_idx,
    slides_viewed = public.user_analytics.slides_viewed + 1,
    last_viewed_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. RPC for incrementing watch duration atomically
CREATE OR REPLACE FUNCTION public.increment_watch_duration(u_id UUID, c_id TEXT, dur INTEGER)
RETURNS void AS $$
BEGIN
  INSERT INTO public.user_analytics (user_id, course_id, watch_duration_seconds)
  VALUES (u_id, c_id, dur)
  ON CONFLICT (user_id, course_id)
  DO UPDATE SET 
    watch_duration_seconds = public.user_analytics.watch_duration_seconds + dur,
    last_viewed_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
