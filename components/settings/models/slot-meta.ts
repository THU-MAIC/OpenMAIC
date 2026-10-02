import { createElement } from 'react';
import {
  Bot,
  Clapperboard,
  FileText,
  Film,
  FolderKanban,
  GraduationCap,
  Image as ImageIcon,
  ListChecks,
  ListTree,
  MessageSquareText,
  Mic,
  MousePointerClick,
  Presentation,
  Search,
  Sparkles,
  Users,
  Volume2,
  type LucideIcon,
} from 'lucide-react';

import type { SlotCapability } from '@/lib/config/model-slots';
import { slotKey } from '@/lib/model-settings/edit';

export const MS = 'settings.modelSettings';

const SLOT_ICONS: Record<string, LucideIcon> = {
  llm: Sparkles,
  'course.research': Search,
  'course.outline': ListTree,
  'course.agents': Users,
  'course.content': Presentation,
  'course.content.slide': Presentation,
  'course.content.quiz': ListChecks,
  'course.content.interactive': MousePointerClick,
  'course.content.pbl': FolderKanban,
  'course.actions': Clapperboard,
  classroom: GraduationCap,
  agent: Bot,
};

export const CAPABILITY_ICONS: Record<SlotCapability, LucideIcon> = {
  chat: MessageSquareText,
  tts: Volume2,
  asr: Mic,
  image: ImageIcon,
  video: Film,
  webSearch: Search,
  document: FileText,
};

export function SlotIcon({
  slot,
  capability,
  className,
}: {
  slot: string;
  capability: SlotCapability;
  className?: string;
}) {
  const Icon = SLOT_ICONS[slot] ?? CAPABILITY_ICONS[capability];
  return createElement(Icon, { className, 'aria-hidden': true });
}

/** Why a change did not go through, in the user's language where it is ours to say. */
export function applyErrorText(
  result: { reason: string; message: string },
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (result.reason === 'conflict') return t(`${MS}.picker.conflict`);
  if (result.reason === 'locked') return t(`${MS}.picker.lockedNow`);
  if (result.reason === 'unconfirmed') return t(`${MS}.picker.unconfirmed`);
  return result.message;
}

/** A slot's name, or its id for a slot this build has no name for. */
export function slotName(t: (key: string) => string, slot: string): string {
  const key = `${MS}.slots.${slotKey(slot)}.name`;
  const name = t(key);
  return name === key ? slot : name;
}

export function slotDescription(t: (key: string) => string, slot: string): string | undefined {
  const key = `${MS}.slots.${slotKey(slot)}.desc`;
  const text = t(key);
  return text === key ? undefined : text;
}
