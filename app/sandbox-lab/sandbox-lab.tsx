'use client';
import { getClientTranslation } from '@/lib/i18n';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';

import { useEffect, useRef, useState } from 'react';
import type { SandboxCommandResult, SandboxEnvironment, SandboxProfile } from '@/lib/sandbox/types';

const base = '/api/sandbox/environments';

async function api<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: { 'X-OpenMAIC-Sandbox': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw new Error(json.error?.message ?? getClientTranslation('sandbox.sandboxRequestFailed'));
  return json.data;
}

/** Opt-in developer surface. It uses the same public APIs as future consumers. */
export default function SandboxLab() {
  const { t } = useTranslation();
  const [environments, setEnvironments] = useState<SandboxEnvironment[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [path, setPath] = useState('/home/user/project/main.py');
  const [text, setText] = useState('print("Hello from OpenMAIC")\n');
  const [command, setCommand] = useState('python3 /home/user/project/main.py');
  const [result, setResult] = useState<SandboxCommandResult | null>(null);
  const [image, setImage] = useState('');
  const [terminal, setTerminal] = useState('');
  const [terminalLine, setTerminalLine] = useState('echo hello');
  const [output, setOutput] = useState('');
  const stream = useRef<AbortController | null>(null);
  const env = environments.find((e) => e.id === selected);
  const running = env?.state === 'running';
  const button = 'rounded border px-3 py-2 text-sm disabled:opacity-40 hover:bg-muted';
  const field = 'w-full rounded border bg-background p-2 font-mono text-sm';

  async function refresh() {
    setEnvironments(await api<SandboxEnvironment[]>());
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sandbox.requestFailed'));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void api<SandboxEnvironment[]>().then(
      (rows) => {
        if (active) setEnvironments(rows);
      },
      (e) => {
        if (active) setError(e instanceof Error ? e.message : t('sandbox.requestFailed'));
      },
    );
    return () => {
      active = false;
      stream.current?.abort();
    };
  }, [t]);

  function select(id: string) {
    stream.current?.abort();
    setSelected(id);
    setTerminal('');
    setOutput('');
    setImage('');
    setResult(null);
  }

  async function create(profile: SandboxProfile) {
    const requestId = crypto.randomUUID();
    const created = await api<SandboxEnvironment>('', 'POST', {
      requestId,
      workspaceId: `lab-${requestId}`,
      profile,
    });
    select(created.id);
    await refresh();
  }

  async function execute() {
    const id = selected;
    let value = await api<SandboxCommandResult>(`/${id}/commands`, 'POST', {
      requestId: crypto.randomUUID(),
      command,
      timeoutMs: 60_000,
    });
    setResult(value);
    for (let n = 0; n < 90 && ['starting', 'running', 'unknown'].includes(value.state); n++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      value = await api<SandboxCommandResult>(`/${id}/commands/${value.id}`);
      setResult(value);
    }
  }

  async function connectTerminal() {
    const id = selected;
    const known = await api<Array<{ id: string; state: string }>>(`/${id}/terminals`);
    const current =
      known.find((t) => t.state !== 'closed') ??
      (await api<{ id: string; state: string }>(`/${id}/terminals`, 'POST', {
        requestId: crypto.randomUUID(),
        cols: 100,
        rows: 30,
      }));
    setTerminal(current.id);
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    const response = await fetch(`${base}/${id}/terminals/${current.id}/events`, {
      headers: { 'X-OpenMAIC-Sandbox': '1' },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(t('sandbox.terminalConnectionFailed'));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let pending = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const packet = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            if (!packet.startsWith('data: ')) continue;
            const event = JSON.parse(packet.slice(6));
            if (event.type === 'output') {
              const bytes = Uint8Array.from(atob(event.base64), (c) => c.charCodeAt(0));
              const decoded = new TextDecoder().decode(bytes);
              setOutput((old) => (old + decoded).slice(-32768));
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) setError(t('sandbox.terminalReconnect'));
      } finally {
        reader.releaseLock();
      }
    })();
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('sandbox.lab')}</h1>
        <Link className="underline" href="/project-workspace/sandbox-project">
          {t('sandbox.openWorkspace')}
        </Link>
        <p className="text-sm text-muted-foreground">{t('sandbox.labAdvice')}</p>
        <p className="text-sm text-muted-foreground">{t('sandbox.labDescription')}</p>
      </header>
      {error && (
        <p role="alert" className="rounded border border-red-400 p-3 text-red-600">
          {error}
        </p>
      )}
      <section className="space-y-3 rounded border p-4">
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            disabled={busy}
            onClick={() => void perform(() => create('code'))}
          >
            {t('sandbox.createCode')}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void perform(() => create('desktop'))}
          >
            {t('sandbox.createDesktop')}
          </button>
          <button className={button} disabled={busy} onClick={() => void perform(refresh)}>
            {t('sandbox.refreshEnvironments')}
          </button>
        </div>
        <label className="block text-sm">
          {t('sandbox.environment')}
          <select
            className={field}
            value={selected}
            onChange={(e) => select(e.target.value)}
            disabled={busy}
          >
            <option value="">{t('sandbox.selectEnvironment')}</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {t(`sandbox.profiles.${e.profile}`)} · {t(`sandbox.states.${e.state}`)} ·{' '}
                {e.workspaceId}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <button
            className={button}
            disabled={!selected || busy}
            onClick={() =>
              void perform(async () => {
                await api(`/${selected}`, 'POST', { action: 'reconcile' });
                await refresh();
              })
            }
          >
            {t('sandbox.reconcile')}
          </button>
          <button
            className={button}
            disabled={!selected || busy}
            onClick={() =>
              void perform(async () => {
                await api(`/${selected}`, 'DELETE');
                select('');
                await refresh();
              })
            }
          >
            {t('sandbox.releaseFiles')}
          </button>
        </div>
      </section>
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">{t('sandbox.workspaceFile')}</h2>
        <label className="block text-sm">
          {t('sandbox.absolutePath')}
          <input className={field} value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        <textarea
          aria-label={t('sandbox.fileContents')}
          className={`${field} min-h-28`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            className={button}
            disabled={!running || busy}
            onClick={() =>
              void perform(async () => {
                await api(`/${selected}/files`, 'PUT', { path, text });
              })
            }
          >
            {t('sandbox.saveFile')}
          </button>
          <button
            className={button}
            disabled={!running || busy}
            onClick={() =>
              void perform(async () => {
                setText(
                  (
                    await api<{ text: string }>(
                      `/${selected}/files?path=${encodeURIComponent(path)}`,
                    )
                  ).text,
                );
              })
            }
          >
            {t('sandbox.readFile')}
          </button>
        </div>
      </section>
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">{t('sandbox.command')}</h2>
        <input
          aria-label={t('sandbox.command')}
          className={field}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            className={button}
            disabled={!running || busy}
            onClick={() => void perform(execute)}
          >
            {t('sandbox.runCommand')}
          </button>
          <button
            className={button}
            disabled={
              !result || !running || !['starting', 'running', 'unknown'].includes(result.state)
            }
            onClick={() => {
              if (result)
                void api(`/${selected}/commands/${result.id}`, 'DELETE').catch((e) =>
                  setError(e.message),
                );
            }}
          >
            {t('sandbox.cancelCommand')}
          </button>
        </div>
        {result && (
          <>
            <p className="text-sm">
              {t(`sandbox.states.${result.state}`)} ·{' '}
              {t('sandbox.exit', { code: result.exitCode ?? t('sandbox.pending') })}
              {result.truncated ? t('sandbox.truncated') : ''}
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-sm">
              {result.stdout}
              {result.stderr}
            </pre>
          </>
        )}
      </section>
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">{t('sandbox.ptyConsole')}</h2>
        <button
          className={button}
          disabled={!running || busy}
          onClick={() => void perform(connectTerminal)}
        >
          {t('sandbox.connectTerminal')}
        </button>
        <pre className="h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 font-mono text-sm text-zinc-100">
          {output}
        </pre>
        <input
          aria-label={t('sandbox.terminalInput')}
          className={field}
          value={terminalLine}
          onChange={(e) => setTerminalLine(e.target.value)}
        />
        <button
          className={button}
          disabled={!terminal || !running || busy}
          onClick={() =>
            void perform(async () => {
              await api(`/${selected}/terminals/${terminal}`, 'POST', {
                action: 'input',
                data: terminalLine + '\n',
              });
            })
          }
        >
          {t('sandbox.sendLine')}
        </button>
      </section>
      {env?.profile === 'desktop' && (
        <section className="space-y-3 rounded border p-4">
          <h2 className="font-semibold">{t('sandbox.desktop')}</h2>
          <button
            className={button}
            disabled={!running || busy}
            onClick={() =>
              void perform(async () => {
                const shot = await api<{ base64: string }>(`/${selected}/desktop`);
                setImage(`data:image/png;base64,${shot.base64}`);
              })
            }
          >
            {t('sandbox.screenshot')}
          </button>
          {image && (
            <img src={image} alt={t('sandbox.desktopImage')} className="w-full rounded border" />
          )}
        </section>
      )}
    </main>
  );
}
