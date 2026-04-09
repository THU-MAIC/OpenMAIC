import { prisma } from '@/lib/db/prisma';

export const metadata = {
  title: 'Usuarios · OpenMAIC Admin',
};

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Usuarios</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          {users.length} {users.length === 1 ? 'cuenta registrada' : 'cuentas registradas'}
        </p>
      </header>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900/50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">Email</th>
              <th className="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">Nombre</th>
              <th className="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">Rol</th>
              <th className="px-4 py-3 font-medium text-gray-700 dark:text-gray-300">Creado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 text-gray-900 dark:text-gray-100">{u.email}</td>
                <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{u.name ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
