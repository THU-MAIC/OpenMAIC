-- Migration: Add missing indexes for performance optimization
-- Date: 2026-04-15

-- 1. Indexes for Feedbacks table
-- Useful for filtering by user, type, and sorting by submission date
CREATE INDEX IF NOT EXISTS idx_feedbacks_user_id ON public.feedbacks(user_id);
CREATE INDEX IF NOT EXISTS idx_feedbacks_type ON public.feedbacks(type);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created_at ON public.feedbacks(created_at DESC);

-- 2. Indexes for Courses table
-- Useful for sorting the course catalog by newest first
CREATE INDEX IF NOT EXISTS idx_courses_created_at ON public.courses(created_at DESC);
-- Useful if users filter courses by language
CREATE INDEX IF NOT EXISTS idx_courses_language ON public.courses(language);

-- 3. Supplemental indexes for Analytics/Leaderboard
-- Helps when querying engagement for a specific course across all users
CREATE INDEX IF NOT EXISTS idx_user_analytics_course_id ON public.user_analytics(course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_scores_course_id ON public.quiz_scores(course_id);
CREATE INDEX IF NOT EXISTS idx_quiz_scores_created_at ON public.quiz_scores(created_at DESC);
