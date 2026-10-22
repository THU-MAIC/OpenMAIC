'use client';
import { FileCode2, Folder, LockKeyhole } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Render only the source paths authorized by the learning API. Directories are presentation. */
export function FileExplorer({
  files,
  active,
  dirty,
  editable,
  onSelect,
}: {
  files: string[];
  active: string;
  dirty: (path: string) => boolean;
  editable: (path: string) => boolean;
  onSelect: (path: string) => void;
}) {
  const { t } = useI18n();
  function entries(prefix: string): React.ReactNode {
    const children = [
      ...new Set(
        files.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]!),
      ),
    ].sort((a, b) => {
      const directory = (name: string) => files.some((p) => p.startsWith(`${prefix}${name}/`));
      return Number(directory(b)) - Number(directory(a)) || a.localeCompare(b);
    });
    return children.map((name) => {
      const path = prefix + name;
      if (files.some((p) => p.startsWith(path + '/')))
        return (
          <details key={path} open className="ml-2">
            <summary className="cursor-pointer truncate py-1.5 text-xs">
              <Folder className="mr-1 inline" size={14} />
              {name}
            </summary>
            {entries(path + '/')}
          </details>
        );
      return (
        <button
          key={path}
          type="button"
          title={path}
          aria-label={path}
          aria-pressed={active === path}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          onClick={() => onSelect(path)}
        >
          <FileCode2 size={14} className="shrink-0 text-sky-500" />
          <span className="truncate">{name}</span>
          {dirty(path) ? (
            <span aria-label={t('pblV3.workbench.unsaved')}>●</span>
          ) : (
            !editable(path) && (
              <LockKeyhole size={11} className="ml-auto shrink-0 text-muted-foreground" />
            )
          )}
        </button>
      );
    });
  }
  return (
    <nav aria-label={t('pblV3.files')} className="h-full overflow-auto p-2">
      {entries('')}
    </nav>
  );
}
