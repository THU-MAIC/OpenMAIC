import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { AdminProvidersPanel } from '@/components/admin/providers-panel';

export const metadata = {
  title: 'Configuración de proveedores · OpenMAIC Admin',
};

export default async function AdminProvidersPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/auth/signin?callbackUrl=/admin/providers');
  }
  if (session.user.role !== 'ADMIN') {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">403 — Acceso denegado</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Solo los administradores pueden configurar proveedores. Contacta al administrador
          del sistema si necesitas acceso.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Configuración de proveedores
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Estos cambios se persisten en la base de datos y sobrescriben los valores por defecto
          de <code>server-providers.yml</code>. Las variables de entorno siguen teniendo
          prioridad máxima.
        </p>
      </header>
      <AdminProvidersPanel />
    </div>
  );
}
