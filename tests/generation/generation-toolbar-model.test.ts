/**
 * The home toolbar's course model: a picker whenever the workspace may set
 * the llm slot and has chat models, with nothing selected while no model is
 * set (no default model), so picking one sets the slot.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { modelSettingsClient, type ModelSettingsView } from '@/lib/model-settings/client';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

function render(view: ModelSettingsView) {
  modelSettingsClient.adopt(view);
  return renderToStaticMarkup(
    createElement(GenerationToolbar, {
      courseMaterials: [],
      onCourseMaterialsAdd: () => {},
      onCourseMaterialRemove: () => {},
      onPdfError: () => {},
      onSettingsOpen: () => {},
    }),
  );
}

function withChatProvider(view: ModelSettingsView): ModelSettingsView {
  view.providers = [
    {
      id: 'openai',
      preset: 'openai',
      presetName: 'OpenAI',
      presetKind: 'single',
      source: 'workspace',
      capabilities: { chat: { models: [{ id: 'gpt-5', name: 'GPT-5' }] } },
      key: { set: true },
    },
  ];
  return view;
}

afterEach(() => modelSettingsClient.adopt(null));

describe('the toolbar course model', () => {
  it('offers the picker with nothing selected when no model is set', () => {
    const markup = render(withChatProvider(modelSettingsViewFor({})));
    expect(markup).toContain('aria-label="toolbar.pickModel"');
    expect(markup).not.toContain('toolbar.configureProvider');
  });

  it('shows the model set for the workspace', () => {
    const markup = render(
      withChatProvider(
        modelSettingsViewFor({
          llm: { registryId: 'openai', providerId: 'openai', modelId: 'gpt-5' },
        }),
      ),
    );
    expect(markup).toContain('aria-label="OpenAI / gpt-5"');
  });

  it('asks to set up a model when there is nothing to pick', () => {
    const markup = render(modelSettingsViewFor({}));
    expect(markup).toContain('toolbar.configureProvider');
    expect(markup).not.toContain('toolbar.pickModel');
  });

  it('renders no model control at all when the deployment locks the default model', () => {
    const view = withChatProvider(
      modelSettingsViewFor({
        llm: { registryId: 'openai', providerId: 'openai', modelId: 'gpt-5' },
      }),
    );
    view.slots.find((slot) => slot.slot === 'llm')!.locked = true;
    const markup = render(view);
    expect(markup).not.toContain('gpt-5');
    expect(markup).not.toContain('toolbar.pickModel');
    expect(markup).not.toContain('toolbar.configureProvider');
  });
});
