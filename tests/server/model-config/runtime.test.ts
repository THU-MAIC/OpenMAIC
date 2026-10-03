import { describe, expect, it } from 'vitest';

import { lookupFromLayers, requestMayChoose } from '@/lib/server/model-config/runtime';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

const deployment: ModelConfigLayer = {
  source: 'deployment',
  config: {
    providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } },
    // What DEFAULT_MODEL translates to: the default model, and the agent off.
    slots: { llm: 'openai:gpt-5.6', agent: null },
  },
};
const workspace: ModelConfigLayer = {
  source: 'workspace',
  config: {
    providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
    slots: { llm: 'ds:deepseek-v4-pro' },
  },
};

describe('lookupFromLayers', () => {
  it('answers with the server default where the workspace sets nothing', () => {
    expect(lookupFromLayers('course.outline', { deployment, workspace: null })).toMatchObject({
      status: 'assigned',
      resolvedAt: 'llm',
      source: 'default',
      locked: false,
      providerId: 'openai',
      providerSource: 'deployment',
      apiKey: 'sk-operator',
      modelId: 'gpt-5.6',
    });
    expect(lookupFromLayers('agent', { deployment, workspace: null })).toEqual(
      expect.objectContaining({ status: 'disabled', source: 'default', locked: false }),
    );
  });

  it('lets the workspace replace a server default on the same node', () => {
    expect(lookupFromLayers('llm', { deployment, workspace })).toMatchObject({
      status: 'assigned',
      resolvedAt: 'llm',
      source: 'workspace',
      providerId: 'ds',
      providerSource: 'workspace',
    });
  });

  it('keeps a server default on a child below a workspace choice on its parent', () => {
    // agent: null is the deployment's default on the agent node itself: it is
    // nearer than the workspace's llm, so the agent stays off until the
    // workspace sets the agent itself.
    expect(lookupFromLayers('agent', { deployment, workspace })).toMatchObject({
      status: 'disabled',
      resolvedAt: 'agent',
      source: 'default',
    });
  });

  it('lets a workspace use a deployment provider without seeing it as its own', () => {
    const picks: ModelConfigLayer = {
      source: 'workspace',
      config: { slots: { 'course.content': 'openai:gpt-5.6-mini' } },
    };
    expect(
      lookupFromLayers('course.content.slide', { deployment, workspace: picks }),
    ).toMatchObject({
      source: 'workspace',
      providerSource: 'deployment',
      apiKey: 'sk-operator',
      modelId: 'gpt-5.6-mini',
    });
  });

  it('has nothing without any layer', () => {
    expect(lookupFromLayers('llm', { deployment: null, workspace: null })).toEqual({
      status: 'unassigned',
      slot: 'llm',
    });
  });

  it('leaves out providers a workspace added once allowUserKeys is false', () => {
    const deployment: ModelConfigLayer = {
      source: 'deployment',
      config: {
        allowUserKeys: false,
        providers: { op: { preset: 'deepseek', apiKey: 'k' } },
        slots: { llm: 'op:deepseek-v4-pro' },
      },
    };
    const workspace: ModelConfigLayer = {
      source: 'workspace',
      config: {
        providers: { mine: { preset: 'openai', apiKey: 'k' } },
        slots: {
          'course.outline': 'mine:gpt-5.6',
          'course.actions': { model: 'op:deepseek-v4-flash', fallback: 'mine:gpt-5.6' },
          classroom: 'op:deepseek-v4-flash',
        },
      },
    };
    const layers = { deployment, workspace };
    // Named its own provider: follows the deployment's llm instead.
    expect(lookupFromLayers('course.outline', layers)).toMatchObject({
      providerId: 'op',
      modelId: 'deepseek-v4-pro',
    });
    // Its own model on a deployment provider stays, without its fallback.
    const actions = lookupFromLayers('course.actions', layers);
    expect(actions).toMatchObject({ providerId: 'op', modelId: 'deepseek-v4-flash' });
    expect(actions).not.toHaveProperty('fallback');
    expect(lookupFromLayers('classroom', layers)).toMatchObject({
      modelId: 'deepseek-v4-flash',
    });

    // Allowed again (the default), the workspace's providers count.
    const { allowUserKeys: _off, ...rest } = deployment.config;
    const allowed = { ...deployment, config: rest };
    expect(lookupFromLayers('course.outline', { deployment: allowed, workspace })).toMatchObject({
      providerId: 'mine',
    });
  });

  it('keeps references to an id the deployment also declares without user keys', () => {
    const deployment: ModelConfigLayer = {
      source: 'deployment',
      config: {
        allowUserKeys: false,
        providers: { op: { preset: 'deepseek', apiKey: 'k' } },
      },
    };
    const workspace: ModelConfigLayer = {
      source: 'workspace',
      config: {
        providers: { op: { preset: 'openai', apiKey: 'k' } },
        slots: { llm: { model: 'op:deepseek-v4-pro', fallback: 'op:deepseek-v4-flash' } },
      },
    };
    expect(lookupFromLayers('llm', { deployment, workspace })).toMatchObject({
      providerId: 'op',
      modelId: 'deepseek-v4-pro',
      fallback: { modelId: 'deepseek-v4-flash' },
    });
  });
});

describe('requestMayChoose', () => {
  const locked: ModelConfigLayer = {
    source: 'deployment',
    config: { ...deployment.config, lock: ['llm'] },
  };
  const yml = { legacyDefaults: false };
  const legacy = { legacyDefaults: true };
  const at = (slot: 'llm' | 'agent' | 'image', layers: Parameters<typeof lookupFromLayers>[1]) =>
    lookupFromLayers(slot, layers);

  it('lets a request name its own model where nothing is assigned', () => {
    expect(requestMayChoose(at('llm', { deployment: null, workspace: null }), yml)).toBe(true);
  });

  it("keeps openmaic.yml's default, the workspace's choice and a lock", () => {
    expect(requestMayChoose(at('llm', { deployment, workspace: null }), yml)).toBe(false);
    expect(requestMayChoose(at('llm', { deployment, workspace }), yml)).toBe(false);
    expect(requestMayChoose(at('llm', { deployment, workspace }), legacy)).toBe(false);
    expect(requestMayChoose(at('llm', { deployment: locked, workspace: null }), legacy)).toBe(
      false,
    );
    const all: ModelConfigLayer = { source: 'deployment', config: { lock: 'all' } };
    expect(requestMayChoose(at('image', { deployment: all, workspace: null }), yml)).toBe(false);
  });

  it('ranks a default translated from the legacy variables below the request, as before', () => {
    expect(requestMayChoose(at('llm', { deployment, workspace: null }), legacy)).toBe(true);
    expect(requestMayChoose(at('agent', { deployment, workspace: null }), legacy)).toBe(true);
    expect(requestMayChoose(at('agent', { deployment, workspace: null }), yml)).toBe(false);
  });
});
