'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/hooks/use-i18n';
import { pblRequest } from '@/components/scene-renderers/pbl/v3/workspace';
export default function PBLExamples() {
  const { t } = useI18n(),
    router = useRouter(),
    id = useRef<string>('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [projects, setProjects] = useState<
    { ref: { id: string; version: string }; title: string; language: string }[]
  >([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    let active = true;
    void pblRequest<typeof projects>('/api/pbl/v3?samples=1')
      .then((items) => {
        if (active) {
          setProjects(items);
          setSelected(items[0]?.ref.id ?? '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const open = async () => {
    setBusy(true);
    setError('');
    id.current ||= `pbl-${crypto.randomUUID()}`;
    try {
      const result = await pblRequest<{ classroomId: string }>('/api/pbl/v3', {
        action: 'sample',
        id: id.current,
        project: projects.find((p) => p.ref.id === selected)?.ref,
      });
      router.push(`/classroom/${result.classroomId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-2xl space-y-5 p-8">
      <h1 className="text-2xl font-semibold">{t('pblV3.title')}</h1>
      <p>{t('pblV3.sampleNotice')}</p>
      <label className="block">
        {t('pblV3.sampleSelect')}
        <select
          className="ml-3 rounded border p-2"
          disabled={busy}
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            id.current = '';
          }}
        >
          {projects.map((p) => (
            <option key={p.ref.id} value={p.ref.id}>
              {p.title} ({p.language})
            </option>
          ))}
        </select>
      </label>
      <button
        className="rounded border px-4 py-2 disabled:opacity-50"
        disabled={busy || !selected}
        onClick={() => void open()}
      >
        {t('pblV3.openSample')}
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
