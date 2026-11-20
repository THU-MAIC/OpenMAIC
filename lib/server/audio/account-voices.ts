import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { AccountVoice, BuiltInTTSProviderId } from '@/lib/audio/types';
import {
  getVoiceRegistrationAdapter,
  type VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';
import type { MediaConnection } from '@/lib/server/model-config/media';

/** Only a provider declared by this workspace supplies its own account key.
 * A workspace selecting a deployment provider still uses the deployment's key. */
export function personalVoiceAccount(connection: MediaConnection) {
  if (connection.managed || connection.origin !== 'configuration' || !connection.apiKey) return;
  const adapter = getVoiceRegistrationAdapter(connection.providerId);
  if (!adapter?.listVoices) return;
  const baseUrl =
    connection.baseUrl ??
    TTS_PROVIDERS[connection.providerId as BuiltInTTSProviderId]?.defaultBaseUrl;
  if (!baseUrl) return;
  const config: VoiceRegistrationConfig = {
    baseUrl,
    apiKey: connection.apiKey,
    model: connection.modelId,
    publicOnly: connection.userEndpoint,
    managed: connection.managed,
  };
  return { list: adapter.listVoices, remove: adapter.deleteVoice, config };
}

export async function listAccountVoicesForConnection(
  connection: MediaConnection,
  signal?: AbortSignal,
): Promise<AccountVoice[]> {
  if (connection.voices?.length) return [];
  const account = personalVoiceAccount(connection);
  if (!account) return [];
  return account.list(account.config, signal);
}
