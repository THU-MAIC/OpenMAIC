-- Migration: Add index to speed up best-score lookup per user/scene
-- Date: 2026-04-15
-- Goal: The quiz-score API now queries the best previous score for a (user_id, scene_id)
--       pair before applying a delta to user_scores. This composite index makes that
--       lookup O(log n) instead of a full table scan.

CREATE INDEX IF NOT EXISTS idx_quiz_scores_user_scene_score
  ON public.quiz_scores(user_id, scene_id, score DESC);
