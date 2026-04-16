'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { LogIn, User } from 'lucide-react';
import { useAuth } from '@/lib/hooks/use-auth';
import { usePlanStore } from '@/lib/store/user-plan';
import { AuthProfileModal } from './auth-profile-modal';

/**
 * Top-right auth button.
 * - Not logged in → shows "Sign In" button that navigates to /auth/login
 * - Logged in → shows user avatar/initials that opens profile modal
 */
export function AuthButton() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (user) {
      usePlanStore.getState().refetch();
    } else {
      usePlanStore.getState().clear();
    }
  }, [user]);

  if (loading) {
    return (
      <div className="size-9 rounded-full bg-[#f0f4f8] border-2 border-[#073b4c]/15 animate-pulse" />
    );
  }

  // Not logged in — show Sign In button
  if (!user) {
    return (
      <motion.button
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={() => router.push('/auth/login')}
        className="flex items-center gap-2 h-9 px-4 rounded-full border-2 border-[#073b4c] bg-white text-[#073b4c] font-bold text-xs hover:translate-y-[-1px] shadow-[3px_3px_0_#073b4c] hover:shadow-[4px_4px_0_#073b4c] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]"
      >
        <LogIn className="size-3.5" />
        Sign In
      </motion.button>
    );
  }

  // Logged in — show avatar/profile button
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture;
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name || '';
  const initials = fullName
    ? fullName
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : (user.email || '??').slice(0, 2).toUpperCase();

  return (
    <>
      <motion.button
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={() => setProfileOpen(!profileOpen)}
        className="shrink-0 size-9 rounded-full border-2 border-[#073b4c] overflow-hidden shadow-[2px_2px_0_#073b4c] hover:shadow-[3px_3px_0_#073b4c] hover:translate-y-[-1px] transition-all cursor-pointer active:translate-y-0 active:shadow-[1px_1px_0_#073b4c]"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="size-full bg-gradient-to-br from-[#118AB2] to-[#06D6A0] flex items-center justify-center">
            <span className="text-[11px] font-black text-white">{initials}</span>
          </div>
        )}
      </motion.button>

      <AuthProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
