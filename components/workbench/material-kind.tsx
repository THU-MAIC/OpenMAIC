/**
 * A file's kind, from its type (or, without one, its extension): one icon per
 * kind, told apart by its tint, the colours people already know these formats
 * by. Shared by the knowledge base list and the composer's material pills, so
 * a file looks the same in both.
 */
import {
  File,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export const MATERIAL_KINDS = {
  pdf: { Icon: FileText, tint: 'text-rose-500 dark:text-rose-400' },
  document: { Icon: FileText, tint: 'text-blue-600 dark:text-blue-400' },
  slides: { Icon: Presentation, tint: 'text-orange-500 dark:text-orange-400' },
  sheet: { Icon: FileSpreadsheet, tint: 'text-emerald-600 dark:text-emerald-400' },
  image: { Icon: FileImage, tint: 'text-sky-600 dark:text-sky-400' },
  audio: { Icon: FileAudio, tint: 'text-fuchsia-600 dark:text-fuchsia-400' },
  video: { Icon: FileVideo, tint: 'text-indigo-600 dark:text-indigo-400' },
  text: { Icon: FileText, tint: 'text-[color:var(--ws-ink-mute)]' },
  other: { Icon: File, tint: 'text-[color:var(--ws-ink-mute)]' },
} as const;

export type MaterialKind = keyof typeof MATERIAL_KINDS;

export function materialKind(mime?: string, name?: string): MaterialKind {
  const type = mime?.toLowerCase() ?? '';
  const extension = name?.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type.includes('presentation') || extension === 'pptx' || extension === 'ppt') return 'slides';
  if (
    type.includes('spreadsheet') ||
    type === 'text/csv' ||
    ['xlsx', 'xls', 'csv'].includes(extension)
  ) {
    return 'sheet';
  }
  if (type.includes('wordprocessing') || type === 'application/msword' || extension === 'docx') {
    return 'document';
  }
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/') || ['md', 'markdown', 'txt'].includes(extension)) return 'text';
  return 'other';
}

/** The kind's icon in its tint; size and stroke are the caller's. */
export function MaterialKindIcon({
  mime,
  name,
  className,
  strokeWidth,
}: {
  readonly mime?: string;
  readonly name?: string;
  readonly className?: string;
  readonly strokeWidth?: number;
}) {
  const { Icon, tint } = MATERIAL_KINDS[materialKind(mime, name)];
  return <Icon aria-hidden="true" strokeWidth={strokeWidth} className={cn(className, tint)} />;
}
