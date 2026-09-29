import { describe, expect, it, vi } from 'vitest';

import type { ApplyResult, ModelSettingsChange, SlotView } from '@/lib/model-settings/client';
import {
  draftFor,
  draftProblem,
  emptyDraft,
  fallbackChange,
  fillRecommended,
  modelChange,
  newProviderId,
  providerChange,
  providerFields,
  providerLabel,
  refComplete,
  runFirstRunSetup,
  slotChange,
  slotKey,
  slotSource,
  splitRef,
  switchOffChange,
  switchOnChange,
  wizardAssignments,
} from '@/lib/model-settings/edit';

import { chatPreset, compatiblePreset, makeView, withSlots, workspaceProvider } from './fixtures';

function slot(overrides: Partial<SlotView> & Pick<SlotView, 'slot'>): SlotView {
  return {
    parent: 'llm',
    capability: 'chat',
    configOnly: false,
    locked: false,
    effective: { status: 'unassigned' },
    ...overrides,
  };
}

describe('model references', () => {
  it('splits at the first colon only', () => {
    expect(splitRef('acme:org/model:free')).toEqual({
      providerId: 'acme',
      modelId: 'org/model:free',
    });
    expect(splitRef('tavily')).toEqual({ providerId: 'tavily' });
  });

  it('needs a model for chat, not for search', () => {
    expect(refComplete('acme', 'chat')).toBe(false);
    expect(refComplete('acme:m', 'chat')).toBe(true);
    expect(refComplete('tavily', 'webSearch')).toBe(true);
    expect(refComplete('', 'webSearch')).toBe(false);
  });
});

describe('slot changes', () => {
  const outline = slot({ slot: 'course.outline' });

  it('clears a slot to follow its parent, and writes null to turn it off', () => {
    expect(slotChange(outline, { kind: 'follow' })).toEqual({
      kind: 'slots',
      clear: ['course.outline'],
    });
    expect(slotChange(outline, { kind: 'off' })).toEqual({
      kind: 'slots',
      set: { 'course.outline': null },
    });
  });

  it('writes a plain reference, or an object when there is a fallback', () => {
    expect(modelChange(outline, 'acme:acme-large')).toEqual({
      kind: 'slots',
      set: { 'course.outline': 'acme:acme-large' },
    });
    expect(
      slotChange(outline, { kind: 'model', model: 'acme:acme-large', fallback: 'b:m' }),
    ).toEqual({
      kind: 'slots',
      set: { 'course.outline': { model: 'acme:acme-large', fallback: 'b:m' } },
    });
  });

  it('keeps the fallback when the model changes, and can drop it', () => {
    const withFallback = slot({
      slot: 'classroom',
      assignment: { model: 'acme:acme-large', fallback: 'b:m' },
    });
    expect(modelChange(withFallback, 'acme:acme-small')).toEqual({
      kind: 'slots',
      set: { classroom: { model: 'acme:acme-small', fallback: 'b:m' } },
    });
    expect(fallbackChange(withFallback, undefined)).toEqual({
      kind: 'slots',
      set: { classroom: 'acme:acme-large' },
    });
    expect(fallbackChange(slot({ slot: 'agent', assignment: 'a:m' }), 'b:n')).toEqual({
      kind: 'slots',
      set: { agent: { model: 'a:m', fallback: 'b:n' } },
    });
  });

  it('keeps other assignment fields, and thinking only for the same model', () => {
    const agent = slot({
      slot: 'agent',
      assignment: { model: 'a:m', thinking: { effort: 'high' }, contextWindow: 64000 },
    });
    expect(modelChange(agent, 'a:m')).toEqual({
      kind: 'slots',
      set: { agent: { model: 'a:m', thinking: { effort: 'high' }, contextWindow: 64000 } },
    });
    expect(modelChange(agent, 'a:other')).toEqual({
      kind: 'slots',
      set: { agent: { model: 'a:other', contextWindow: 64000 } },
    });
  });

  it('never writes a fallback for a media slot', () => {
    const tts = slot({ slot: 'tts', parent: null, capability: 'tts' });
    expect(slotChange(tts, { kind: 'model', model: 'acme:voice', fallback: 'b:x' })).toEqual({
      kind: 'slots',
      set: { tts: 'acme:voice' },
    });
  });

  it('switches a media slot off with null and back on to exactly what it held', () => {
    const memory = new Map();
    const tts = slot({ slot: 'tts', parent: null, capability: 'tts', assignment: 'acme:voice' });
    expect(switchOffChange(tts, memory)).toEqual({ kind: 'slots', set: { tts: null } });
    const off = { ...tts, assignment: null };
    expect(switchOnChange(off, memory)).toEqual({ kind: 'slots', set: { tts: 'acme:voice' } });
  });

  it('switches a slot that had nothing of its own back on by clearing it', () => {
    const memory = new Map();
    const image = slot({ slot: 'image', parent: null, capability: 'image' });
    switchOffChange(image, memory);
    expect(switchOnChange({ ...image, assignment: null }, memory)).toEqual({
      kind: 'slots',
      clear: ['image'],
    });
  });

  it('does not guess when it does not know what an off slot held', () => {
    const video = slot({ slot: 'video', parent: null, capability: 'video', assignment: null });
    expect(switchOnChange(video, new Map())).toBeUndefined();
  });
});

describe('where a slot comes from', () => {
  const target = {
    providerId: 'acme',
    providerSource: 'deployment' as const,
    presetId: 'acme',
    registryId: 'openai',
    modelId: 'acme-large',
  };

  it('tells inherited, own, deployment and default apart', () => {
    const effective = (resolvedAt: string, source: string) => ({
      status: 'assigned' as const,
      resolvedAt: resolvedAt as SlotView['slot'],
      source,
      requirements: [],
      ...target,
    });
    expect(
      slotSource(slot({ slot: 'classroom', effective: effective('llm', 'workspace') })),
    ).toEqual({ kind: 'inherited', from: 'llm' });
    expect(
      slotSource(slot({ slot: 'classroom', effective: effective('classroom', 'workspace') })),
    ).toEqual({ kind: 'own' });
    expect(
      slotSource(slot({ slot: 'llm', parent: null, effective: effective('llm', 'deployment') })),
    ).toEqual({ kind: 'deployment' });
    expect(
      slotSource(slot({ slot: 'llm', parent: null, effective: effective('llm', 'default') })),
    ).toEqual({ kind: 'default' });
    expect(slotSource(slot({ slot: 'course.outline' }))).toEqual({
      kind: 'inherited',
      from: 'llm',
    });
  });

  it('names i18n keys without dots', () => {
    expect(slotKey('course.content.slide')).toBe('courseContentSlide');
    expect(slotKey('webSearch')).toBe('webSearch');
  });
});

describe('providers', () => {
  it('gives a new provider an id free in the view', () => {
    const view = makeView({ providers: [workspaceProvider('acme'), workspaceProvider('acme-2')] });
    expect(newProviderId(view, 'acme')).toBe('acme-3');
    expect(newProviderId(makeView(), 'Some Preset_ID')).toBe('some-preset-id');
  });

  it('shows the preset name only for a provider named after it', () => {
    const view = makeView({ providers: [workspaceProvider('acme'), workspaceProvider('work')] });
    expect(providerLabel(view, 'acme')).toBe('Acme');
    expect(providerLabel(view, 'work')).toBe('work');
  });

  it('asks for a base URL and models only where the preset needs them', () => {
    expect(providerFields(chatPreset, emptyDraft('acme'))).toEqual({
      baseUrl: true,
      baseUrlRequired: false,
      models: false,
      chatOnlyEndpoint: false,
    });
    expect(
      providerFields(chatPreset, { ...emptyDraft('acme'), baseUrl: 'https://x.test' }),
    ).toMatchObject({ models: true, chatOnlyEndpoint: true });
    expect(providerFields(compatiblePreset, emptyDraft(compatiblePreset.id))).toEqual({
      baseUrl: true,
      baseUrlRequired: true,
      models: true,
      chatOnlyEndpoint: false,
    });
    expect(draftProblem(compatiblePreset, emptyDraft(compatiblePreset.id))).toBe('baseUrl');
    expect(
      draftProblem(compatiblePreset, {
        ...emptyDraft(compatiblePreset.id),
        baseUrl: 'https://x.test',
      }),
    ).toBe('models');
    expect(draftProblem(undefined, emptyDraft(''))).toBe('preset');
  });

  it('adds a provider with only the fields given', () => {
    expect(
      providerChange(
        'compat',
        {
          ...emptyDraft(compatiblePreset.id),
          apiKey: ' sk-test ',
          baseUrl: 'https://x.test/v1',
          models: 'a, b\nb',
        },
        compatiblePreset,
      ),
    ).toEqual({
      kind: 'provider',
      id: 'compat',
      preset: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'https://x.test/v1',
      models: ['a', 'b'],
    });
    expect(providerChange('acme', emptyDraft('acme'), chatPreset)).toEqual({
      kind: 'provider',
      id: 'acme',
      preset: 'acme',
    });
  });

  it('asks for a new key when the stored one cannot be read, and sends it', () => {
    const broken = { ...workspaceProvider('acme'), key: { set: true, unreadable: true } };
    const draft = draftFor(broken);
    expect(draft.keyAction).toBe('replace');
    expect(
      providerChange('acme', { ...draft, apiKey: 'sk-new' }, chatPreset, broken),
    ).toMatchObject({ apiKey: 'sk-new' });
    expect(
      providerChange('acme', { ...draft, keyAction: 'remove' }, chatPreset, broken),
    ).toMatchObject({ apiKey: '' });
  });

  it('keeps a pinned model list editable, and clears it only when emptied', () => {
    const pinned = { ...workspaceProvider('acme'), models: ['acme-large'] };
    const draft = draftFor(pinned);
    expect(providerFields(chatPreset, draft, pinned).models).toBe(true);
    expect(providerChange('acme', draft, chatPreset, pinned)).toMatchObject({
      models: ['acme-large'],
    });
    expect(providerChange('acme', { ...draft, models: ' ' }, chatPreset, pinned)).toMatchObject({
      models: null,
    });
  });

  it('keeps, replaces or removes the stored key of an existing provider', () => {
    const existing = workspaceProvider('acme');
    const draft = draftFor(existing);
    expect(draft.keyAction).toBe('keep');
    // A key-only edit: the hidden model list is left out, so the server keeps it.
    expect(providerChange('acme', draft, chatPreset, existing)).toEqual({
      kind: 'provider',
      id: 'acme',
      preset: 'acme',
      baseUrl: null,
    });
    expect(
      providerChange(
        'acme',
        { ...draft, keyAction: 'replace', apiKey: 'new' },
        chatPreset,
        existing,
      ),
    ).toMatchObject({ apiKey: 'new' });
    expect(
      providerChange('acme', { ...draft, keyAction: 'remove' }, chatPreset, existing),
    ).toMatchObject({ apiKey: '' });
  });
});

describe('first-run setup', () => {
  it('fills only empty, unlocked, visible slots with the recommendations', () => {
    const assigned = {
      status: 'assigned' as const,
      resolvedAt: 'tts' as const,
      source: 'deployment',
      requirements: [],
      providerId: 'srv',
      providerSource: 'deployment' as const,
      presetId: 'x',
      registryId: 'x',
    };
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      'course.content.slide': { locked: true },
      tts: { effective: assigned },
    });
    expect(wizardAssignments(view, chatPreset, 'acme')).toEqual({ llm: 'acme:acme-large' });
  });

  it('prefixes every recommendation with the new provider id', () => {
    const view = makeView({ providers: [workspaceProvider('acme-2')] });
    expect(wizardAssignments(view, chatPreset, 'acme-2')).toEqual({
      llm: 'acme-2:acme-large',
      'course.content.slide': 'acme-2:acme-small',
      tts: 'acme-2:acme-voice',
    });
  });

  it('falls back to the first chat model the new provider lists', () => {
    const provider = {
      ...workspaceProvider('compat', compatiblePreset),
      capabilities: { chat: { models: [{ id: 'm-1', name: 'm-1' }] } },
    };
    const view = makeView({ providers: [provider] });
    expect(wizardAssignments(view, compatiblePreset, 'compat')).toEqual({ llm: 'compat:m-1' });
  });

  it('assigns only what the provider as created offers: an own endpoint is chat only', () => {
    const chatOnly = {
      ...workspaceProvider('acme'),
      baseUrl: 'https://llm.example.test/v1',
      capabilities: { chat: chatPreset.capabilities.chat! },
    };
    const view = makeView({ providers: [chatOnly] });
    expect(wizardAssignments(view, chatPreset, 'acme')).toEqual({
      llm: 'acme:acme-large',
      'course.content.slide': 'acme:acme-small',
    });
  });

  it('lets a model list the user gave win over the recommended chat models', () => {
    const pinned = {
      ...workspaceProvider('acme'),
      models: ['house-model'],
      capabilities: {
        ...chatPreset.capabilities,
        chat: { models: [{ id: 'house-model', name: 'house-model' }] },
      },
    };
    const view = makeView({ providers: [pinned] });
    expect(wizardAssignments(view, chatPreset, 'acme')).toEqual({
      llm: 'acme:house-model',
      tts: 'acme:acme-voice',
    });
  });

  it('assigns a provider without a catalogue by itself, and nothing for a missing one', () => {
    const preset = { ...chatPreset, recommended: { webSearch: 'acme-search' } };
    const view = makeView({ providers: [workspaceProvider('acme')] });
    expect(wizardAssignments(view, preset, 'acme')).toEqual({
      webSearch: 'acme',
      llm: 'acme:acme-large',
    });
    expect(wizardAssignments(makeView(), chatPreset, 'acme')).toEqual({});
  });

  it('does not touch slots the workspace has set, even to off', () => {
    const view = withSlots(makeView({ providers: [workspaceProvider('acme')] }), {
      tts: { assignment: null },
    });
    expect(wizardAssignments(view, chatPreset, 'acme')).not.toHaveProperty('tts');
  });

  it('adds the provider, then fills the slots against the new view', async () => {
    const before = makeView({ revision: null });
    const afterProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const calls: ModelSettingsChange[] = [];
    const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
      calls.push(change);
      return { ok: true, view: afterProvider };
    });

    const result = await runFirstRunSetup(apply, before, chatPreset, {
      ...emptyDraft('acme'),
      apiKey: 'sk-test',
    });

    expect(result).toEqual({
      status: 'done',
      providerId: 'acme',
      assigned: ['llm', 'course.content.slide', 'tts'],
    });
    expect(calls).toEqual([
      { kind: 'provider', id: 'acme', preset: 'acme', apiKey: 'sk-test' },
      {
        kind: 'slots',
        set: {
          llm: 'acme:acme-large',
          'course.content.slide': 'acme:acme-small',
          tts: 'acme:acme-voice',
        },
      },
    ]);
  });

  it('goes on after a lost answer when the reloaded view has the provider', async () => {
    const reloaded = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unconfirmed', message: 'lost', view: reloaded })
      .mockResolvedValueOnce({ ok: true, view: reloaded });
    const result = await runFirstRunSetup(apply, makeView(), chatPreset, emptyDraft('acme'));
    expect(result).toMatchObject({ status: 'done', providerId: 'acme' });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('counts a lost answer to the slot write as done when the reload shows it landed', async () => {
    const withProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const landed = withSlots(withProvider, {
      llm: {
        assignment: 'acme:acme-large',
        effective: {
          status: 'assigned',
          resolvedAt: 'llm',
          source: 'workspace',
          requirements: [],
          providerId: 'acme',
          providerSource: 'workspace',
          presetId: 'acme',
          registryId: 'x',
          modelId: 'acme-large',
        },
      },
    });
    const apply = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'unconfirmed', message: 'lost', view: landed });
    expect(await fillRecommended(apply, withProvider, chatPreset, 'acme')).toMatchObject({
      status: 'done',
    });
    // Retried later with nothing left to fill and llm set: done, without a write.
    expect(
      await fillRecommended(apply, landed, { ...chatPreset, recommended: {} }, 'acme'),
    ).toMatchObject({
      status: 'done',
      assigned: [],
    });
  });

  it('stops when the provider is refused, and reports a partial setup', async () => {
    const refused = vi.fn(
      async (): Promise<ApplyResult> => ({ ok: false, reason: 'invalid', message: 'bad key' }),
    );
    expect(await runFirstRunSetup(refused, makeView(), chatPreset, emptyDraft('acme'))).toEqual({
      status: 'failed',
      reason: 'invalid',
      message: 'bad key',
    });
    expect(refused).toHaveBeenCalledTimes(1);

    const afterProvider = makeView({ revision: 1, providers: [workspaceProvider('acme')] });
    const slotsRefused = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, view: afterProvider })
      .mockResolvedValueOnce({ ok: false, reason: 'conflict', message: 'changed' });
    expect(
      await runFirstRunSetup(slotsRefused, makeView(), chatPreset, emptyDraft('acme')),
    ).toEqual({ status: 'partial', providerId: 'acme', reason: 'conflict', message: 'changed' });
  });
});
