/**
 * Neutral name for the strict provider transport.
 *
 * The implementation lives in {@link ./audio-provider-fetch} because it began
 * with the TTS/ASR adapters, but it is not audio-specific: it validates every
 * redirect hop, pins connect-time DNS to vetted answers and normalizes request
 * bodies across the two undici copies. Non-audio providers (for example the
 * MinerU Cloud document parser) use the same transport under this name so
 * import sites do not read as if they were audio code.
 *
 * This module is a re-export only — the behavior is defined once, in the
 * original module, so audio and non-audio callers cannot drift.
 */
export {
  audioProviderFetch as providerFetch,
  createAudioProviderFetch as createProviderFetch,
  resolveAllowLocalNetworks,
  destroyAudioProviderDispatchersForTests,
  type AudioProviderFetchPolicy as ProviderFetchPolicy,
  type AudioProviderFetch as ProviderFetch,
} from '@/lib/server/audio-provider-fetch';
