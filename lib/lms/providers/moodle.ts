/**
 * Moodle LTI 1.3 provider.
 *
 * LTI 1.3 flow:
 * 1. Moodle sends OIDC login initiation → POST /api/lti/login
 * 2. OpenMAIC redirects to Moodle's auth endpoint
 * 3. Moodle redirects back with id_token (JWT) → POST /api/lti/launch
 * 4. OpenMAIC validates JWT (signed by Moodle), creates session, opens course
 * 5. Grades are pushed back via LTI Assignment and Grade Services (AGS)
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

export class MoodleLTIProvider implements LMSProvider {
  id = 'moodle';
  name = 'Moodle (LTI 1.3)';
  type = 'lti' as const;

  async authenticate(credentials: LMSCredentials): Promise<LMSConnection> {
    // For LTI, "authentication" is configuring the platform connection.
    // Real auth happens per-launch via OIDC.
    return {
      providerId: this.id,
      baseUrl: credentials.baseUrl,
      metadata: {
        clientId: credentials.clientId,
        deploymentId: credentials.deploymentId,
      },
    };
  }

  /**
   * Push a grade to Moodle via LTI AGS (Assignment and Grade Services).
   * Endpoint: {lineItem}/scores
   */
  async pushGrade(connection: LMSConnection, grade: ExternalGrade): Promise<void> {
    if (!connection.accessToken) {
      throw new Error('Moodle connection missing AGS access token');
    }

    const lineItemUrl = `${connection.baseUrl}/mod/lti/services.php/CourseSection/${grade.externalCourseId}/lineitems/${grade.externalItemId}/lineitem/scores`;

    const payload = {
      userId: grade.externalUserId,
      scoreGiven: grade.score,
      scoreMaximum: grade.maxScore,
      comment: grade.feedback,
      timestamp: grade.timestamp.toISOString(),
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
    };

    const res = await fetch(lineItemUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.ims.lis.v1.score+json',
        Authorization: `Bearer ${connection.accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Moodle AGS push failed: ${res.status} ${await res.text()}`);
    }
  }

  async pullGrades(_connection: LMSConnection, _courseId: string): Promise<ExternalGrade[]> {
    // Moodle does not typically expose grades over LTI in a pull model.
    // For pulling grades use Moodle Web Services (mod_assign_get_grades).
    throw new Error('pullGrades not supported via LTI; use Moodle Web Services');
  }

  async pushCourse(_connection: LMSConnection, _course: ExternalCourseData): Promise<string> {
    // LTI launches reference a single tool resource per content item.
    // Course creation is done in Moodle UI; OpenMAIC is just the tool.
    throw new Error('pushCourse not applicable: courses live in Moodle, OpenMAIC is the tool');
  }

  async pullEnrollments(connection: LMSConnection, courseId: string): Promise<ExternalEnrollment[]> {
    if (!connection.accessToken) {
      throw new Error('Moodle connection missing NRPS access token');
    }
    // LTI Names and Role Provisioning Service (NRPS)
    const url = `${connection.baseUrl}/mod/lti/services.php/CourseSection/${courseId}/bindings/memberships`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
        Authorization: `Bearer ${connection.accessToken}`,
      },
    });
    if (!res.ok) throw new Error(`NRPS fetch failed: ${res.status}`);
    const data = (await res.json()) as { members?: Array<{ user_id: string; roles: string[] }> };
    return (data.members || []).map((m) => ({
      externalUserId: m.user_id,
      externalCourseId: courseId,
      role: m.roles?.[0] || 'Learner',
      enrolledAt: new Date(),
    }));
  }

  async mapUser(_connection: LMSConnection, externalUserId: string): Promise<UserMapping> {
    return { internalUserId: '', externalUserId, providerId: this.id };
  }
}
