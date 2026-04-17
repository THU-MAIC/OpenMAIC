import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/auth';
import { hasServerPermission } from '@/lib/auth/helpers';
import { getSystemSettings, updateSystemSettings } from '@/lib/server/system-settings';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    const settings = await getSystemSettings();
    return apiSuccess(settings);
  } catch (e) {
    console.error('Failed to get system settings:', e);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to fetch settings');
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, 'Unauthorized');
    }

    const canManage = await hasServerPermission('manage_system_config');
    if (!canManage) {
      return apiError(API_ERROR_CODES.FORBIDDEN, 403, 'Forbidden');
    }

    const body = await req.json();
    
    // Whitelist of allowed fields to update (security: prevent id/version tampering)
    const allowedFields = [
      'appName',
      'appLogo',
      'defaultLanguage',
      'timezone',
      'helpUrl',
      'termsUrl',
      'privacyUrl',
      'passwordMinLength',
      'passwordRequireUppercase',
      'passwordRequireLowercase',
      'passwordRequireNumbers',
      'passwordRequireSpecial',
      'sessionTimeoutMinutes',
      'maxFailedLoginAttempts',
      'accountLockoutMinutes',
      'pdpaConsentRequired',
      'googleOAuthEnabled',
      'githubOAuthEnabled',
      'defaultLlmProvider',
      'defaultLlmModel',
      'llmRateLimitPerMinute',
      'llmTokenLimitPerRequest',
      'llmTemperature',
      'llmTopP',
      'maxStudentsPerClassroom',
      'defaultGradingScale',
      'quizTimeoutMinutes',
      'maxFileUploadMb',
      'scenesPerClassroomQuota',
      'autoEnrollStudents',
      'smtpEnabled',
      'smtpHost',
      'smtpPort',
      'smtpSecure',
      'smtpUser',
      'smtpFrom',
      'welcomeEmailEnabled',
      'gradeNotificationsEnabled',
      'maxStoragePerUserMb',
      'maxStoragePerClassroomMb',
      'allowedFileTypes',
      'autoCleanupDaysOld',
      'auditLogRetentionDays',
      'userDataExportEnabled',
      'accountDeletionGraceDaysDays',
      'anonymizeOldLogs',
      'logLevel',
      'errorReportingEnabled',
      'errorReportingUrl',
    ];

    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowedFields.includes(key)) {
        updates[key] = value;
      }
    }

    const settings = await updateSystemSettings(updates as any);
    return apiSuccess(settings);
  } catch (e) {
    console.error('Failed to update system settings:', e);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to update settings');
  }
}
