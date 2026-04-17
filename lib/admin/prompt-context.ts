/**
 * Build context for prompt variable substitution
 * Extracts user, classroom, language, and media info from request context
 * Phase 3: AI Prompt Dynamic Injection
 */

import { auth } from '@/lib/auth/auth';
import { readClassroom } from '@/lib/server/classroom-storage';

export interface PromptContext {
  user: {
    id: string;
    name: string;
    role: 'ADMIN' | 'INSTRUCTOR' | 'STUDENT';
    email: string;
  };
  classroom?: {
    id: string;
    name: string;
    topic?: string;
    gradeLevel?: string;
  };
  language: 'en' | 'zh';
  mediaType?: 'text' | 'image' | 'video' | 'audio';
  timestamp: Date;
  customFields?: Record<string, string>;
}

/**
 * Build prompt context from session and classroom context
 */
export async function buildPromptContext(
  classroomId?: string,
  language: 'en' | 'zh' = 'en',
  mediaType?: 'text' | 'image' | 'video' | 'audio',
  customFields?: Record<string, string>
): Promise<PromptContext | null> {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  let classroom: PromptContext['classroom'] | undefined;
  if (classroomId) {
    try {
      const cr = await readClassroom(classroomId);
      if (cr) {
        classroom = {
          id: cr.id,
          name: cr.stage?.name || cr.id,
          topic: undefined,
          gradeLevel: undefined,
        };
      }
    } catch (err) {
      console.error('[buildPromptContext] Error fetching classroom:', err);
    }
  }

  return {
    user: {
      id: session.user.id,
      name: session.user.name ?? 'User',
      role: (session.user.role as 'ADMIN' | 'INSTRUCTOR' | 'STUDENT') || 'STUDENT',
      email: session.user.email ?? '',
    },
    classroom,
    language,
    mediaType,
    timestamp: new Date(),
    customFields,
  };
}

/**
 * Convert context object to flat template variables
 * PromptContext → { "user.id": "...", "context": "...", etc. }
 */
export function contextToVariables(context: PromptContext): Record<string, string> {
  const vars: Record<string, string> = {};

  // User variables
  vars['user.id'] = context.user.id;
  vars['user.name'] = context.user.name;
  vars['user.role'] = context.user.role;
  vars['user.email'] = context.user.email;

  // Classroom variables
  if (context.classroom) {
    vars['classroom_name'] = context.classroom.name;
    vars['context'] = context.classroom.name;
    vars['topic'] = context.classroom.topic || '';
    vars['grade_level'] = context.classroom.gradeLevel || '';
  } else {
    vars['context'] = '';
    vars['topic'] = '';
    vars['grade_level'] = '';
  }

  // Language and media
  vars['language'] = context.language;
  vars['media_type'] = context.mediaType || 'text';

  // Timestamp
  vars['timestamp'] = context.timestamp.toISOString();

  // Custom fields
  if (context.customFields) {
    Object.assign(vars, context.customFields);
  }

  return vars;
}
