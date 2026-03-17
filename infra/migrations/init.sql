-- OpenMAIC Database Initialization
-- PostgreSQL + pgvector setup
--
-- This script runs automatically when the PostgreSQL container starts
-- for the first time. It creates the required extensions and base schema.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- Course Hierarchy: School → Courses → Modules → Lessons → Scenes
-- ============================================================================

CREATE TABLE IF NOT EXISTS schools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  logo_url TEXT,
  owner_id UUID NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  language VARCHAR(10) NOT NULL DEFAULT 'en-US',
  level VARCHAR(50) NOT NULL DEFAULT 'all-levels',
  tags TEXT[] DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  author_id UUID NOT NULL,
  collaborator_ids UUID[] DEFAULT '{}',
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  UNIQUE(school_id, slug)
);

CREATE TABLE IF NOT EXISTS modules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  prerequisites UUID[] DEFAULT '{}',
  estimated_duration_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lessons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  objectives TEXT[] DEFAULT '{}',
  estimated_duration_minutes INTEGER,
  agent_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lesson_scenes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  scene_type VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Enrollment & Progress
-- ============================================================================

CREATE TABLE IF NOT EXISTS enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  progress JSONB NOT NULL DEFAULT '{}',
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(student_id, course_id)
);

-- ============================================================================
-- Knowledge Layer (Vector Store)
-- ============================================================================

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type VARCHAR(50) NOT NULL,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  lesson_id UUID REFERENCES lessons(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding vector(1536),  -- OpenAI text-embedding-3-small dimension
  chunk_index INTEGER,
  total_chunks INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector similarity search index
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
  ON knowledge_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================================
-- Concepts (Knowledge Graph)
-- ============================================================================

CREATE TABLE IF NOT EXISTS concepts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  domain VARCHAR(255),
  prerequisites UUID[] DEFAULT '{}',
  related_concepts UUID[] DEFAULT '{}',
  linked_lesson_ids UUID[] DEFAULT '{}',
  difficulty REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Agent Configurations (persistent)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  system_prompt TEXT NOT NULL,
  tools JSONB NOT NULL DEFAULT '[]',
  memory_config JSONB NOT NULL DEFAULT '{}',
  model_preference JSONB,
  personality JSONB NOT NULL DEFAULT '{}',
  policies JSONB NOT NULL DEFAULT '[]',
  appearance JSONB NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 5,
  is_built_in BOOLEAN NOT NULL DEFAULT false,
  is_generated BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  bound_stage_id UUID,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- BYOK (Bring Your Own Key) User Configurations
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_byok_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  provider_id VARCHAR(100) NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  base_url TEXT,
  preferred_model VARCHAR(255),
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, provider_id)
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_courses_school ON courses(school_id);
CREATE INDEX IF NOT EXISTS idx_courses_status ON courses(status);
CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id);
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id);
CREATE INDEX IF NOT EXISTS idx_lesson_scenes_lesson ON lesson_scenes(lesson_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_course ON knowledge_documents(course_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_documents(source_type);
CREATE INDEX IF NOT EXISTS idx_concepts_domain ON concepts(domain);

-- ============================================================================
-- Updated_at trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'schools', 'courses', 'modules', 'lessons', 'lesson_scenes',
      'enrollments', 'knowledge_documents', 'concepts',
      'agent_configs', 'user_byok_configs'
    ])
  LOOP
    EXECUTE format(
      'CREATE TRIGGER update_%s_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()',
      tbl, tbl
    );
  END LOOP;
EXCEPTION WHEN duplicate_object THEN
  NULL; -- triggers already exist
END;
$$;
