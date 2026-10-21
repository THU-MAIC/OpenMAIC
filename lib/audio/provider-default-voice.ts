/** Provider-local default, then its catalogue's first entry; otherwise use legacy defaults. */
export function configuredDefaultVoice(
  options?: Record<string, unknown>,
  voices?: readonly { id: string }[],
): string | undefined {
  const voice = options?.defaultVoice;
  return typeof voice === 'string' && voice.trim() ? voice.trim() : voices?.[0]?.id;
}
