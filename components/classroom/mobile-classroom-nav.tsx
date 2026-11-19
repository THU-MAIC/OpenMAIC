'use client';

import { BookOpen, List, MessageSquare, Users } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

export type ClassroomPanel = 'directory' | 'lecture' | 'chat';

/**
 * Navigation only. `null` is the classroom (roundtable) view; the existing rail
 * and ChatArea own the other panels' contents.
 */
export function MobileClassroomNav({
  active,
  live,
  onSelect,
}: {
  readonly active: ClassroomPanel | null;
  /** Someone at the roundtable is speaking; shown on the classroom tab while it is hidden. */
  readonly live?: boolean;
  readonly onSelect: (panel: ClassroomPanel | null) => void;
}) {
  const { t } = useI18n();
  return (
    <nav
      className="mobile-classroom-nav"
      data-testid="mobile-classroom-nav"
      aria-label={t('mobileClassroom.materials')}
      role="tablist"
    >
      {(
        [
          [null, 'classroom', Users, t('mobileClassroom.classroom')],
          ['directory', 'directory', List, t('mobileClassroom.directory')],
          ['lecture', 'lecture', BookOpen, t('mobileClassroom.lecture')],
          ['chat', 'chat', MessageSquare, t('mobileClassroom.chat')],
        ] as const
      ).map(([panel, id, Icon, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-label={label}
          aria-selected={active === panel}
          data-testid={`mobile-nav-${id}`}
          data-live={panel === null && live && active !== null ? 'true' : undefined}
          onClick={() => onSelect(panel)}
        >
          <Icon size={20} aria-hidden />
          <span>{label}</span>
          {panel === null && (
            <i className="mobile-classroom-nav-live" aria-hidden>
              <b />
              <b />
              <b />
            </i>
          )}
        </button>
      ))}
    </nav>
  );
}
