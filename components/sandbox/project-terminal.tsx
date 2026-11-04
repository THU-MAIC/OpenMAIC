'use client';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { sandboxApi, sandboxBase } from './client';
import { createTerminalInput } from './terminal-input';

/** Closing this view only detaches the stream. The explicit close action ends the shell. */
export function ProjectTerminal({
  environmentId,
  terminalId,
  transport: customTransport,
}: {
  environmentId: string;
  terminalId: string;
  transport?: {
    send: (
      body: { action: 'input'; data: string } | { action: 'resize'; cols: number; rows: number },
    ) => Promise<unknown>;
    eventsUrl: string;
  };
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let dispose = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (controller.signal.aborted || !element.current) return;
      const term = new Terminal({
        cursorBlink: true,
        scrollback: 2000,
        fontSize: 13,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element.current);
      fit.fit();
      const transport = createTerminalInput(
        customTransport?.send ??
          ((body) => sandboxApi(`/${environmentId}/terminals/${terminalId}`, 'POST', body)),
        setError,
      );
      const input = term.onData(transport.input);
      let resizeTimer: ReturnType<typeof setTimeout>;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fit.fit();
          transport.resize(Math.min(400, term.cols), Math.min(200, term.rows));
        }, 200);
      });
      observer.observe(element.current);
      dispose = () => {
        clearTimeout(resizeTimer);
        observer.disconnect();
        transport.dispose();
        input.dispose();
        term.dispose();
      };
      term.writeln(t('sandbox.connecting'));
      const response = await fetch(
        customTransport?.eventsUrl ??
          `${sandboxBase}/${environmentId}/terminals/${terminalId}/events`,
        {
          headers: { 'X-OpenMAIC-Sandbox': '1' },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error(t('sandbox.terminalConnectFailed'));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error(t('sandbox.terminalBufferLimit'));
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const packet = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (!packet.startsWith('data: ')) continue;
            const event = JSON.parse(packet.slice(6));
            if (event.type === 'ready') term.writeln(t('sandbox.terminalConnected'));
            if (event.type === 'output') {
              const bytes = Uint8Array.from(atob(event.base64), (c) => c.charCodeAt(0));
              await new Promise<void>((resolve) => term.write(bytes, resolve));
            }
          }
        }
        if (!controller.signal.aborted) setError(t('sandbox.terminalEnded'));
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })().catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : t('sandbox.terminalDisconnected'));
    });
    return () => {
      controller.abort();
      dispose();
    };
  }, [environmentId, terminalId, attempt, t, customTransport]);
  return (
    <div className="space-y-2">
      <div ref={element} className="h-80 min-w-0 bg-black p-2" />
      {error && (
        <p role="status" className="text-sm">
          {error}{' '}
          <button
            className="underline"
            onClick={() => {
              setError('');
              setAttempt((n) => n + 1);
            }}
          >
            {t('sandbox.reconnect')}
          </button>
        </p>
      )}
    </div>
  );
}
