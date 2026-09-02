import { describe, expect, it, vi } from 'vitest';

import {
  canAcceptMaterialFiles,
  createMaterialUploadIdentityGate,
  MaterialSlotLedger,
  retryMaterialUpload,
  scheduleMaterialUploadBatch,
  uploadFirstSuccessfulThenParallel,
} from '@/lib/workbench/material-upload-scheduling';

describe('composer material upload scheduling', () => {
  it('waits for the first successful upload before starting the remaining batch', async () => {
    let releaseFirst!: (success: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const upload = vi.fn((item: number) => (item === 1 ? first : Promise.resolve(true)));

    const pending = uploadFirstSuccessfulThenParallel([1, 2, 3], upload);
    expect(upload).toHaveBeenCalledTimes(1);
    releaseFirst(true);
    await pending;
    expect(upload.mock.calls.map(([item]) => item)).toEqual([1, 2, 3]);
  });

  it('keeps failed leading uploads serial until one establishes the owner cookie', async () => {
    let releaseSecond!: (success: boolean) => void;
    const second = new Promise<boolean>((resolve) => {
      releaseSecond = resolve;
    });
    const upload = vi.fn((item: number) => {
      if (item === 1) return Promise.resolve(false);
      if (item === 2) return second;
      return Promise.resolve(true);
    });

    const pending = uploadFirstSuccessfulThenParallel([1, 2, 3], upload);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    releaseSecond(true);
    await pending;
    expect(upload.mock.calls.map(([item]) => item)).toEqual([1, 2, 3]);
  });

  it('rejects selections that would exceed the 20-material composer cap', () => {
    expect(canAcceptMaterialFiles(19, 1)).toBe(true);
    expect(canAcceptMaterialFiles(19, 2)).toBe(false);
  });

  it('counts handed-off completed materials in the same 20-slot ledger', () => {
    const ledger = new MaterialSlotLedger(19);
    expect(ledger.canAccept(1)).toBe(true);
    expect(ledger.canAccept(2)).toBe(false);
    ledger.removeCompleted();
    expect(ledger).toMatchObject({ occupied: 18, pending: 0 });
  });

  it('serializes batches until identity is established, then parallelizes later batches', async () => {
    const gate = createMaterialUploadIdentityGate();
    let releaseFirst!: (success: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const upload = vi.fn((item: number) => (item === 1 ? first : Promise.resolve(true)));

    const firstBatch = scheduleMaterialUploadBatch(gate, [1, 2], upload);
    const secondBatch = scheduleMaterialUploadBatch(gate, [3, 4], upload);
    await vi.waitFor(() => expect(upload.mock.calls.map(([item]) => item)).toEqual([1]));

    releaseFirst(true);
    await Promise.all([firstBatch, secondBatch]);
    expect(gate.identityEstablished).toBe(true);
    expect(upload.mock.calls.map(([item]) => item)).toEqual([1, 2, 3, 4]);

    const thirdBatch = scheduleMaterialUploadBatch(gate, [5, 6], upload);
    expect(upload.mock.calls.slice(-2).map(([item]) => item)).toEqual([5, 6]);
    await thirdBatch;
  });

  it('limits established uploads to three concurrent requests across batches', async () => {
    const gate = createMaterialUploadIdentityGate();
    gate.identityEstablished = true;
    let active = 0;
    let maximum = 0;
    const upload = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return true;
    });

    const first = scheduleMaterialUploadBatch(gate, [1, 2, 3, 4], upload);
    const second = scheduleMaterialUploadBatch(gate, [5, 6, 7], upload);
    await Promise.all([first, second]);
    expect(upload).toHaveBeenCalledTimes(7);
    expect(maximum).toBe(3);
  });

  it('retries 429 and 503 twice with exponential delays', async () => {
    const upload = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);

    await expect(retryMaterialUpload(upload, sleep)).resolves.toBe('ok');
    expect(upload).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('preserves queued and in-flight reservations when clear removes completed pills', () => {
    const ledger = new MaterialSlotLedger();
    ledger.reserve(2);
    ledger.settle(true);
    expect(ledger).toMatchObject({ occupied: 2, pending: 1 });

    ledger.clearCompleted();
    expect(ledger).toMatchObject({ occupied: 1, pending: 1 });
    ledger.settle(true);
    expect(ledger).toMatchObject({ occupied: 1, pending: 0 });
    expect(ledger.canAccept(20)).toBe(false);
    ledger.removeCompleted();
    expect(ledger.canAccept(20)).toBe(true);
  });
});
