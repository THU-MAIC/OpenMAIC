'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { ExternalLink, GraduationCap, Loader2, LogOut, Save, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { toast } from 'sonner';

interface AccountMenuProps {
  readonly className?: string;
}

interface UserProfile {
  id: string;
  name: string | null;
  email: string;
  studentId: string | null;
  bio: string | null;
  image: string | null;
  role: 'ADMIN' | 'INSTRUCTOR' | 'STUDENT';
}

function getInitials(name?: string | null, email?: string | null) {
  const source = (name || email || 'U').trim();
  return source.charAt(0).toUpperCase();
}

export function AccountMenu({ className }: AccountMenuProps) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const setNickname = useUserProfileStore((state) => state.setNickname);
  const setBio = useUserProfileStore((state) => state.setBio);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [form, setForm] = useState({ bio: '' });

  useEffect(() => {
    if (status === 'loading') return;
    if (!session?.user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetch('/api/user/profile')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load profile');
        }
        return response.json();
      })
      .then((data: { user?: UserProfile | null }) => {
        if (cancelled || !data.user) return;
        setProfile(data.user);
        setForm({
          bio: data.user.bio ?? '',
        });
        setNickname(data.user.name ?? '');
        setBio(data.user.bio ?? '');
      })
      .catch(() => {
        if (!cancelled) {
          toast.error('Failed to load your profile');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session?.user, setBio, setNickname, status]);

  if (!session?.user) {
    return null;
  }

  const visibleName = profile?.name ?? session.user.name ?? 'User';
  const visibleEmail = profile?.email ?? session.user.email ?? '';
  const visibleImage = profile?.image ?? session.user.image ?? null;
  const visibleRole = profile?.role ?? session.user.role;

  const handleSave = async () => {
    setSaving(true);
    const response = await fetch('/api/user/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bio: form.bio.trim(),
      }),
    });

    const data = (await response.json().catch(() => null)) as { user?: UserProfile; error?: string } | null;
    setSaving(false);

    if (!response.ok || !data?.user) {
      toast.error(data?.error ?? 'Failed to update profile');
      return;
    }

    const updatedUser = data.user;

    setProfile((current) => ({
      id: current?.id ?? updatedUser.id,
      name: updatedUser.name ?? null,
      email: updatedUser.email ?? visibleEmail,
      studentId: updatedUser.studentId ?? null,
      bio: updatedUser.bio ?? null,
      image: updatedUser.image ?? null,
      role: current?.role ?? visibleRole,
    }));
    setForm({ bio: updatedUser.bio ?? '' });
    setNickname(updatedUser.name ?? '');
    setBio(updatedUser.bio ?? '');
    toast.success('Profile updated');
  };

  return (
    <div className={className ?? 'fixed left-4 top-4 z-50'}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-white/40 bg-white/80 text-slate-900 shadow-lg shadow-slate-900/10 backdrop-blur-md transition-all hover:scale-[1.02] hover:border-violet-300 hover:shadow-xl dark:border-white/10 dark:bg-slate-900/80 dark:text-white dark:shadow-black/30"
                aria-label="Open account menu"
                title={visibleName}
              >
                {visibleImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={visibleImage} alt={visibleName} className="h-full w-full rounded-full object-cover" />
                ) : (
                  <span className="text-sm font-semibold">{getInitials(visibleName, visibleEmail)}</span>
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            Account
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={10}
          className="w-[22rem] rounded-3xl border-white/60 bg-white/95 p-0 shadow-2xl shadow-slate-900/15 backdrop-blur-xl dark:border-white/10 dark:bg-slate-950/95"
        >
          {loading ? (
            <div className="flex items-center justify-center px-6 py-10">
              <Loader2 className="h-5 w-5 animate-spin text-violet-500" />
            </div>
          ) : (
            <div className="overflow-hidden rounded-3xl">
              <div className="border-b border-slate-200/80 bg-gradient-to-br from-violet-100 via-white to-sky-100 px-6 py-5 dark:border-white/10 dark:from-violet-950/60 dark:via-slate-950 dark:to-sky-950/40">
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 text-sm font-semibold text-white shadow-lg shadow-violet-600/25">
                    {visibleImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={visibleImage} alt={visibleName} className="h-full w-full rounded-full object-cover" />
                    ) : (
                      getInitials(visibleName, visibleEmail)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                      {visibleName}
                    </p>
                    <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                      {visibleEmail}
                    </p>
                    <span className="mt-2 inline-flex rounded-full bg-violet-600/10 px-2 py-1 text-[10px] font-semibold tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                      {visibleRole}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-4 px-6 py-5">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                    Full name
                  </label>
                  <input
                    type="text"
                    value={visibleName}
                    readOnly
                    className="h-10 w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600 outline-none dark:border-white/10 dark:bg-slate-900 dark:text-slate-300"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                    Student ID
                  </label>
                  <input
                    type="text"
                    value={profile?.studentId ?? '—'}
                    readOnly
                    className="h-10 w-full cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600 outline-none dark:border-white/10 dark:bg-slate-900 dark:text-slate-300"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">
                    Bio
                  </label>
                  <Textarea
                    value={form.bio}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, bio: event.target.value }))
                    }
                    rows={4}
                    maxLength={500}
                    className="min-h-[104px] resize-none rounded-2xl border-slate-200 bg-white text-sm text-slate-900 focus-visible:border-violet-400 focus-visible:ring-violet-200 dark:border-white/10 dark:bg-slate-900 dark:text-white dark:focus-visible:border-violet-500 dark:focus-visible:ring-violet-500/20"
                    placeholder="Add details other instructors or classmates should know"
                  />
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="flex-1 rounded-2xl bg-violet-600 text-white hover:bg-violet-700"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      router.push('/profile');
                    }}
                    className="rounded-2xl border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:border-white/10 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Profile
                  </Button>
                </div>
              </div>

              <div className="border-t border-slate-200/80 px-3 py-3 dark:border-white/10">
                {(visibleRole === 'INSTRUCTOR' || visibleRole === 'ADMIN') && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      router.push('/instructor');
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    <GraduationCap className="h-4 w-4" />
                    Instructor Panel
                  </button>
                )}
                {visibleRole === 'ADMIN' && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      router.push('/admin');
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    <Shield className="h-4 w-4" />
                    Admin Panel
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: '/auth/signin' })}
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left text-sm text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}