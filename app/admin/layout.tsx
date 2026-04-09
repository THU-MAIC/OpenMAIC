import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';

export const metadata = {
  title: 'Administración · OpenMAIC',
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect('/auth/signin?callbackUrl=/admin');
  }
  if (session.user.role !== 'ADMIN') {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">403 — Acceso denegado</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Solo los administradores pueden acceder a esta sección.
        </p>
        <Link href="/" className="mt-4 inline-block text-violet-600 hover:underline">
          Volver al inicio
        </Link>
      </div>
    );
  }

  const navItems = [
    { href: '/admin', label: 'Panel' },
    { href: '/admin/providers', label: 'Proveedores de IA' },
    { href: '/admin/integrations', label: 'Integraciones LMS' },
    { href: '/admin/users', label: 'Usuarios' },
    { href: '/admin/settings', label: 'Configuración' },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-bold text-gray-900 dark:text-gray-100">
            OpenMAIC
          </Link>
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
            Admin
          </span>
          <nav className="flex gap-4 text-sm">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-gray-600 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto text-xs text-gray-500">
            {session.user.email} · {session.user.role}
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
