'use client';

import { useState } from 'react';

interface ScormExportButtonProps {
  courseId: string;
}

type ScormVersion = '1.2' | '2004';
type ExportMode = 'full' | 'light' | 'structure';
type TTSProviderId =
  | 'openai-tts'
  | 'azure-tts'
  | 'glm-tts'
  | 'qwen-tts'
  | 'elevenlabs-tts';

const TTS_PROVIDER_OPTIONS: Array<{ id: TTSProviderId; label: string }> = [
  { id: 'openai-tts', label: 'OpenAI TTS' },
  { id: 'azure-tts', label: 'Azure TTS' },
  { id: 'elevenlabs-tts', label: 'ElevenLabs' },
  { id: 'glm-tts', label: 'GLM TTS' },
  { id: 'qwen-tts', label: 'Qwen TTS' },
];

export function ScormExportButton({ courseId }: ScormExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<ScormVersion>('2004');
  const [mode, setMode] = useState<ExportMode>('light');
  const [ttsProvider, setTtsProvider] = useState<TTSProviderId>('openai-tts');
  const [ttsVoice, setTtsVoice] = useState('alloy');
  const [ttsSpeed, setTtsSpeed] = useState(1.0);
  const [ttsApiKey, setTtsApiKey] = useState('');
  const [ttsBaseUrl, setTtsBaseUrl] = useState('');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { version, mode };
      if (mode === 'full') {
        payload.tts = {
          providerId: ttsProvider,
          voice: ttsVoice,
          speed: ttsSpeed,
          ...(ttsApiKey ? { apiKey: ttsApiKey } : {}),
          ...(ttsBaseUrl ? { baseUrl: ttsBaseUrl } : {}),
        };
      }
      const res = await fetch(`/api/export/scorm/${courseId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : `course-${courseId}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-sm font-medium"
      >
        Exportar SCORM
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => !exporting && setOpen(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold mb-4">Exportar curso a SCORM</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Versión SCORM</label>
                <select
                  value={version}
                  onChange={(e) => setVersion(e.target.value as ScormVersion)}
                  disabled={exporting}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700"
                >
                  <option value="2004">SCORM 2004 (4ª ed.) — recomendado</option>
                  <option value="1.2">SCORM 1.2 — máxima compatibilidad</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Modo de exportación</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ExportMode)}
                  disabled={exporting}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700"
                >
                  <option value="light">
                    Ligero — sin audio pre-renderizado (~5-20 MB)
                  </option>
                  <option value="structure">
                    Solo estructura — sin audio ni pizarra (&lt;5 MB)
                  </option>
                  <option value="full">
                    Completo — con TTS pre-renderizado
                  </option>
                </select>
              </div>

              {mode === 'full' && (
                <div className="space-y-3 p-3 border border-violet-200 dark:border-violet-800 rounded bg-violet-50 dark:bg-violet-900/20">
                  <p className="text-xs font-medium text-violet-900 dark:text-violet-100">
                    Configuración TTS (pre-renderizado)
                  </p>
                  <div>
                    <label className="block text-xs font-medium mb-1">Proveedor</label>
                    <select
                      value={ttsProvider}
                      onChange={(e) => setTtsProvider(e.target.value as TTSProviderId)}
                      disabled={exporting}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                    >
                      {TTS_PROVIDER_OPTIONS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium mb-1">Voz</label>
                      <input
                        type="text"
                        value={ttsVoice}
                        onChange={(e) => setTtsVoice(e.target.value)}
                        disabled={exporting}
                        placeholder="alloy"
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Velocidad</label>
                      <input
                        type="number"
                        min={0.5}
                        max={2.0}
                        step={0.1}
                        value={ttsSpeed}
                        onChange={(e) => setTtsSpeed(parseFloat(e.target.value) || 1.0)}
                        disabled={exporting}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      API Key <span className="text-gray-500">(opcional si está en el servidor)</span>
                    </label>
                    <input
                      type="password"
                      value={ttsApiKey}
                      onChange={(e) => setTtsApiKey(e.target.value)}
                      disabled={exporting}
                      placeholder="sk-..."
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">
                      Base URL <span className="text-gray-500">(opcional)</span>
                    </label>
                    <input
                      type="text"
                      value={ttsBaseUrl}
                      onChange={(e) => setTtsBaseUrl(e.target.value)}
                      disabled={exporting}
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700"
                    />
                  </div>
                  <p className="text-xs text-violet-700 dark:text-violet-300">
                    La generación puede tardar varios minutos dependiendo del número de narraciones.
                  </p>
                </div>
              )}

              <div className="text-xs text-gray-500 dark:text-gray-400 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded">
                <p className="font-medium mb-1">Limitaciones del paquete SCORM:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Sin generación de contenido en vivo</li>
                  <li>Sin discusión multiagente</li>
                  <li>PBL en modo solo lectura</li>
                  <li>
                    En modo ligero, la narración usa la voz del navegador del
                    estudiante (si está disponible)
                  </li>
                  <li>
                    En modo completo, los audios se pre-renderizan con el
                    proveedor TTS seleccionado
                  </li>
                </ul>
              </div>

              {error && (
                <div className="text-sm text-red-600 p-3 bg-red-50 dark:bg-red-900/20 rounded">
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setOpen(false)}
                  disabled={exporting}
                  className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-md disabled:opacity-50"
                >
                  {exporting ? 'Generando…' : 'Descargar ZIP'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
