import { describe, expect, it } from 'vitest';

import {
  assignmentsForNewProvider,
  entryConfigured,
  flipSwitch,
  serviceEntries,
  thinkingChange,
} from '@/lib/model-settings/services';
import type { PresetView, SlotView } from '@/lib/model-settings/client';

import { chatPreset, makeView, withLlm, withSlots, workspaceProvider } from './fixtures';

const tavily: PresetView = {
  id: 'tavily',
  name: 'Tavily',
  kind: 'single',
  capabilities: { webSearch: { models: [] } },
  requiresBaseUrl: false,
  customEndpoint: false,
  recommended: {},
};

describe('serviceEntries', () => {
  it('lists the providers first, then each service no provider of its preset covers', () => {
    const view = makeView({
      presets: [chatPreset, tavily],
      providers: [
        { ...workspaceProvider('operator'), source: 'deployment', key: undefined },
        workspaceProvider('mine', { ...chatPreset, id: 'other' }),
      ],
    });
    const entries = serviceEntries(view, 'chat', ['acme', 'other', 'nobody']);
    expect(entries.map(({ id, state }) => [id, state])).toEqual([
      ['operator', 'deployment'],
      ['mine', 'workspace'],
      // `acme` is covered by the server's provider of that preset; `other` by `mine`.
      ['nobody', 'server-only'],
    ]);
  });

  it('offers a service the workspace may add under its preset id', () => {
    const view = makeView({ presets: [chatPreset, tavily] });
    expect(serviceEntries(view, 'webSearch', ['tavily'])).toEqual([
      { id: 'tavily', registryId: 'tavily', state: 'available', preset: tavily },
    ]);
  });

  it('counts a key the server can no longer read as not configured', () => {
    const view = makeView({
      providers: [{ ...workspaceProvider('acme'), key: { set: true, unreadable: true } }],
    });
    const [entry] = serviceEntries(view, 'chat', []);
    expect(entryConfigured(entry)).toBe(false);
    expect(entryConfigured(entry, false)).toBe(true);
  });
});

describe('assignmentsForNewProvider', () => {
  it('fills only the empty, unlocked roots of what the provider serves', () => {
    const view = withSlots(withLlm(makeView({ providers: [workspaceProvider('acme')] })), {
      tts: { locked: true },
    });
    expect(assignmentsForNewProvider(view, 'acme')).toEqual({ webSearch: 'acme' });
  });
});

describe('thinkingChange', () => {
  const slot = (assignment: SlotView['assignment']): SlotView => ({
    slot: 'llm',
    parent: null,
    capability: 'chat',
    configOnly: false,
    locked: false,
    source: { kind: 'workspace' },
    assignment,
    effective: { status: 'unassigned' },
  });

  it('keeps the model and its other fields, and drops back to a plain reference', () => {
    expect(thinkingChange(slot('acme:large'), { enabled: true })).toEqual({
      kind: 'slots',
      set: { llm: { model: 'acme:large', thinking: { enabled: true } } },
    });
    expect(
      thinkingChange(slot({ model: 'acme:large', thinking: { enabled: true } }), undefined),
    ).toEqual({ kind: 'slots', set: { llm: 'acme:large' } });
    expect(
      thinkingChange(slot({ model: 'acme:large', fallback: 'acme:small' }), { enabled: false }),
    ).toEqual({
      kind: 'slots',
      set: { llm: { model: 'acme:large', fallback: 'acme:small', thinking: { enabled: false } } },
    });
  });

  it('has nothing to change on a slot without a model of its own', () => {
    expect(thinkingChange(slot(undefined), { enabled: true })).toBeUndefined();
  });
});

describe('flipSwitch', () => {
  const tts = (view: ReturnType<typeof makeView>) =>
    view.slots.find((slot) => slot.slot === 'tts')!;

  it('remembers what it turned off only once the server took it', async () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: 'acme:acme-voice' },
    });
    const memory = new Map();
    const refused = await flipSwitch(
      async () => ({ ok: false, reason: 'conflict', message: 'stale' }),
      view,
      tts(view),
      false,
      memory,
    );
    expect(refused).toMatchObject({ ok: false });
    expect(memory.has('tts')).toBe(false);
    await flipSwitch(async () => ({ ok: true, view }), view, tts(view), false, memory);
    expect(memory.get('tts')).toBe('acme:acme-voice');
  });

  it('says when nothing can serve a slot it has nothing to restore for', async () => {
    const view = makeView();
    const result = await flipSwitch(
      async () => ({ ok: true, view }),
      view,
      view.slots.find((slot) => slot.slot === 'image')!,
      true,
      new Map(),
    );
    expect(result).toBe('needs-service');
  });
});
