'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';

interface ClassroomPayload {
  classroom: {
    id: string;
    stage: {
      name?: string;
      description?: string;
      language?: string;
      ownerUserId?: string;
      updatedAt: string;
    };
  };
}

export default function InstructorSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { t } = useI18n();
  const classroomId = params.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'en' | 'zh-CN' | 'th-TH'>('en');

  const [confirmStep, setConfirmStep] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const fetchClassroom = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as ClassroomPayload;
      setTitle(data.classroom.stage.name || '');
      setDescription(data.classroom.stage.description || '');
      setLanguage((data.classroom.stage.language as 'en' | 'zh-CN' | 'th-TH') || 'en');
    } catch {
      toast.error(t('instructorClassroomSettings.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [classroomId, t]);

  useEffect(() => {
    void fetchClassroom();
  }, [fetchClassroom]);

  const handleSave = async () => {
    if (!title.trim()) {
      toast.error(t('instructorClassroomSettings.titleRequired'));
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/classroom', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: classroomId,
          title: title.trim(),
          description: description.trim(),
          language,
        }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? t('instructorClassroomSettings.saveFailed'));
        return;
      }

      toast.success(t('instructorClassroomSettings.updated'));
      await fetchClassroom();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (confirmText !== classroomId) {
      toast.error(t('instructorClassroomSettings.idMismatch'));
      return;
    }

    setDeleting(true);
    try {
      const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? t('instructorClassroomSettings.deleteFailed'));
        return;
      }

      toast.success(t('instructorClassroomSettings.deleted'));
      router.push('/instructor/classrooms');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-white/10 bg-white/5 p-6 space-y-4">
        <h2 className="text-lg font-semibold text-white">{t('instructorClassroomSettings.title')}</h2>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-200">
            {t('instructorClassroomSettings.fields.title')} <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-200">{t('instructorClassroomSettings.fields.description')}</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={4}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none resize-none"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-200">{t('instructorClassroomSettings.fields.language')}</label>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as 'en' | 'zh-CN' | 'th-TH')}
            className="rounded-lg border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
          >
            <option value="en">{t('instructorClassroomSettings.languages.en')}</option>
            <option value="zh-CN">{t('instructorClassroomSettings.languages.zhCN')}</option>
            <option value="th-TH">{t('instructorClassroomSettings.languages.thTH')}</option>
          </select>
        </div>

        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-60"
        >
          {saving ? t('instructorClassroomSettings.saving') : t('instructorClassroomSettings.saveChanges')}
        </button>
      </section>

      <section className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 space-y-4">
        <h3 className="text-base font-semibold text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {t('instructorClassroomSettings.dangerZone')}
        </h3>

        {!confirmStep ? (
          <button
            type="button"
            onClick={() => setConfirmStep(true)}
            className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20 transition-colors"
          >
            {t('instructorClassroomSettings.deleteClassroom')}
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-200">
              {t('instructorClassroomSettings.typeClassroomId')} <span className="font-mono">{classroomId}</span> {t('instructorClassroomSettings.toConfirmDeletion')}
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-2 text-sm text-white placeholder-red-300/40 focus:border-red-400 focus:outline-none"
              placeholder={t('instructorClassroomSettings.classroomIdPlaceholder')}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={deleting || confirmText !== classroomId}
                onClick={() => void handleDelete()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {deleting ? t('instructorClassroomSettings.deleting') : t('instructorClassroomSettings.confirmDelete')}
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => { setConfirmStep(false); setConfirmText(''); }}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/10 transition-colors"
              >
                {t('instructorClassroomSettings.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
