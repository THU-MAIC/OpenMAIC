/**
 * Complete Course (Meta-Course) types
 *
 * Hierarchy: CompleteCourse → CourseModule → Lesson (Stage in existing system)
 */

export type AssessmentStyle = 'formative' | 'summative' | 'portfolio' | 'peer';

/** A pedagogical philosophy that guides AI generation across the whole course */
export interface CoursePhilosophy {
  id: string;
  name: string;
  description: string;
  /** Injected into the system prompt of all generation calls in this course */
  systemPrompt: string;
  /** Specific guidelines listed for the AI to follow */
  generationGuidelines: string[];
  assessmentStyle?: AssessmentStyle;
}

/** A complete course bundling multiple modules, each with multiple lessons */
export interface CompleteCourse {
  id: string;
  title: string;
  description?: string;
  philosophyId: string;
  /** Embedded for convenience when serving from API */
  philosophy?: CoursePhilosophy;
  modules: CourseModule[];
  collaborators: CourseCollaborator[];
  language: string;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
}

/** A module groups related lessons within a course */
export interface CourseModule {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  order: number;
  /** References to existing classroom Stage IDs (file-based JSON) */
  stageIds: string[];
  objectives?: string[];
  estimatedDuration?: number; // minutes
}

/** A collaborator in a course — virtual (AI agent) or real (human user) */
export interface CourseCollaborator {
  id: string;
  type: 'virtual' | 'real';
  /** For virtual: the agent ID from the agent registry */
  agentId?: string;
  /** For real: the user ID from auth */
  userId?: string;
  nickname?: string;
  role?: 'student' | 'teaching_assistant' | 'observer' | 'instructor';
  joinedAt?: number;
}
