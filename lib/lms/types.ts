/**
 * Generic LMS integration layer.
 *
 * Each LMS provider implements `LMSProvider`. The registry instantiates them
 * by ID. New LMS systems are added by writing a new provider class.
 */

export type LMSProviderType = 'lti' | 'rest';

export interface LMSCredentials {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  /** Provider-specific extra fields */
  [key: string]: unknown;
}

export interface LMSConnection {
  providerId: string;
  baseUrl: string;
  accessToken?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalGrade {
  externalUserId: string;
  externalCourseId: string;
  externalItemId: string;
  score: number;
  maxScore: number;
  feedback?: string;
  timestamp: Date;
}

export interface ExternalCourseData {
  title: string;
  description?: string;
  language?: string;
  modules?: Array<{ title: string; lessons: Array<{ title: string; stageId: string }> }>;
}

export interface ExternalEnrollment {
  externalUserId: string;
  externalCourseId: string;
  role: string;
  enrolledAt: Date;
}

export interface UserMapping {
  internalUserId: string;
  externalUserId: string;
  providerId: string;
}

export interface LMSProvider {
  id: string;
  name: string;
  type: LMSProviderType;

  authenticate(credentials: LMSCredentials): Promise<LMSConnection>;
  pushGrade(connection: LMSConnection, grade: ExternalGrade): Promise<void>;
  pullGrades(connection: LMSConnection, courseId: string): Promise<ExternalGrade[]>;
  pushCourse(connection: LMSConnection, course: ExternalCourseData): Promise<string>;
  pullEnrollments(connection: LMSConnection, courseId: string): Promise<ExternalEnrollment[]>;
  mapUser(connection: LMSConnection, externalUserId: string): Promise<UserMapping>;
}

export interface SyncResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ gradeId: string; error: string }>;
}
