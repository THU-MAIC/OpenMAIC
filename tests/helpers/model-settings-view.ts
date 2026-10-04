/**
 * A workspace model settings view for tests of code that reads what the
 * server's model settings let the client do (lib/model-settings/capabilities).
 */
import { MODEL_SLOTS, type SlotId } from '@/lib/config/model-slots';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { modelSettingsClient } from '@/lib/model-settings/client';

export interface TestSlotTarget {
  /** The registry id the slot's provider serves the capability with. */
  registryId: string;
  providerId?: string;
  presetId?: string;
  modelId?: string;
}

/** A view whose slots resolve to the given targets; every other slot is unassigned. */
export function modelSettingsViewFor(
  slots: Partial<Record<SlotId, TestSlotTarget | null>>,
): ModelSettingsView {
  return {
    revision: null,
    policy: { allowWorkspaceProviders: true },
    presets: [],
    providers: [],
    slots: MODEL_SLOTS.map((definition) => {
      const target = slots[definition.id];
      return {
        slot: definition.id,
        parent: definition.parent,
        capability: definition.capability,
        configOnly: false,
        locked: false,
        effective: target
          ? {
              status: 'assigned' as const,
              resolvedAt: definition.id,
              source: 'deployment',
              requirements: [],
              providerId: target.providerId ?? target.registryId,
              providerSource: 'deployment' as const,
              presetId: target.presetId ?? target.registryId,
              registryId: target.registryId,
              ...(target.modelId ? { modelId: target.modelId } : {}),
            }
          : { status: 'unassigned' as const },
      };
    }),
  };
}

/** Make the page's model settings client answer with this view (null: nothing read yet). */
export function setModelSettingsViewForTests(
  slots: Partial<Record<SlotId, TestSlotTarget | null>> | null,
): void {
  modelSettingsClient.adopt(slots ? modelSettingsViewFor(slots) : null);
}
