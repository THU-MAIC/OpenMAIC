export const metadata = {
  title: 'Configuración · OpenMAIC Admin',
};

export default function AdminSettingsPage() {
  return (
    <div className="max-w-3xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Configuración general
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
          Ajustes globales del sistema.
        </p>
      </header>

      <div className="space-y-6">
        <section className="p-5 bg-white dark:bg-gray-800 rounded-xl shadow-sm">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-3">Instancia</h2>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between">
              <dt className="text-gray-500">Versión</dt>
              <dd className="font-mono">OpenMAIC</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Entorno</dt>
              <dd className="font-mono">{process.env.NODE_ENV}</dd>
            </div>
          </dl>
        </section>

        <section className="p-5 bg-white dark:bg-gray-800 rounded-xl shadow-sm">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-3">
            Configuración avanzada
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Los ajustes de modelos y claves API se configuran desde{' '}
            <a href="/admin/providers" className="text-violet-600 hover:underline">
              Proveedores de IA
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
