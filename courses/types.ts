/**
 * Course Data Model & Hierarchy Types
 *
 * Defines the nested structure: School → Courses → Modules → Lessons → Scenes
 * This hierarchy enables rich course organization and management.
 */

/**
 * School - Top-level organizational unit
 */
export interface School {
  id: string;
  name: string;
  slug: string;
  description?: string;
  logoUrl?: string;
  ownerId: string;
  settings: SchoolSettings;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolSettings {
  defaultLanguage: string;
  allowedLanguages: string[];
  theme?: string;
  enablePublicCatalog: boolean;
}

/**
 * Course - A structured learning program within a school
 */
export interface Course {
  id: string;
  schoolId: string;
  title: string;
  slug: string;
  description?: string;
  coverImageUrl?: string;
  language: string;
  level: CourseLevel;
  tags: string[];
  status: CourseStatus;
  version: number;
  authorId: string;
  collaboratorIds: string[];
  settings: CourseSettings;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export type CourseLevel = 'beginner' | 'intermediate' | 'advanced' | 'all-levels';
export type CourseStatus = 'draft' | 'review' | 'published' | 'archived';

export interface CourseSettings {
  enableAdaptiveLearning: boolean;
  enableAgents: boolean;
  defaultSceneType: string;
  estimatedDurationMinutes?: number;
}

/**
 * Module - A thematic grouping of lessons within a course
 */
export interface Module {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  order: number;
  status: ModuleStatus;
  prerequisites: string[]; // Module IDs
  estimatedDurationMinutes?: number;
  createdAt: string;
  updatedAt: string;
}

export type ModuleStatus = 'draft' | 'published' | 'archived';

/**
 * Lesson - A single learning unit within a module, composed of scenes
 */
export interface Lesson {
  id: string;
  moduleId: string;
  title: string;
  description?: string;
  order: number;
  status: LessonStatus;
  objectives: string[];
  estimatedDurationMinutes?: number;
  agentConfig?: LessonAgentConfig;
  createdAt: string;
  updatedAt: string;
}

export type LessonStatus = 'draft' | 'published' | 'archived';

export interface LessonAgentConfig {
  enabled: boolean;
  agentIds: string[];
  orchestrationMode: 'linear' | 'adaptive' | 'free-form';
}

/**
 * LessonScene - Links a scene to a lesson with ordering and config
 */
export interface LessonScene {
  id: string;
  lessonId: string;
  sceneType: SceneTypeId;
  title: string;
  order: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Scene type identifiers for the pluggable scene engine
 */
export type SceneTypeId =
  | 'lecture'
  | 'quiz'
  | 'simulation'
  | 'discussion'
  | 'debate'
  | 'project'
  | 'slide'
  | 'interactive'
  | 'pbl';

/**
 * Student enrollment and progress tracking
 */
export interface Enrollment {
  id: string;
  studentId: string;
  courseId: string;
  status: EnrollmentStatus;
  progress: CourseProgress;
  enrolledAt: string;
  completedAt?: string;
}

export type EnrollmentStatus = 'active' | 'completed' | 'paused' | 'dropped';

export interface CourseProgress {
  completedLessonIds: string[];
  completedModuleIds: string[];
  currentLessonId?: string;
  currentSceneId?: string;
  overallPercentage: number;
  lastAccessedAt: string;
}
