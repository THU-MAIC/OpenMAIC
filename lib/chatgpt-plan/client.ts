'use client';

import { useSyncExternalStore } from 'react';
import { CHATGPT_PLAN_API, type ChatGPTPlanStatus } from './shared';

type Answer<T> = { ok: true; data: T } | { ok: false; reason?: string; error?: string };

export async function callChatGPTPlan<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<Answer<T>> {
  try {
    const response = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store' }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json().catch(() => ({}));
    return response.ok && data.success
      ? { ok: true, data: data as T }
      : {
          ok: false,
          reason: data.reason,
          error: data.errorCode === 'PROVIDER_ACTION_REQUIRED' ? data.error : undefined,
        };
  } catch {
    return { ok: false };
  }
}

const empty = { status: null, statusFailed: false };
let snapshot: { status: ChatGPTPlanStatus | null; statusFailed: boolean } = empty;
const listeners = new Set<() => void>();
let loading: Promise<ChatGPTPlanStatus | null> | undefined;

function loadStatus() {
  const request = callChatGPTPlan<{ status: ChatGPTPlanStatus }>(CHATGPT_PLAN_API.status).then(
    (answer) => {
      const status = answer.ok ? answer.data.status : null;
      if (loading === request) {
        snapshot = { status, statusFailed: !answer.ok };
        loading = undefined;
        listeners.forEach((listener) => listener());
      }
      return status;
    },
  );
  loading = request;
  return request;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void loadStatus();
    window.addEventListener('focus', loadStatus);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener('focus', loadStatus);
      loading = undefined;
      snapshot = empty;
    }
  };
}

const getSnapshot = () => snapshot;
const getEmpty = () => empty;
const skip = () => () => {};

/** Settings, model pickers and their billing link share one read and one focus listener. */
export function useChatGPTPlanStatus(offered: boolean) {
  const state = useSyncExternalStore(
    offered ? subscribe : skip,
    offered ? getSnapshot : getEmpty,
    getEmpty,
  );
  return { ...state, loadStatus };
}

export type PlanAccountState = ReturnType<typeof useChatGPTPlanStatus>;
