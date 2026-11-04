import { SandboxRequestError } from './client';
import { getClientTranslation } from '@/lib/i18n';
/** Coalesce keystrokes while a remote request is in flight; never replay uncertain input. */
export function createTerminalInput(
  send: (
    body: { action: 'input'; data: string } | { action: 'resize'; cols: number; rows: number },
  ) => Promise<unknown>,
  onError: (message: string) => void,
) {
  const encoder = new TextEncoder();
  let pending = '';
  let bytes = 0;
  let resize: { action: 'resize'; cols: number; rows: number } | undefined;
  let sending = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function fail(message: string) {
    stopped = true;
    pending = '';
    resize = undefined;
    clearTimeout(timer);
    onError(message);
  }
  function schedule() {
    if (stopped || sending || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 20);
  }
  async function flush() {
    if (stopped || sending) return;
    const body = pending ? { action: 'input' as const, data: pending } : resize;
    if (!body) return;
    if (body.action === 'input') pending = '';
    else resize = undefined;
    sending = true;
    try {
      for (let attempt = 0; ; attempt++) {
        if (stopped) return;
        try {
          await send(body);
          break;
        } catch (error) {
          // The environment lock rejected this request before provider dispatch.
          // A lost response (or any other error) is never safe to replay.
          if (
            !(error instanceof SandboxRequestError) ||
            error.reason !== 'ENVIRONMENT_BUSY' ||
            attempt >= 4
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      if (body.action === 'input') bytes -= encoder.encode(body.data).length;
    } catch (error) {
      if (!stopped)
        fail(
          getClientTranslation(
            error instanceof SandboxRequestError && error.reason === 'ENVIRONMENT_BUSY'
              ? 'sandbox.inputBusy'
              : 'sandbox.inputUnconfirmed',
          ),
        );
    } finally {
      sending = false;
      if (pending || resize) schedule();
    }
  }
  return {
    input(data: string) {
      if (stopped) return;
      bytes += encoder.encode(data).length;
      if (bytes > 16384) {
        fail(getClientTranslation('sandbox.inputFull'));
        return;
      }
      pending += data;
      schedule();
    },
    resize(cols: number, rows: number) {
      if (stopped) return;
      resize = { action: 'resize', cols, rows };
      schedule();
    },
    dispose() {
      stopped = true;
      pending = '';
      resize = undefined;
      clearTimeout(timer);
    },
  };
}
