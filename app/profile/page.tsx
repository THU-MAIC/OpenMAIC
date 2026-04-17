'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import {
  User,
  Shield,
  Download,
  Trash2,
  KeyRound,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useI18n } from '@/lib/hooks/use-i18n';

interface UserProfile {
  id: string;
  name: string | null;
  email: string;
  studentId: string | null;
  bio: string | null;
  image: string | null;
  role: 'ADMIN' | 'INSTRUCTOR' | 'STUDENT';
  consentGiven: boolean;
  consentAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export default function ProfilePage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ bio: '' });
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    fetch('/api/user/profile')
      .then((r) => r.json())
      .then((d) => {
        setProfile(d.user);
        setForm({ bio: d.user?.bio ?? '' });
      })
      .finally(() => setLoading(false));
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bio: form.bio.trim() }),
    });
    setSaving(false);
    setSaveMsg(res.ok ? t('profilePage.saveSuccess') : t('profilePage.saveFailed'));
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (pwForm.newPassword !== pwForm.confirm) {
      setPwError(t('profilePage.pwMismatch'));
      return;
    }
    if (pwForm.newPassword.length < 10) {
      setPwError(t('profilePage.pwTooShort'));
      return;
    }
    const res = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
    });
    const data = await res.json();
    if (!res.ok) setPwError(data.error ?? t('profilePage.pwChangeFailed'));
    else { setPwSuccess(true); setPwForm({ currentPassword: '', newPassword: '', confirm: '' }); }
  }

  async function exportData() {
    const res = await fetch('/api/user/data-export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openmaic-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAccount() {
    setDeletingAccount(true);
    await fetch('/api/user/delete-account', { method: 'DELETE' });
    await signOut({ callbackUrl: '/auth/signin' });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('profilePage.title')}</h1>
          <Link href="/" className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white text-sm">{t('profilePage.back')}</Link>
        </div>

        <section className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-6">
          <h2 className="text-slate-900 dark:text-white font-semibold mb-4 flex items-center gap-2">
            <User className="w-4 h-4 text-slate-500 dark:text-slate-400" /> {t('profilePage.profileInfo')}
          </h2>
          <form onSubmit={saveProfile} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">{t('profilePage.fullName')}</label>
              <input value={profile?.name ?? '—'} readOnly
                className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 text-sm cursor-not-allowed" />
            </div>
            <div>
              <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">{t('profilePage.bio')}</label>
              <textarea value={form.bio} onChange={(e) => setForm(f => ({ ...f, bio: e.target.value }))} rows={3}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none" />
            </div>
            <div className="flex items-center justify-between">
              {saveMsg && (
                <p className="text-sm text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> {saveMsg}
                </p>
              )}
              <Button type="submit" disabled={saving} className="ml-auto bg-purple-600 hover:bg-purple-700 text-white">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('profilePage.saveChanges')}
              </Button>
            </div>
          </form>

          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-white/5 text-xs text-slate-500 dark:text-slate-500 space-y-1">
            <p>{t('profilePage.email')}: <span className="text-slate-700 dark:text-slate-300">{profile?.email}</span></p>
            <p>{t('profilePage.studentId')}: <span className="text-slate-700 dark:text-slate-300">{profile?.studentId ?? '—'}</span></p>
            <p>{t('profilePage.role')}: <span className="text-slate-700 dark:text-slate-300">{profile?.role}</span></p>
            <p>{t('profilePage.memberSince')}: <span className="text-slate-700 dark:text-slate-300">{profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'}</span></p>
            <p>{t('profilePage.lastLogin')}: <span className="text-slate-700 dark:text-slate-300">{profile?.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString() : '—'}</span></p>
          </div>
        </section>

        {session?.user && (
          <section className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-6">
            <h2 className="text-slate-900 dark:text-white font-semibold mb-4 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-500 dark:text-slate-400" /> {t('profilePage.changePassword')}
            </h2>
            <form onSubmit={changePassword} className="space-y-4">
              {['currentPassword', 'newPassword', 'confirm'].map((field) => (
                <div key={field}>
                  <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">
                    {field === 'currentPassword' ? t('profilePage.currentPassword') : field === 'newPassword' ? t('profilePage.newPassword') : t('profilePage.confirmPassword')}
                  </label>
                  <input type="password" value={pwForm[field as keyof typeof pwForm]}
                    onChange={(e) => setPwForm(f => ({ ...f, [field]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-500" />
                </div>
              ))}
              {pwError && <p className="text-red-500 dark:text-red-400 text-sm">{pwError}</p>}
              {pwSuccess && <p className="text-emerald-600 dark:text-emerald-400 text-sm flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> {t('profilePage.pwChangeSuccess')}</p>}
              <Button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white">{t('profilePage.updatePassword')}</Button>
            </form>
          </section>
        )}

        <section className="bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl p-6">
          <h2 className="text-slate-900 dark:text-white font-semibold mb-4 flex items-center gap-2">
            <Shield className="w-4 h-4 text-purple-500 dark:text-purple-400" /> {t('profilePage.privacyTitle')}
          </h2>
          <div className="space-y-4">
            <div className="text-sm text-slate-500 dark:text-slate-400">
              <p>{t('profilePage.consentGiven')}: <span className="text-slate-800 dark:text-white">{profile?.consentGiven ? `${t('profilePage.consentYes')} — ${profile.consentAt ? new Date(profile.consentAt).toLocaleDateString() : ''}` : t('profilePage.consentNo')}</span></p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <Button onClick={exportData} variant="outline" className="flex items-center gap-2 border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
                <Download className="w-4 h-4" /> {t('profilePage.exportData')}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-2 border-red-300 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:border-red-400"
              >
                <Trash2 className="w-4 h-4" /> {t('profilePage.deleteAccount')}
              </Button>
            </div>

            <p className="text-xs text-slate-400 dark:text-slate-500">
              {t('profilePage.pdpaNotice')}
            </p>
          </div>
        </section>

        {/* Delete account confirmation */}
        {showDeleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-slate-800 dark:bg-slate-800 border border-red-500/30 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                <h3 className="text-white font-semibold">{t('profilePage.anonymizeTitle')}</h3>
              </div>
              <p className="text-slate-400 text-sm mb-6">
                {t('profilePage.anonymizeDesc')}
              </p>
              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} className="flex-1 border-white/10 text-slate-300">
                  {t('profilePage.cancel')}
                </Button>
                <Button onClick={deleteAccount} disabled={deletingAccount} className="flex-1 bg-red-600 hover:bg-red-700 text-white">
                  {deletingAccount ? <Loader2 className="w-4 h-4 animate-spin" /> : t('profilePage.confirmAnonymize')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
