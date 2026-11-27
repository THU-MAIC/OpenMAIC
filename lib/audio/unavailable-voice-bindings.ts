const unavailableBindings = new Set<string>();
const noticedBindings = new Set<string>();
type VoiceBinding = { providerId: string; voiceId: string };

export function voiceBindingKey(binding: VoiceBinding, accountScope?: string): string {
  const key = `${binding.providerId}\0${binding.voiceId}`;
  return accountScope ? `${accountScope}\0${key}` : key;
}

export function isVoiceBindingUnavailable(binding: VoiceBinding, accountScope?: string): boolean {
  return unavailableBindings.has(voiceBindingKey(binding, accountScope));
}

export function markVoiceBindingUnavailable(binding: VoiceBinding, accountScope?: string): string {
  const key = voiceBindingKey(binding, accountScope);
  unavailableBindings.add(key);
  return key;
}

export function clearVoiceBindingUnavailable(binding: VoiceBinding, accountScope?: string): void {
  const key = voiceBindingKey(binding, accountScope);
  unavailableBindings.delete(key);
  noticedBindings.delete(key);
}

export function markVoiceBindingNoticeShown(key: string): boolean {
  if (noticedBindings.has(key)) return false;
  noticedBindings.add(key);
  return true;
}

export function clearUnavailableVoiceBindingsForTests(): void {
  unavailableBindings.clear();
  noticedBindings.clear();
}
