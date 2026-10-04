/**
 * Research is decided from a successful read of the model settings: a failed
 * read stops the save (nothing is decided from it), a recovered read decides,
 * and starting generation decides again from the current settings.
 */
import { describe, expect, it, vi } from 'vitest';

import { withResearchDecision } from '@/lib/generation/research-decision';
import type { UserRequirements } from '@/lib/types/generation';
import { modelCapabilities, requireModelCapabilities } from '@/lib/model-settings/capabilities';
import { createModelSettingsClient } from '@/lib/model-settings/client';

import { modelSettingsViewFor } from '../helpers/model-settings-view';

const withSearch = modelSettingsViewFor({ webSearch: { registryId: 'tavily' } });
const session: { requirements: UserRequirements } = {
  requirements: { requirement: 'Teach photosynthesis.' },
};

describe('the research decision', () => {
  it('is not made from a failed read, and is made once the read recovers', async () => {
    let online = false;
    const fetch = vi.fn(async () => {
      if (!online) throw new TypeError('offline');
      return Response.json(withSearch);
    });
    const client = createModelSettingsClient(fetch);

    // Failed, and failed again: no capabilities to decide from (the caller stops).
    expect(await requireModelCapabilities(client)).toBeNull();

    online = true;
    const capabilities = await requireModelCapabilities(client);
    expect(capabilities?.known).toBe(true);
    expect(withResearchDecision(session, capabilities!).requirements.webSearch).toBe(true);
  });

  it('follows the slot at start, whatever the saved session said', () => {
    const saved = { requirements: { requirement: 'x', webSearch: true as const } };
    const without = withResearchDecision(saved, modelCapabilities(modelSettingsViewFor({})));
    expect(without.requirements.webSearch).toBeUndefined();
    const again = withResearchDecision(without, modelCapabilities(withSearch));
    expect(again.requirements.webSearch).toBe(true);
    // Unchanged decisions keep the same session object.
    expect(withResearchDecision(again, modelCapabilities(withSearch))).toBe(again);
  });
});
