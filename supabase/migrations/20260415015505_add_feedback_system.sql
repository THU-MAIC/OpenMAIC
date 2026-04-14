-- Create feedback table
CREATE TABLE IF NOT EXISTS public.feedbacks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  user_id UUID REFERENCES auth.users(id),
  user_email TEXT,
  type TEXT NOT NULL, -- 'bug', 'feature', 'other'
  content TEXT NOT NULL,
  screenshot_url TEXT,
  url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Enable RLS on the table
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert feedback
DROP POLICY IF EXISTS "Users can submit feedback" ON public.feedbacks;
CREATE POLICY "Users can submit feedback" 
ON public.feedbacks FOR INSERT 
TO authenticated 
WITH CHECK (auth.uid() = user_id);

-- Allow admins to read feedback
DROP POLICY IF EXISTS "Admins can read feedback" ON public.feedbacks;
CREATE POLICY "Admins can read feedback" 
ON public.feedbacks FOR SELECT 
TO authenticated 
USING (auth.jwt() ->> 'email' = 'chalk.core@gmail.com');

-- Create the storage bucket for screenshots
INSERT INTO storage.buckets (id, name, public)
VALUES ('feedback-screenshots', 'feedback-screenshots', true)
ON CONFLICT (id) DO NOTHING;

-- Set up storage policies for the bucket
-- Allow public read access to screenshots
DROP POLICY IF EXISTS "Public Read Access" ON storage.objects;
CREATE POLICY "Public Read Access"
ON storage.objects FOR SELECT
USING (bucket_id = 'feedback-screenshots');

-- Allow authenticated users to upload screenshots
DROP POLICY IF EXISTS "Authenticated Upload Access" ON storage.objects;
CREATE POLICY "Authenticated Upload Access"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'feedback-screenshots');
