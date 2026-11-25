import { PROVIDER_MIGRATION_URL } from '@/lib/config/provider-migration';
import { deprecatedProviderSettings } from '@/lib/server/provider-config';
import type { ModelConfigFile } from './openmaic-yml';
import {
  sandboxConfigurationSchema,
  legacySandboxConfiguration,
} from '@/lib/sandbox/config-schema';
import { ModelConfigError } from './openmaic-yml';
import { loadModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import { RETIRED_PRESETS, retiredPresetReason } from '@/lib/config/preset-ids';
import { usesServerCredentials, selectsUpstreamModel } from './model-authorization';
import { getProviderPreset } from '@/lib/config/provider-presets';
import type { SlotCapability } from '@/lib/config/model-slots';
import {
  retiredProviderIds,
  withoutAssignmentsNaming,
  type ModelConfigLayer,
} from '@/lib/server/model-config/resolve-slot';

export interface DeploymentLayer {
  /** Providers, server defaults and locks: openmaic.yml, or the legacy configuration. */
  layer: ModelConfigLayer | null;
  /**
   * The layer came from legacy environment settings rather than a YAML file.
   * In production the remaining translation only supplies sandbox settings.
   */
  legacy: boolean;
  /** How the layer was built, and what did not carry over. */
  notices: string[];
}

/** Legacy variables of a retired preset that are still set: they no longer configure anything. */
function retiredVariableNotices(): string[] {
  return Object.values(RETIRED_PRESETS).flatMap(({ reason, envPrefix }) =>
    envPrefix &&
    ['API_KEY', 'BASE_URL', 'MODELS'].some((s) => process.env[`${envPrefix}_${s}`]?.trim())
      ? [`${envPrefix}_* is set but no longer used: ${reason}`]
      : [],
  );
}

/**
 * The file without the slot assignments that name a provider whose preset
 * this build retired (those slots follow their parents again), with a notice
 * for each such provider. The provider itself stays declared and resolves
 * nothing, so the file keeps loading.
 */
function withoutRetiredAssignments(file: ModelConfigFile): {
  config: ModelConfigFile;
  notices: string[];
} {
  const retired = retiredProviderIds([{ source: 'deployment', config: file }]);
  if (!retired.size) return { config: file, notices: [] };
  return {
    config: { ...file, slots: withoutAssignmentsNaming(file.slots, retired) } as ModelConfigFile,
    notices: [...retired].map(
      (id) =>
        `providers.${id} is not used: ${retiredPresetReason(file.providers![id].preset)}. Slots that named it follow their parents again; remove it from openmaic.yml and assign another provider`,
    ),
  };
}

export function loadDeploymentLayer(): DeploymentLayer {
  const referencedEnv = new Set<string>();
  const env = new Proxy(process.env, {
    get(target, name) {
      if (typeof name === 'string') referencedEnv.add(name);
      return Reflect.get(target, name);
    },
  });
  const loaded = loadModelConfigFile(env);
  const deprecated = deprecatedProviderSettings(process.env, referencedEnv);
  const notices = [
    ...retiredVariableNotices(),
    ...(deprecated.length
      ? [
          `Deprecated provider settings detected: ${deprecated.join(', ')}. Provider configuration comes from openmaic.yml or Model Settings. Migration: ${PROVIDER_MIGRATION_URL}`,
        ]
      : []),
  ];
  if (loaded) {
    const { config: file, notices: retiredNotices } = withoutRetiredAssignments(loaded);
    validateSandboxSdkEnvironment(file.sandbox?.enabled);
    return {
      layer: { source: 'deployment', config: file },
      legacy: false,
      notices: [
        ...retiredNotices,
        ...notices,
        ...Object.entries(file.providers ?? {})
          .filter(
            ([, provider]) =>
              usesServerCredentials(provider) &&
              Object.keys(getProviderPreset(provider.preset)?.capabilities ?? {}).some(
                (capability) => selectsUpstreamModel(provider.preset, capability as SlotCapability),
              ) &&
              !provider.models?.length,
          )
          .map(
            ([id]) =>
              `Server-managed provider "${id}" has no explicit model list. Set openmaic.yml providers.${id}.models; only default/fallback models are usable.`,
          ),
      ],
    };
  }
  const legacySandbox = legacySandboxConfiguration(process.env);
  if (legacySandbox) {
    const parsed = sandboxConfigurationSchema.safeParse(legacySandbox);
    if (!parsed.success)
      throw new ModelConfigError(
        'legacy environment',
        parsed.error.issues.map((issue) => `sandbox.${issue.path.join('.')}: ${issue.message}`),
      );
    validateSandboxSdkEnvironment(parsed.data.enabled);
    return {
      layer: { source: 'deployment', config: { sandbox: parsed.data } },
      legacy: true,
      notices,
    };
  }
  return { layer: null, legacy: false, notices };
}

function validateSandboxSdkEnvironment(enabled?: boolean) {
  if (!enabled) return;
  for (const name of ['E2B_SANDBOX_URL', 'E2B_ACCESS_TOKEN']) {
    if (process.env[name])
      throw new ModelConfigError('environment', [
        `${name}: unset this SDK override; configure sandbox.apiUrl and sandbox.domain instead`,
      ]);
  }
}
