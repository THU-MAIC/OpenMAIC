/**
 * Odoo LMS provider.
 *
 * Uses Odoo's JSON-RPC 2.0 web API. The Odoo LMS module exposes models like:
 *  - slide.channel: courses
 *  - slide.channel.partner: enrollments
 *  - slide.slide: lessons
 *  - slide.slide.partner: completion records
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

interface OdooRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function odooRpc<T>(
  baseUrl: string,
  endpoint: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Cookie'] = `session_id=${sessionId}`;

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params, id: Date.now() }),
  });
  if (!res.ok) throw new Error(`Odoo RPC HTTP ${res.status}`);
  const data = (await res.json()) as OdooRpcResponse<T>;
  if (data.error) throw new Error(`Odoo RPC error: ${data.error.message}`);
  return data.result as T;
}

export class OdooLMSProvider implements LMSProvider {
  id = 'odoo';
  name = 'Odoo LMS';
  type = 'rest' as const;

  async authenticate(credentials: LMSCredentials): Promise<LMSConnection> {
    const result = await odooRpc<{ uid: number; session_id?: string }>(
      credentials.baseUrl,
      '/web/session/authenticate',
      {
        db: credentials.db || 'odoo',
        login: credentials.username,
        password: credentials.password,
      },
    );
    if (!result.uid) throw new Error('Odoo authentication failed');

    return {
      providerId: this.id,
      baseUrl: credentials.baseUrl,
      accessToken: result.session_id,
      metadata: { uid: result.uid, db: credentials.db },
    };
  }

  async pushGrade(connection: LMSConnection, grade: ExternalGrade): Promise<void> {
    // In Odoo LMS, "grading" maps to slide completion + survey scoring
    await odooRpc<unknown>(
      connection.baseUrl,
      '/web/dataset/call_kw',
      {
        model: 'slide.slide.partner',
        method: 'create',
        args: [
          {
            slide_id: parseInt(grade.externalItemId, 10),
            partner_id: parseInt(grade.externalUserId, 10),
            completed: true,
            quiz_attempts_count: 1,
          },
        ],
        kwargs: {},
      },
      connection.accessToken,
    );
  }

  async pullGrades(connection: LMSConnection, courseId: string): Promise<ExternalGrade[]> {
    const records = await odooRpc<Array<Record<string, unknown>>>(
      connection.baseUrl,
      '/web/dataset/call_kw',
      {
        model: 'slide.slide.partner',
        method: 'search_read',
        args: [[['channel_id', '=', parseInt(courseId, 10)], ['completed', '=', true]]],
        kwargs: { fields: ['partner_id', 'slide_id', 'write_date'] },
      },
      connection.accessToken,
    );
    return records.map((r) => ({
      externalUserId: String((r.partner_id as [number, string])[0]),
      externalCourseId: courseId,
      externalItemId: String((r.slide_id as [number, string])[0]),
      score: 100,
      maxScore: 100,
      timestamp: new Date(r.write_date as string),
    }));
  }

  async pushCourse(connection: LMSConnection, course: ExternalCourseData): Promise<string> {
    const id = await odooRpc<number>(
      connection.baseUrl,
      '/web/dataset/call_kw',
      {
        model: 'slide.channel',
        method: 'create',
        args: [{ name: course.title, description: course.description || '' }],
        kwargs: {},
      },
      connection.accessToken,
    );
    return String(id);
  }

  async pullEnrollments(connection: LMSConnection, courseId: string): Promise<ExternalEnrollment[]> {
    const records = await odooRpc<Array<Record<string, unknown>>>(
      connection.baseUrl,
      '/web/dataset/call_kw',
      {
        model: 'slide.channel.partner',
        method: 'search_read',
        args: [[['channel_id', '=', parseInt(courseId, 10)]]],
        kwargs: { fields: ['partner_id', 'create_date'] },
      },
      connection.accessToken,
    );
    return records.map((r) => ({
      externalUserId: String((r.partner_id as [number, string])[0]),
      externalCourseId: courseId,
      role: 'Learner',
      enrolledAt: new Date(r.create_date as string),
    }));
  }

  async mapUser(_connection: LMSConnection, externalUserId: string): Promise<UserMapping> {
    return { internalUserId: '', externalUserId, providerId: this.id };
  }
}
