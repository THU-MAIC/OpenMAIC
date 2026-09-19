import { AsyncLocalStorage } from 'node:async_hooks';

const mutationSignal = new AsyncLocalStorage<AbortSignal | undefined>();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

/** Carry one tool call's derived abort signal into its persistence transaction. */
export async function runStageMutation<T>(
  signal: AbortSignal | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  return mutationSignal.run(signal, async () => {
    const result = await mutation();
    throwIfAborted(signal);
    return result;
  });
}

/** Reject a persistence transaction whose owning tool call has been aborted. */
export function assertCurrentStageMutationActive(): void {
  throwIfAborted(mutationSignal.getStore());
}
