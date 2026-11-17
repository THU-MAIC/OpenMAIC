'use client';

import { BookOpen, List, MessageSquare } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export type ClassroomPanel = 'directory' | 'lecture' | 'chat';

/** Navigation only. The existing rail and ChatArea own their contents. */
export function MobileClassroomNav({
  active,
  onSelect,
}: {
  readonly active: ClassroomPanel | null;
  readonly onSelect: (panel: ClassroomPanel) => void;
}) {
  const { t } = useI18n();
  return (
    <nav
      className="mobile-classroom-nav"
      data-testid="mobile-classroom-nav"
      aria-label={t('mobileClassroom.materials')}
    >
      {(
        [
          ['directory', List, t('mobileClassroom.directory')],
          ['lecture', BookOpen, t('mobileClassroom.lecture')],
          ['chat', MessageSquare, t('chat.tabs.chat')],
        ] as const
      ).map(([panel, Icon, label]) => (
        <button
          key={panel}
          type="button"
          aria-label={label}
          aria-pressed={active === panel}
          data-testid={`mobile-nav-${panel}`}
          onClick={() => onSelect(panel)}
        >
          <Icon size={20} aria-hidden />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
