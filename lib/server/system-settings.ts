import { prisma } from '@/lib/auth/prisma';
import type { SystemSettings } from '@prisma/client';

const SETTINGS_CACHE = new Map<string, { data: SystemSettings; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getSystemSettings(): Promise<SystemSettings> {
  const cacheKey = 'system_settings_singleton';
  const now = Date.now();

  // Check cache
  const cached = SETTINGS_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // Fetch from DB or create defaults
  let settings = await prisma.systemSettings.findUnique({
    where: { id: 'singleton' },
  });

  if (!settings) {
    settings = await prisma.systemSettings.create({
      data: { id: 'singleton' },
    });
  }

  // Cache result
  SETTINGS_CACHE.set(cacheKey, {
    data: settings,
    expiresAt: now + CACHE_TTL,
  });

  return settings;
}

export async function updateSystemSettings(
  updates: Partial<Omit<SystemSettings, 'id' | 'createdAt' | 'version'>>
): Promise<SystemSettings> {
  const settings = await prisma.systemSettings.update({
    where: { id: 'singleton' },
    data: {
      ...updates,
      version: { increment: 1 },
    },
  });

  // Invalidate cache
  SETTINGS_CACHE.delete('system_settings_singleton');

  return settings;
}

export async function resetSystemSettings(): Promise<SystemSettings> {
  return await prisma.systemSettings.update({
    where: { id: 'singleton' },
    data: {
      appName: 'MU-OpenMAIC',
      defaultLanguage: 'en',
      timezone: 'UTC',
      passwordMinLength: 10,
      passwordRequireUppercase: true,
      passwordRequireLowercase: true,
      passwordRequireNumbers: true,
      passwordRequireSpecial: true,
      sessionTimeoutMinutes: 60,
      maxFailedLoginAttempts: 5,
      accountLockoutMinutes: 15,
      pdpaConsentRequired: true,
      defaultLlmProvider: 'openai',
      defaultLlmModel: 'gpt-4o-mini',
      llmRateLimitPerMinute: 60,
      llmTokenLimitPerRequest: 4000,
      llmTemperature: 0.7,
      llmTopP: 1.0,
      maxStudentsPerClassroom: 100,
      defaultGradingScale: '0-100',
      quizTimeoutMinutes: 60,
      maxFileUploadMb: 50,
      scenesPerClassroomQuota: 50,
      smtpPort: 587,
      welcomeEmailEnabled: true,
      gradeNotificationsEnabled: true,
      maxStoragePerUserMb: 1000,
      maxStoragePerClassroomMb: 5000,
      auditLogRetentionDays: 365,
      userDataExportEnabled: true,
      accountDeletionGraceDaysDays: 30,
      logLevel: 'info',
    },
  });
}
