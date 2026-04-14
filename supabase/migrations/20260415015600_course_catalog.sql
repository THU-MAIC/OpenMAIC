-- Course catalog entries (public-facing, no creator/prompt info)
CREATE TABLE IF NOT EXISTS public.courses (
  id TEXT PRIMARY KEY,                    -- matches classroom ID
  title TEXT NOT NULL,
  description TEXT,
  slide_count INTEGER DEFAULT 0,
  thumbnail_url TEXT,                     -- first slide thumbnail (optional, future)
  language TEXT DEFAULT 'en-US',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI-generated tags for filtering
CREATE TABLE IF NOT EXISTS public.course_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id TEXT NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  tag_type TEXT NOT NULL,                 -- 'subject', 'age_range', 'topic', 'sub_topic'
  tag_value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(course_id, tag_type, tag_value)
);

-- Indices for filtering performance
CREATE INDEX IF NOT EXISTS idx_course_tags_type_value ON public.course_tags(tag_type, tag_value);
CREATE INDEX IF NOT EXISTS idx_course_tags_course_id ON public.course_tags(course_id);

-- Enable RLS
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_tags ENABLE ROW LEVEL SECURITY;

-- Policies for public catalog access
-- Allowing public READ for the catalog
-- Allowing service/anon INSERT/UPDATE for background processing (based on user request for "public anon key is fine")

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'courses' AND policyname = 'Public read access') THEN
        CREATE POLICY "Public read access" ON public.courses FOR SELECT USING (true);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'courses' AND policyname = 'Allow anonymous insert') THEN
        CREATE POLICY "Allow anonymous insert" ON public.courses FOR INSERT WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'courses' AND policyname = 'Allow anonymous update') THEN
        CREATE POLICY "Allow anonymous update" ON public.courses FOR UPDATE USING (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'course_tags' AND policyname = 'Public read access') THEN
        CREATE POLICY "Public read access" ON public.course_tags FOR SELECT USING (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'course_tags' AND policyname = 'Allow anonymous insert') THEN
        CREATE POLICY "Allow anonymous insert" ON public.course_tags FOR INSERT WITH CHECK (true);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'course_tags' AND policyname = 'Allow anonymous update') THEN
        CREATE POLICY "Allow anonymous update" ON public.course_tags FOR UPDATE USING (true);
    END IF;
END
$$;
