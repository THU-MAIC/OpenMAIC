import type { Role } from '@prisma/client';

// Augment Auth.js types to include role, isActive, consentGiven
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role: Role;
      isActive: boolean;
      consentGiven: boolean;
    };
  }

  interface User {
    role?: Role;
  }
}

