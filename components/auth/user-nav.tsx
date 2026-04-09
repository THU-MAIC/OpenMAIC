'use client';

import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { Shield, LogOut, LogIn, User } from 'lucide-react';

export function UserNav() {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return <div className="h-8 w-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />;
  }

  if (!session?.user) {
    return (
      <Link
        href="/auth/signin"
        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-700 text-white rounded-md"
      >
        <LogIn className="w-4 h-4" />
        Iniciar sesión
      </Link>
    );
  }

  const isAdmin = session.user.role === 'ADMIN';

  return (
    <div className="flex items-center gap-2">
      {isAdmin && (
        <Link
          href="/admin"
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/50"
        >
          <Shield className="w-3.5 h-3.5" />
          Admin
        </Link>
      )}
      <div className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
        <User className="w-4 h-4" />
        <span className="hidden sm:inline">{session.user.name || session.user.email}</span>
        <span className="text-xs text-gray-500">({session.user.role})</span>
      </div>
      <button
        onClick={() => signOut({ callbackUrl: '/auth/signin' })}
        className="p-1.5 text-gray-400 hover:text-red-500"
        aria-label="Cerrar sesión"
        title="Cerrar sesión"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </div>
  );
}
