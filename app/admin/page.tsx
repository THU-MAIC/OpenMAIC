import Link from 'next/link';
import { Cog, Plug, Users, BookOpen, Sliders } from 'lucide-react';

export const metadata = {
  title: 'Panel de administración · OpenMAIC',
};

const cards = [
  {
    href: '/admin/providers',
    title: 'Proveedores de IA',
    description: 'Configura claves de OpenAI, Anthropic y otros proveedores de modelos.',
    icon: Sliders,
  },
  {
    href: '/admin/integrations',
    title: 'Integraciones LMS',
    description: 'Conecta con Moodle, Odoo, Dolibarr y sincroniza calificaciones.',
    icon: Plug,
  },
  {
    href: '/admin/users',
    title: 'Usuarios y roles',
    description: 'Administra cuentas, asigna roles de profesor, estudiante o administrador.',
    icon: Users,
  },
  {
    href: '/admin/settings',
    title: 'Configuración general',
    description: 'Ajustes globales del sistema, idioma predeterminado y políticas.',
    icon: Cog,
  },
  {
    href: '/courses',
    title: 'Cursos completos',
    description: 'Ver y editar cursos, módulos y capítulos generados.',
    icon: BookOpen,
  },
];

export default function AdminDashboardPage() {
  return (
    <div className="max-w-6xl mx-auto p-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
          Panel de administración
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          Gestiona la configuración, integraciones y usuarios de tu instancia de OpenMAIC.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="block p-5 bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-md transition-shadow border border-gray-200 dark:border-gray-700"
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400">
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
