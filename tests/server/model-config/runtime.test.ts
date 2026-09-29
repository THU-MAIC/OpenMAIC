import { describe, expect, it } from 'vitest';

import { lookupFromLayers } from '@/lib/server/model-config/runtime';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

const deployment: ModelConfigLayer = {
  source: 'deployment',
  config: {
    providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } },
  },
};
// What DEFAULT_MODEL translates to: the default model, and the agent off.
const defaults: ModelConfigLayer = {
  source: 'default',
  config: { slots: { llm: 'openai:gpt-5.6', agent: null } },
};
const workspace: ModelConfigLayer = {
  source: 'workspace',
  config: {
    providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
    slots: { llm: 'ds:deepseek-v4-pro' },
  },
};

describe('lookupFromLayers', () => {
  it('prefers a workspace model anywhere up the tree over any default', () => {
    // The default layer holds agent: null on the agent node itself, yet the
    // workspace's llm, higher up, wins: defaults are only a second walk.
    const lookup = lookupFromLayers('agent', { deployment, workspace, defaults });
    expect(lookup.configured).toMatchObject({
      status: 'assigned',
      resolvedAt: 'llm',
      source: 'workspace',
      providerId: 'ds',
      providerSource: 'workspace',
    });
  });

  it('leaves the defaults for when the configuration says nothing', () => {
    const lookup = lookupFromLayers('course.outline', { deployment, workspace: null, defaults });
    expect(lookup.configured).toEqual({ status: 'unassigned', slot: 'course.outline' });
    expect(lookup.defaults()).toMatchObject({
      status: 'assigned',
      source: 'default',
      locked: false,
      providerId: 'openai',
      providerSource: 'deployment',
      apiKey: 'sk-operator',
      modelId: 'gpt-5.6',
    });
    expect(lookupFromLayers('agent', { deployment, workspace: null, defaults }).defaults()).toEqual(
      expect.objectContaining({ status: 'disabled', source: 'default', locked: false }),
    );
  });

  it('lets the deployment lock what it writes', () => {
    const locked: ModelConfigLayer = {
      source: 'deployment',
      config: { ...deployment.config, slots: { llm: 'openai:gpt-5.6', video: null } },
    };
    const lookup = lookupFromLayers('llm', { deployment: locked, workspace, defaults: null });
    expect(lookup.configured).toMatchObject({
      source: 'deployment',
      locked: true,
      modelId: 'gpt-5.6',
    });
    expect(
      lookupFromLayers('video', { deployment: locked, workspace, defaults: null }).configured,
    ).toMatchObject({ status: 'disabled', locked: true });
  });

  it('lets a workspace use a deployment provider without seeing it as its own', () => {
    const picks: ModelConfigLayer = {
      source: 'workspace',
      config: { slots: { 'course.content': 'openai:gpt-5.6-mini' } },
    };
    expect(
      lookupFromLayers('course.content.slide', { deployment, workspace: picks, defaults: null })
        .configured,
    ).toMatchObject({
      source: 'workspace',
      providerSource: 'deployment',
      apiKey: 'sk-operator',
      modelId: 'gpt-5.6-mini',
    });
  });

  it('has nothing without any layer', () => {
    const lookup = lookupFromLayers('llm', { deployment: null, workspace: null, defaults: null });
    expect(lookup.configured).toEqual({ status: 'unassigned', slot: 'llm' });
    expect(lookup.defaults()).toEqual({ status: 'unassigned', slot: 'llm' });
  });
});
