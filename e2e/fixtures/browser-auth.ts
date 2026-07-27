'use client';

import type { Session, User } from '@supabase/supabase-js';

export type UserRole = 'admin' | 'teacher' | 'learner';

export interface UserProfile {
  id: string;
  role: UserRole;
  display_name: string | null;
}

const e2eUser = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'e2e@example.invalid',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { display_name: 'E2E User' },
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as User;

const e2eSession = {
  access_token: 'e2e-access-token',
  refresh_token: 'e2e-refresh-token',
  token_type: 'bearer',
  expires_in: 60 * 60,
  expires_at: 1_800_000_000,
  user: e2eUser,
} as Session;

const e2eProfile: UserProfile = {
  id: e2eUser.id,
  role: 'teacher',
  display_name: 'E2E User',
};

/**
 * Browser-only auth replacement selected only when E2E_TEST_MODE=1.
 * It is a build-time alias rather than a client-visible production switch.
 */
export function useAuth() {
  return {
    user: e2eUser,
    session: e2eSession,
    profile: e2eProfile,
    loading: false,
    error: null,
    signOut: async () => undefined,
    reload: async () => undefined,
  };
}
