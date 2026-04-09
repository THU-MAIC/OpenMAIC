'use client';

import { useEffect, useState } from 'react';
import { listLMSProviders } from '@/lib/lms/registry';

interface Integration {
  id: string;
  providerId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
}

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [providerId, setProviderId] = useState('moodle');
  const [name, setName] = useState('');
  const [config, setConfig] = useState('{}');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const providers = listLMSProviders();

  useEffect(() => {
    fetch('/api/admin/integrations')
      .then((r) => r.json())
      .then((data) => setIntegrations(data.integrations || []))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(config);
    } catch {
      alert('Config inválido (debe ser JSON)');
      return;
    }
    const res = await fetch('/api/admin/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, name, config: parsedConfig }),
    });
    if (res.ok) {
      const data = await res.json();
      setIntegrations([...integrations, data.integration]);
      setShowForm(false);
      setName('');
      setConfig('{}');
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    const res = await fetch('/api/lti/grades', { method: 'POST' });
    const data = await res.json();
    setSyncing(false);
    if (data.result) {
      setSyncMsg(
        `Sync: ${data.result.succeeded}/${data.result.total} OK, ${data.result.failed} fallaron.`,
      );
    } else {
      setSyncMsg(data.error || 'Error al sincronizar');
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Integraciones LMS</h1>
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {syncing ? 'Sincronizando...' : 'Sincronizar calificaciones'}
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium"
          >
            {showForm ? 'Cancelar' : '+ Nueva integración'}
          </button>
        </div>
      </header>

      {syncMsg && (
        <div className="mb-4 p-3 text-sm rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300">
          {syncMsg}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-8 p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm space-y-4"
        >
          <div>
            <label className="block text-sm font-medium mb-1">Proveedor</label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Nombre</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Config (JSON)
              <span className="text-xs text-gray-500 ml-2">
                ej: {'{'}"baseUrl":"https://moodle.example","clientId":"abc"{'}'}
              </span>
            </label>
            <textarea
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md font-mono text-xs"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium"
          >
            Crear
          </button>
        </form>
      )}

      {loading ? (
        <div>Cargando...</div>
      ) : integrations.length === 0 ? (
        <div className="p-12 text-center text-gray-500 border-2 border-dashed rounded-xl">
          Sin integraciones configuradas.
        </div>
      ) : (
        <ul className="space-y-2">
          {integrations.map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between p-4 bg-white dark:bg-gray-800 rounded-lg shadow-sm"
            >
              <div>
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-gray-500">
                  {i.providerId} · {i.enabled ? 'activa' : 'desactivada'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
