import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { WebFetchSettings } from '@/components/settings/web-fetch-settings';
import type { ModelSettingsView } from '@/lib/model-settings/client';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
it('shows the shared-key hint beside editable provider credentials', () => {
  const html = renderToStaticMarkup(
    createElement(WebFetchSettings, {
      view: {
        allowUserKeys: true,
        slots: [],
        providers: [],
        presets: [],
        revision: null,
      } as ModelSettingsView,
      apply: vi.fn(),
      entry: {
        id: 'reader',
        registryId: 'kimi',
        state: 'available',
        metadata: {
          id: 'kimi',
          name: 'Kimi',
          requiresApiKey: true,
          credentialPresets: ['kimi', 'kimi-coding-plan'],
        },
      },
    }),
  );
  expect(html).toContain('settings.webFetchSharedKeyHint');
  expect(html).toContain('web-fetch-api-key-reader');
});

it('offers an optional key field for a keyless reader that takes one', () => {
  const panel = (metadata: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(WebFetchSettings, {
        view: {
          allowUserKeys: true,
          slots: [],
          providers: [],
          presets: [],
          revision: null,
        } as ModelSettingsView,
        apply: vi.fn(),
        entry: {
          id: 'reader',
          registryId: String(metadata.id),
          state: 'available',
          metadata: metadata as never,
        },
      }),
    );
  const optional = panel({
    id: 'keenable',
    name: 'Keenable',
    requiresApiKey: false,
    apiKeyOptional: true,
  });
  expect(optional).toContain('web-fetch-api-key-reader');
  expect(optional).toContain('settings.optionalOverride');
  expect(panel({ id: 'builtin', name: 'Built-in', requiresApiKey: false })).not.toContain(
    'web-fetch-api-key-reader',
  );
});
