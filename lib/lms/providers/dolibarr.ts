/**
 * Dolibarr provider.
 *
 * Dolibarr exposes a REST API at {baseUrl}/api/index.php authenticated with
 * the DOLAPIKEY header. Used here to push learning results to HR records.
 */
import type {
  LMSProvider,
  LMSConnection,
  LMSCredentials,
  ExternalGrade,
  ExternalCourseData,
  ExternalEnrollment,
  UserMapping,
} from '@/lib/lms/types';

async function dolibarrRequest<T>(
  connection: LMSConnection,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = (connection.metadata?.apiKey as string) || connection.accessToken;
  if (!apiKey) throw new Error('Dolibarr connection missing API key');

  const res = await fetch(`${connection.baseUrl}/api/index.php${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      DOLAPIKEY: apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Dolibarr ${method} ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export class DolibarrProvider implements LMSProvider {
  id = 'dolibarr';
  name = 'Dolibarr';
  type = 'rest' as const;

  async authenticate(credentials: LMSCredentials): Promise<LMSConnection> {
    if (!credentials.apiKey) throw new Error('Dolibarr requires an API key');

    // Validate by hitting a lightweight endpoint
    const connection: LMSConnection = {
      providerId: this.id,
      baseUrl: credentials.baseUrl,
      accessToken: credentials.apiKey,
      metadata: { apiKey: credentials.apiKey },
    };
    await dolibarrRequest<unknown>(connection, 'GET', '/status');
    return connection;
  }

  async pushGrade(connection: LMSConnection, grade: ExternalGrade): Promise<void> {
    // Push as a custom HR training record. The exact endpoint depends on the
    // Dolibarr modules enabled (Training/HRM module). This is a generic shape.
    await dolibarrRequest<unknown>(connection, 'POST', '/hrm/skills/add', {
      fk_user: grade.externalUserId,
      fk_skill: grade.externalItemId,
      score: grade.score,
      score_max: grade.maxScore,
      note: grade.feedback,
      date: grade.timestamp.toISOString().split('T')[0],
    });
  }

  async pullGrades(_connection: LMSConnection, _courseId: string): Promise<ExternalGrade[]> {
    // Dolibarr doesn't track per-course grades natively; this would query
    // the custom HR training table if installed.
    return [];
  }

  async pushCourse(_connection: LMSConnection, _course: ExternalCourseData): Promise<string> {
    throw new Error('pushCourse not supported by Dolibarr provider');
  }

  async pullEnrollments(connection: LMSConnection, _courseId: string): Promise<ExternalEnrollment[]> {
    // Pull all employees as potential learners
    const employees = await dolibarrRequest<Array<{ id: string; firstname: string }>>(
      connection,
      'GET',
      '/users',
    );
    return employees.map((e) => ({
      externalUserId: e.id,
      externalCourseId: _courseId,
      role: 'Learner',
      enrolledAt: new Date(),
    }));
  }

  async mapUser(_connection: LMSConnection, externalUserId: string): Promise<UserMapping> {
    return { internalUserId: '', externalUserId, providerId: this.id };
  }
}
