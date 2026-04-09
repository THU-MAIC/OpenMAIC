'use client';

import { useEffect, useState } from 'react';

type Category = 'llm' | 'tts' | 'asr' | 'image' | 'video' | 'webSearch' | 'pdf';

interface Override {
  id: string;
  category: Category;
  providerId: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  baseUrl: string | null;
  models: string | null;
  proxy: string | null;
  enabled: boolean;
  updatedAt: string;
}

/** Catalog of provider IDs organised by category. Grouped so the admin can
 *  pick from a dropdown instead of typing the ID manually. */
const PROVIDER_CATALOG: Record<Category, Array<{ id: string; label: string }>> = {
  llm: [
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' },
    { id: 'google', label: 'Google Gemini' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'qwen', label: 'Qwen' },
    { id: 'kimi', label: 'Kimi' },
    { id: 'minimax', label: 'MiniMax' },
    { id: 'glm', label: 'GLM' },
    { id: 'siliconflow', label: 'SiliconFlow' },
    { id: 'doubao', label: 'Doubao' },
    { id: 'grok', label: 'Grok' },
    { id: 'openrouter', label: 'OpenRouter' },
  ],
  tts: [
    { id: 'openai-tts', label: 'OpenAI TTS' },
    { id: 'azure-tts', label: 'Azure TTS' },
    { id: 'elevenlabs-tts', label: 'ElevenLabs' },
    { id: 'cartesia-tts', label: 'Cartesia' },
    { id: 'glm-tts', label: 'GLM TTS' },
    { id: 'qwen-tts', label: 'Qwen TTS' },
  ],
  asr: [
    { id: 'openai-whisper', label: 'OpenAI Whisper' },
    { id: 'qwen-asr', label: 'Qwen ASR' },
    { id: 'assemblyai-asr', label: 'AssemblyAI' },
  ],
  image: [
    { id: 'seedream', label: 'Seedream' },
    { id: 'qwen-image', label: 'Qwen Image' },
    { id: 'nano-banana', label: 'Nano Banana' },
    { id: 'grok-image', label: 'Grok Image' },
  ],
  video: [
    { id: 'seedance', label: 'Seedance' },
    { id: 'kling', label: 'Kling' },
    { id: 'veo', label: 'Google Veo' },
    { id: 'sora', label: 'OpenAI Sora' },
    { id: 'grok-video', label: 'Grok Video' },
  ],
  webSearch: [{ id: 'tavily', label: 'Tavily' }],
  pdf: [
    { id: 'unpdf', label: 'UnPDF' },
    { id: 'mineru', label: 'MinerU' },
  ],
};

const CATEGORY_LABEL: Record<Category, string> = {
  llm: 'LLM',
  tts: 'Text-to-Speech',
  asr: 'Speech-to-Text',
  image: 'Generación de imagen',
  video: 'Generación de video',
  webSearch: 'Búsqueda web',
  pdf: 'PDF',
};

export function AdminProvidersPanel() {
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [category, setCategory] = useState<Category>('llm');
  const [providerId, setProviderId] = useState<string>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [proxy, setProxy] = useState('');
  const [saving, setSaving] = useState(false);

  async function loadOverrides() {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/providers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setOverrides(data.overrides);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOverrides();
  }, []);

  // When category changes, default providerId to first entry of new category
  useEffect(() => {
    setProviderId(PROVIDER_CATALOG[category][0].id);
  }, [category]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          providerId,
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined,
          models: models || undefined,
          proxy: proxy || undefined,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setApiKey('');
      setBaseUrl('');
      setModels('');
      setProxy('');
      await loadOverrides();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error saving');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar esta configuración?')) return;
    try {
      const res = await fetch(`/api/admin/providers?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadOverrides();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error deleting');
    }
  }

  async function handleToggle(row: Override) {
    try {
      const res = await fetch('/api/admin/providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: row.category,
          providerId: row.providerId,
          enabled: !row.enabled,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadOverrides();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error toggling');
    }
  }

  // Group overrides by category for display
  const grouped: Record<string, Override[]> = {};
  for (const o of overrides) {
    (grouped[o.category] = grouped[o.category] || []).push(o);
  }

  return (
    <div className="space-y-8">
      {/* Upsert form */}
      <section className="border border-gray-200 dark:border-gray-700 rounded-xl p-6 bg-white dark:bg-gray-800">
        <h2 className="text-lg font-semibold mb-4">Añadir / actualizar proveedor</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Categoría</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700"
            >
              {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Proveedor</label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700"
            >
              {PROVIDER_CATALOG[category].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.id})
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium mb-1">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              Se guarda en la base de datos. Deja vacío para no tocar el valor actual.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Base URL (opcional)</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Proxy (opcional)</label>
            <input
              type="text"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="http://proxy.local:8080"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 font-mono text-sm"
            />
          </div>
          {category === 'llm' && (
            <div className="md:col-span-2">
              <label className="block text-sm font-medium mb-1">
                Modelos (coma-separado, opcional)
              </label>
              <input
                type="text"
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="gpt-5, gpt-5-mini, gpt-4o"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 font-mono text-sm"
              />
            </div>
          )}
        </div>
        {error && (
          <div className="mt-4 p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-md text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </section>

      {/* Overrides list */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Configuraciones persistidas</h2>
        {loading ? (
          <p className="text-gray-500">Cargando…</p>
        ) : overrides.length === 0 ? (
          <p className="text-gray-500 text-sm">
            Aún no hay configuraciones personalizadas. Los proveedores siguen usando los
            valores de <code>server-providers.yml</code> y variables de entorno.
          </p>
        ) : (
          <div className="space-y-6">
            {(Object.keys(grouped) as Category[]).map((cat) => (
              <div key={cat}>
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wide">
                  {CATEGORY_LABEL[cat]}
                </h3>
                <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <th className="text-left px-4 py-2 font-medium">Proveedor</th>
                        <th className="text-left px-4 py-2 font-medium">API Key</th>
                        <th className="text-left px-4 py-2 font-medium">Base URL</th>
                        <th className="text-left px-4 py-2 font-medium">Estado</th>
                        <th className="text-right px-4 py-2 font-medium">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {grouped[cat].map((row) => (
                        <tr
                          key={row.id}
                          className="border-t border-gray-200 dark:border-gray-700"
                        >
                          <td className="px-4 py-2 font-mono">{row.providerId}</td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {row.hasApiKey ? row.apiKeyMasked : '—'}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">
                            {row.baseUrl || '—'}
                          </td>
                          <td className="px-4 py-2">
                            <button
                              onClick={() => handleToggle(row)}
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                row.enabled
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                  : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                              }`}
                            >
                              {row.enabled ? 'activo' : 'inactivo'}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <button
                              onClick={() => handleDelete(row.id)}
                              className="text-xs text-red-600 hover:underline"
                            >
                              Eliminar
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
