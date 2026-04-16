-- Migration: Add gamification features (streaks) to user_scores
-- Date: 2026-04-16

ALTER TABLE public.user_scores
ADD COLUMN IF NOT EXISTS current_streak INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS highest_streak INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_activity_date DATE;
