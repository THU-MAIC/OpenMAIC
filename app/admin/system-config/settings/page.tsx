'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Save, AlertCircle, CheckCircle2, Box } from 'lucide-react';
import { toast } from 'sonner';
import type { SystemSettings } from '@prisma/client';
import { SettingsDialog } from '@/components/settings';
import type { SettingsSection as LegacySettingsSection } from '@/lib/types/settings';
import { PROVIDERS } from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/types/provider';
import { useI18n } from '@/lib/hooks/use-i18n';

interface FieldOption {
  value: string;
  label: string;
}

interface SystemSettingsSection {
  title: string;
  description: string;
  fields: Array<{
    key: keyof Omit<SystemSettings, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
    label: string;
    type: 'text' | 'number' | 'boolean' | 'email' | 'url' | 'select';
    placeholder?: string;
    help?: string;
    options?: FieldOption[];
  }>;
}

interface ModelRuntimeDefaults {
  llmRateLimitPerMinute: number;
  llmTokenLimitPerRequest: number;
  llmTemperature: number;
  llmTopP: number;
}

function getModelRuntimeDefaults(providerId: string, modelId: string): ModelRuntimeDefaults {
  const fallback: ModelRuntimeDefaults = {
    llmRateLimitPerMinute: 60,
    llmTokenLimitPerRequest: 4000,
    llmTemperature: 0.7,
    llmTopP: 1,
  };

  const provider = PROVIDERS[providerId as ProviderId];
  const model = provider?.models.find((m) => m.id === modelId);
  if (!model) return fallback;
  const outputWindow = typeof model.outputWindow === 'number' ? model.outputWindow : 0;

  const isThinkingDefault = Boolean(model.capabilities?.thinking?.defaultEnabled);
  const isReasoningModel = /reason|thinking|o[1-4]|gpt-5|claude-opus|claude-sonnet/i.test(model.id);

  return {
    llmRateLimitPerMinute: fallback.llmRateLimitPerMinute,
    llmTokenLimitPerRequest: outputWindow > 0 ? Math.min(outputWindow, 32000) : fallback.llmTokenLimitPerRequest,
    llmTemperature: isThinkingDefault || isReasoningModel ? 0.2 : fallback.llmTemperature,
    llmTopP: fallback.llmTopP,
  };
}

const SECTIONS: SystemSettingsSection[] = [
  {
    title: 'App & Branding',
    description: 'Configure app name, branding, and user-facing URLs',
    fields: [
      { key: 'appName', label: 'App Name', type: 'text', placeholder: 'MU-OpenMAIC' },
      { key: 'appLogo', label: 'Logo URL', type: 'url', placeholder: 'https://example.com/logo.png' },
      { key: 'defaultLanguage', label: 'Default Language', type: 'text', placeholder: 'en' },
      { key: 'timezone', label: 'Timezone', type: 'text', placeholder: 'UTC' },
      { key: 'helpUrl', label: 'Help URL', type: 'url' },
      { key: 'termsUrl', label: 'Terms of Service URL', type: 'url' },
      { key: 'privacyUrl', label: 'Privacy Policy URL', type: 'url' },
    ],
  },
  {
    title: 'Authentication & Security',
    description: 'Configure password requirements and session management',
    fields: [
      { key: 'passwordMinLength', label: 'Min Password Length', type: 'number' },
      { key: 'passwordRequireUppercase', label: 'Require Uppercase', type: 'boolean' },
      { key: 'passwordRequireLowercase', label: 'Require Lowercase', type: 'boolean' },
      { key: 'passwordRequireNumbers', label: 'Require Numbers', type: 'boolean' },
      { key: 'passwordRequireSpecial', label: 'Require Special Characters', type: 'boolean' },
      { key: 'sessionTimeoutMinutes', label: 'Session Timeout (minutes)', type: 'number' },
      { key: 'maxFailedLoginAttempts', label: 'Max Failed Attempts', type: 'number' },
      { key: 'accountLockoutMinutes', label: 'Account Lockout Duration (minutes)', type: 'number' },
      { key: 'pdpaConsentRequired', label: 'Require PDPA Consent', type: 'boolean' },
      { key: 'googleOAuthEnabled', label: 'Enable Google OAuth', type: 'boolean' },
      { key: 'githubOAuthEnabled', label: 'Enable GitHub OAuth', type: 'boolean' },
    ],
  },
  {
    title: 'AI/LLM Configuration',
    description: 'Configure default LLM model and behavior',
    fields: [
      {
        key: 'defaultLlmProvider',
        label: 'Default Provider',
        type: 'select',
        options: [
          { value: 'openai', label: 'OpenAI' },
          { value: 'anthropic', label: 'Anthropic' },
          { value: 'google', label: 'Google Gemini' },
          { value: 'deepseek', label: 'DeepSeek' },
          { value: 'qwen', label: 'Qwen (Alibaba)' },
          { value: 'kimi', label: 'Kimi (Moonshot)' },
          { value: 'minimax', label: 'MiniMax' },
          { value: 'glm', label: 'GLM (Zhipu)' },
          { value: 'siliconflow', label: 'SiliconFlow' },
          { value: 'doubao', label: 'Doubao (ByteDance)' },
          { value: 'grok', label: 'Grok (xAI)' },
        ],
      },
      { key: 'defaultLlmModel', label: 'Default Model', type: 'select' },
      { key: 'llmRateLimitPerMinute', label: 'Rate Limit (requests/min)', type: 'number' },
      { key: 'llmTokenLimitPerRequest', label: 'Token Limit per Request', type: 'number' },
      { key: 'llmTemperature', label: 'Temperature', type: 'number' },
      { key: 'llmTopP', label: 'Top P', type: 'number' },
    ],
  },
  {
    title: 'Classroom Defaults',
    description: 'Set default limits and behaviors for classrooms',
    fields: [
      { key: 'maxStudentsPerClassroom', label: 'Max Students per Classroom', type: 'number' },
      { key: 'defaultGradingScale', label: 'Default Grading Scale', type: 'text', placeholder: '0-100' },
      { key: 'quizTimeoutMinutes', label: 'Quiz Timeout (minutes)', type: 'number' },
      { key: 'maxFileUploadMb', label: 'Max File Upload (MB)', type: 'number' },
      { key: 'scenesPerClassroomQuota', label: 'Scenes per Classroom Quota', type: 'number' },
      { key: 'autoEnrollStudents', label: 'Auto-enroll Students', type: 'boolean' },
    ],
  },
  {
    title: 'Email & SMTP',
    description: 'Configure email sending for notifications',
    fields: [
      { key: 'smtpEnabled', label: 'Enable SMTP', type: 'boolean' },
      { key: 'smtpHost', label: 'SMTP Host', type: 'text', placeholder: 'mail.example.com' },
      { key: 'smtpPort', label: 'SMTP Port', type: 'number' },
      { key: 'smtpSecure', label: 'Use SSL (port 465)', type: 'boolean' },
      { key: 'smtpUser', label: 'SMTP Username', type: 'text' },
      { key: 'smtpFrom', label: 'Sender Email', type: 'email', placeholder: 'noreply@example.com' },
      { key: 'welcomeEmailEnabled', label: 'Send Welcome Emails', type: 'boolean' },
      { key: 'gradeNotificationsEnabled', label: 'Send Grade Notifications', type: 'boolean' },
    ],
  },
  {
    title: 'Storage & Files',
    description: 'Configure file upload and storage limits',
    fields: [
      { key: 'maxStoragePerUserMb', label: 'Max Storage per User (MB)', type: 'number' },
      { key: 'maxStoragePerClassroomMb', label: 'Max Storage per Classroom (MB)', type: 'number' },
      { key: 'allowedFileTypes', label: 'Allowed File Types (comma-separated)', type: 'text', placeholder: '.pdf,.doc,.docx,.xls,.xlsx,.pptx,.jpg,.png,.mp4' },
      { key: 'autoCleanupDaysOld', label: 'Auto-cleanup Files Older Than (days)', type: 'number' },
    ],
  },
  {
    title: 'Data & Privacy',
    description: 'Configure data retention and privacy settings',
    fields: [
      { key: 'auditLogRetentionDays', label: 'Audit Log Retention (days)', type: 'number' },
      { key: 'userDataExportEnabled', label: 'Allow User Data Export', type: 'boolean' },
      { key: 'accountDeletionGraceDaysDays', label: 'Account Deletion Grace Period (days)', type: 'number' },
      { key: 'anonymizeOldLogs', label: 'Anonymize Old Logs', type: 'boolean' },
    ],
  },
  {
    title: 'Logging & Monitoring',
    description: 'Configure logging and error reporting',
    fields: [
      { key: 'logLevel', label: 'Log Level', type: 'text', placeholder: 'info' },
      { key: 'errorReportingEnabled', label: 'Enable Error Reporting', type: 'boolean' },
      { key: 'errorReportingUrl', label: 'Error Reporting URL', type: 'url', placeholder: 'https://sentry.io/...' },
    ],
  },
];

export default function AdminSettingsPage() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [legacyLlmManagerOpen, setLegacyLlmManagerOpen] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/system-config/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      const data = (await res.json()) as SystemSettings;
      setSettings(data);
      setChanges({});
      setSaved(false);
    } catch (e) {
      console.error(e);
      toast.error(t('adminSettings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const handleChange = (key: string, value: unknown) => {
    if (key === 'defaultLlmModel') {
      const providerId = String(
        changes.defaultLlmProvider ?? settings?.defaultLlmProvider ?? 'openai'
      );
      const modelDefaults = getModelRuntimeDefaults(providerId, String(value));
      setChanges({
        ...changes,
        [key]: value,
        ...modelDefaults,
      });
      setSaved(false);
      return;
    }

    setChanges({ ...changes, [key]: value });
    setSaved(false);
  };

  const handleSave = async () => {
    if (Object.keys(changes).length === 0) {
      toast.info(t('adminSettings.noChanges'));
      return;
    }

    try {
      setSaving(true);
      const res = await fetch('/api/admin/system-config/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      });

      if (!res.ok) throw new Error('Failed to save settings');
      const data = (await res.json()) as SystemSettings;
      setSettings(data);
      setChanges({});
      setSaved(true);
      toast.success(t('adminSettings.savedSuccess'));
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      console.error(e);
      toast.error(t('adminSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (!settings) {
    return <div className="text-center text-red-500 dark:text-red-400">{t('adminSettings.loadFailed')}</div>;
  }

  const getFieldValue = (key: string): unknown => {
    return changes[key] !== undefined ? changes[key] : settings[key as keyof SystemSettings];
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('adminSettings.title')}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('adminSettings.subtitle')}</p>
      </div>

      {Object.keys(changes).length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-yellow-500/20 bg-yellow-50 dark:bg-yellow-500/10 p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-500 dark:text-yellow-400" />
            <span className="text-sm text-yellow-700 dark:text-yellow-200">{Object.keys(changes).length} {t('adminSettings.changesNotice')}</span>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 dark:disabled:bg-slate-600 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('adminSettings.saving')}
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                {t('adminSettings.save')}
              </>
            )}
          </button>
        </div>
      )}

      {saved && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-50 dark:bg-emerald-500/10 p-4 text-emerald-700 dark:text-emerald-200">
          <CheckCircle2 className="w-5 h-5" />
          <span className="text-sm">{t('adminSettings.allSaved')}</span>
        </div>
      )}

      <div className="space-y-8">
        {SECTIONS.map((section) => (
          <div key={section.title} className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 p-6">
            <h2 className="mb-1 text-lg font-semibold text-slate-900 dark:text-white">{section.title}</h2>
            <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">{section.description}</p>

            {section.title === 'AI/LLM Configuration' && (
              <div className="mb-6 rounded-xl border border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/10 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-indigo-700 dark:text-indigo-200">{t('adminSettings.providerManagerTitle')}</p>
                    <p className="mt-1 text-xs text-indigo-600/80 dark:text-indigo-100/80">
                      {t('adminSettings.providerManagerDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLegacyLlmManagerOpen(true)}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-indigo-400/40 bg-indigo-100 dark:bg-indigo-500/20 px-3 py-2 text-sm font-medium text-indigo-700 dark:text-indigo-100 transition-colors hover:bg-indigo-200 dark:hover:bg-indigo-500/30"
                  >
                    <Box className="h-4 w-4" />
                    {t('adminSettings.openProviderManager')}
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {section.fields.map((field) => {
                const value = getFieldValue(field.key as string);
                const isChanged = field.key in changes;

                if (field.type === 'boolean') {
                  return (
                    <div key={field.key} className="space-y-2">
                      <label className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={value as boolean}
                          onChange={(e) => handleChange(field.key as string, e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 dark:border-white/20 bg-slate-100 dark:bg-white/10 text-indigo-600"
                        />
                        <span className={`text-sm font-medium ${isChanged ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'}`}>
                          {field.label}
                        </span>
                      </label>
                      {field.help && <p className="text-xs text-slate-400 dark:text-slate-500">{field.help}</p>}
                    </div>
                  );
                }

                if (field.key === 'defaultLlmModel') {
                  const currentProvider = (getFieldValue('defaultLlmProvider') as string) || 'openai';
                  const providerModels = PROVIDERS[currentProvider as ProviderId]?.models ?? [];
                  return (
                    <div key={field.key} className="space-y-2">
                      <label className={`block text-sm font-medium ${isChanged ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'}`}>
                        {field.label}
                      </label>
                      <select
                        value={String(value ?? '')}
                        onChange={(e) => handleChange(field.key as string, e.target.value)}
                        className={`w-full rounded-lg border ${isChanged ? 'border-indigo-500/50' : 'border-slate-200 dark:border-white/10'} bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500`}
                      >
                        {providerModels.length === 0 ? (
                          <option value="">No models available</option>
                        ) : (
                          providerModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))
                        )}
                      </select>
                      {field.help && <p className="text-xs text-slate-400 dark:text-slate-500">{field.help}</p>}
                    </div>
                  );
                }

                if (field.type === 'select' && field.options) {
                  return (
                    <div key={field.key} className="space-y-2">
                      <label className={`block text-sm font-medium ${isChanged ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'}`}>
                        {field.label}
                      </label>
                      <select
                        value={String(value ?? '')}
                        onChange={(e) => handleChange(field.key as string, e.target.value)}
                        className={`w-full rounded-lg border ${isChanged ? 'border-indigo-500/50' : 'border-slate-200 dark:border-white/10'} bg-white dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500`}
                      >
                        {field.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      {field.help && <p className="text-xs text-slate-400 dark:text-slate-500">{field.help}</p>}
                    </div>
                  );
                }

                return (
                  <div key={field.key} className="space-y-2">
                    <label className={`block text-sm font-medium ${isChanged ? 'text-indigo-600 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-300'}`}>
                      {field.label}
                    </label>
                    <input
                      type={field.type}
                      value={String(value ?? '')}
                      onChange={(e) =>
                        handleChange(
                          field.key as string,
                          field.type === 'number' ? (e.target.value ? parseFloat(e.target.value) : 0) : e.target.value
                        )
                      }
                      placeholder={field.placeholder}
                      className={`w-full rounded-lg border ${isChanged ? 'border-indigo-500/50' : 'border-slate-200 dark:border-white/10'} bg-slate-50 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500`}
                    />
                    {field.help && <p className="text-xs text-slate-400 dark:text-slate-500">{field.help}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <SettingsDialog
        open={legacyLlmManagerOpen}
        onOpenChange={setLegacyLlmManagerOpen}
        initialSection={'providers' as LegacySettingsSection}
      />
    </div>
  );
}
