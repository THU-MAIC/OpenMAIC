'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { GraduationCap, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])/;

export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch('/api/setup')
      .then((r) => r.json())
      .then((d) => {
        if (d.completed) {
          setAlreadyDone(true);
          router.replace('/auth/signin');
        }
      })
      .finally(() => setChecking(false));
  }, [router]);

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Name is required.';
    if (!form.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) e.email = 'Valid email required.';
    if (form.password.length < PASSWORD_MIN_LENGTH)
      e.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    if (!PASSWORD_REGEX.test(form.password))
      e.password =
        'Password must contain uppercase, lowercase, number, and special character (@$!%*?&_-#).';
    if (form.password !== form.confirm) e.confirm = 'Passwords do not match.';
    return e;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSubmitting(true);
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name.trim(), email: form.email.trim(), password: form.password }),
    });
    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      setErrors({ submit: data.error ?? 'Setup failed. Please try again.' });
    } else {
      setDone(true);
      setTimeout(() => router.push('/auth/signin'), 2000);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </div>
    );
  }

  if (alreadyDone) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-600 mb-4 shadow-lg shadow-purple-900/40">
            <GraduationCap className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">MU-OpenMAIC</h1>
          <p className="text-slate-400 text-sm mt-1">First-time setup</p>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-8 backdrop-blur-sm shadow-xl">
          {done ? (
            <div className="flex flex-col items-center gap-4 py-6">
              <CheckCircle2 className="w-12 h-12 text-emerald-400" />
              <p className="text-white font-semibold text-lg">Admin account created!</p>
              <p className="text-slate-400 text-sm">Redirecting to sign in…</p>
            </div>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-white mb-2">Create admin account</h2>
              <p className="text-slate-400 text-sm mb-6">
                This is the first run. Set up the system administrator account to get started.
              </p>

              {errors.submit && (
                <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  {errors.submit}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <Field
                  label="Full name"
                  type="text"
                  value={form.name}
                  onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                  error={errors.name}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                />
                <Field
                  label="Email address"
                  type="email"
                  value={form.email}
                  onChange={(v) => setForm((f) => ({ ...f, email: v }))}
                  error={errors.email}
                  placeholder="admin@school.ac.th"
                  autoComplete="email"
                />
                <Field
                  label="Password"
                  type="password"
                  value={form.password}
                  onChange={(v) => setForm((f) => ({ ...f, password: v }))}
                  error={errors.password}
                  placeholder="Min 10 chars, mixed case + number + symbol"
                  autoComplete="new-password"
                />
                <Field
                  label="Confirm password"
                  type="password"
                  value={form.confirm}
                  onChange={(v) => setForm((f) => ({ ...f, confirm: v }))}
                  error={errors.confirm}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                />
                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-2.5 rounded-lg"
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Creating…
                    </span>
                  ) : (
                    'Create admin account'
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  error,
  placeholder,
  autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-300 mb-1.5">{label}</label>
      <input
        type={type}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3.5 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
      />
      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
    </div>
  );
}
