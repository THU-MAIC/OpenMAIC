-- Seed data for Slate
-- This file is automatically executed on 'supabase db reset'

-- 1. Mock Users in auth.users (id, email, raw_user_meta_data)
-- Note: password is 'password123' hashed
INSERT INTO auth.users (id, email, raw_user_meta_data, encrypted_password, email_confirmed_at, role)
VALUES 
  ('e4640f7b-bb18-4335-ac82-e3c4943c45c4', 'alex@example.com', '{"full_name": "Alex Rivers", "avatar_url": "https://api.dicebear.com/7.x/avataaars/svg?seed=Alex"}', crypt('password123', gen_salt('bf')), now(), 'authenticated'),
  ('f5751f8c-cc29-4446-bd93-f4a5c53d56d5', 'sarah@example.com', '{"full_name": "Sarah Chen", "avatar_url": "https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah"}', crypt('password123', gen_salt('bf')), now(), 'authenticated'),
  ('a1b2c3d4-e5f6-4a5b-b6c7-d8e9f0a1b2c3', 'marco@example.com', '{"full_name": "Marco Rossi", "avatar_url": "https://api.dicebear.com/7.x/avataaars/svg?seed=Marco"}', crypt('password123', gen_salt('bf')), now(), 'authenticated'),
  ('b2c3d4e5-f6a7-4b6c-c7d8-e9f0a1b2c3d4', 'yuki@example.com', '{"full_name": "Yuki Tanaka", "avatar_url": "https://api.dicebear.com/7.x/avataaars/svg?seed=Yuki"}', crypt('password123', gen_salt('bf')), now(), 'authenticated'),
  ('c3d4e5f6-a7b8-4c7d-d8e9-f0a1b2c3d4e5', 'elena@example.com', '{"full_name": "Elena Smith", "avatar_url": "https://api.dicebear.com/7.x/avataaars/svg?seed=Elena"}', crypt('password123', gen_salt('bf')), now(), 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- 2. Mock User Scores for Hall of Fame
INSERT INTO public.user_scores (user_id, display_name, avatar_url, total_score, quizzes_completed, courses_completed, country_code, country_name)
VALUES
  ('e4640f7b-bb18-4335-ac82-e3c4943c45c4', 'Alex Rivers', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex', 12450, 42, 5, 'US', 'United States'),
  ('f5751f8c-cc29-4446-bd93-f4a5c53d56d5', 'Sarah Chen', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sarah', 11200, 38, 4, 'CN', 'China'),
  ('a1b2c3d4-e5f6-4a5b-b6c7-d8e9f0a1b2c3', 'Marco Rossi', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Marco', 9800, 31, 3, 'IT', 'Italy'),
  ('b2c3d4e5-f6a7-4b6c-c7d8-e9f0a1b2c3d4', 'Yuki Tanaka', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Yuki', 8500, 25, 3, 'JP', 'Japan'),
  ('c3d4e5f6-a7b8-4c7d-d8e9-f0a1b2c3d4e5', 'Elena Smith', 'https://api.dicebear.com/7.x/avataaars/svg?seed=Elena', 7200, 20, 2, 'GB', 'United Kingdom')
ON CONFLICT (user_id) DO UPDATE SET
  total_score = EXCLUDED.total_score,
  quizzes_completed = EXCLUDED.quizzes_completed;

-- 3. Mock Courses for Catalog
INSERT INTO public.courses (id, name, title, description, slide_count, language, user_id, stage_id)
VALUES
  ('course-ai-101', 'Intro to Artificial Intelligence', 'Intro to Artificial Intelligence', 'Learn the basics of Neural Networks and Machine Learning in this comprehensive guide.', 12, 'en-US', 'e4640f7b-bb18-4335-ac82-e3c4943c45c4', 'stage-ai-101'),
  ('course-design-basics', 'Design Principles 101', 'Design Principles 101', 'Master contrast, alignment, and hierarchy to create stunning visual compositions.', 8, 'en-US', 'e4640f7b-bb18-4335-ac82-e3c4943c45c4', 'stage-design-basics'),
  ('course-modern-history', 'Twentieth Century History', 'Twentieth Century History', 'A deep dive into the major events that shaped the modern world.', 15, 'en-US', 'f5751f8c-cc29-4446-bd93-f4a5c53d56d5', 'stage-modern-history'),
  ('course-quantum-basics', 'Quantum Mechanics for Beginners', 'Quantum Mechanics for Beginners', 'Making the complex world of quantum physics easy to understand.', 10, 'en-US', 'a1b2c3d4-e5f6-4a5b-b6c7-d8e9f0a1b2c3', 'stage-quantum-basics')
ON CONFLICT (id) DO NOTHING;

-- 4. Mock Course Tags
INSERT INTO public.course_tags (course_id, tag_type, tag_value)
VALUES
  ('course-ai-101', 'subject', 'Computer Science'),
  ('course-ai-101', 'topic', 'Artificial Intelligence'),
  ('course-ai-101', 'age_range', '15-99'),
  ('course-design-basics', 'subject', 'Arts'),
  ('course-design-basics', 'topic', 'Graphic Design'),
  ('course-design-basics', 'age_range', '12-99'),
  ('course-modern-history', 'subject', 'History'),
  ('course-modern-history', 'topic', 'Modern Times'),
  ('course-modern-history', 'age_range', '14-99'),
  ('course-quantum-basics', 'subject', 'Science'),
  ('course-quantum-basics', 'topic', 'Physics'),
  ('course-quantum-basics', 'age_range', '16-99')
ON CONFLICT DO NOTHING;
