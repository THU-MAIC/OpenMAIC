'use client';

import {
  Settings,
  Sun,
  Moon,
  Monitor,
  ArrowLeft,
  Loader2,
  Download,
  FileDown,
  Package,
  User,
  LogOut,
  Shield,
  Type,
  Users,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { LanguageSwitcher } from './language-switcher';
import { StudentManager } from './classroom/student-manager';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useState, useEffect, useRef, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useSession, signOut } from 'next-auth/react';
import { PENDING_SCENE_ID } from '@/lib/store/stage';

const FONT_SIZES = [
  { label: 'Small', value: 14 },
  { label: 'Default', value: 16 },
  { label: 'Large', value: 18 },
] as const;

const FONT_SIZE_KEY = 'openmaic-ui-font-size';

function applyRootFontSize(size: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${size}px`;
}

interface HeaderProps {
  readonly currentSceneTitle: string;
}

export function Header({ currentSceneTitle }: HeaderProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const isInstructor = session?.user?.role === 'INSTRUCTOR';
  const canManageStudents = isAdmin || isInstructor;
  const stageId = useMediaStageId();
  const [prefOpen, setPrefOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [studentsOpen, setStudentsOpen] = useState(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const prefRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const studentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(FONT_SIZE_KEY);
    const parsed = saved ? Number(saved) : 16;
    const next = Number.isFinite(parsed) && [14, 16, 18].includes(parsed) ? parsed : 16;
    setFontSize(next);
    applyRootFontSize(next);
  }, []);

  useEffect(() => {
    applyRootFontSize(fontSize);
    localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
  }, [fontSize]);

  // Export
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const scenes = useStageStore((s) => s.scenes);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);

  const canExport =
    scenes.length > 0 &&
    generatingOutlines.length === 0 &&
    failedOutlines.length === 0 &&
    Object.values(mediaTasks).every((task) => task.status === 'done' || task.status === 'failed');

  // Close dropdown when clicking outside
  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (exportMenuOpen && exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (prefOpen && prefRef.current && !prefRef.current.contains(e.target as Node)) {
        setPrefOpen(false);
      }
      if (studentsOpen && studentsRef.current && !studentsRef.current.contains(e.target as Node)) {
        setStudentsOpen(false);
      }
    },
    [exportMenuOpen, userMenuOpen, prefOpen, studentsOpen],
  );

  useEffect(() => {
    if (exportMenuOpen || userMenuOpen || prefOpen || studentsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [exportMenuOpen, userMenuOpen, prefOpen, studentsOpen, handleClickOutside]);

  const canEditScenePrompt = !!currentSceneId && currentSceneId !== PENDING_SCENE_ID;
  const inScenePromptFlow =
    searchParams.get('newScenePrompt') === '1' || searchParams.get('editScenePrompt') === '1';
  const cameFromContent = searchParams.get('from') === 'content';
  const classroomId = pathname.startsWith('/classroom/') ? pathname.split('/')[2] : null;

  const homeUrl = isInstructor ? '/instructor' : '/';

  const handleBack = useCallback(() => {
    if ((inScenePromptFlow || cameFromContent) && classroomId) {
      router.push(`/instructor/classrooms/${encodeURIComponent(classroomId)}/content`);
      return;
    }
    router.push(homeUrl);
  }, [cameFromContent, classroomId, homeUrl, inScenePromptFlow, router]);

  const openScenePromptEditor = useCallback(() => {
    if (!canEditScenePrompt || !currentSceneId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('scene', currentSceneId);
    params.set('editScenePrompt', '1');
    router.push(`${pathname}?${params.toString()}`);
  }, [canEditScenePrompt, currentSceneId, pathname, router, searchParams]);

  return (
    <>
      <header className="h-14 px-3 sm:h-20 sm:px-8 flex items-center justify-between z-10 bg-transparent gap-2 sm:gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={handleBack}
            className="shrink-0 p-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            title={t('generation.backToHome')}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex flex-col min-w-0">
            <span className="text-[10px] uppercase tracking-widest font-bold text-gray-400 dark:text-gray-500 mb-0.5">
              {t('stage.currentScene')}
            </span>
            <h1
              className="text-base sm:text-xl font-bold text-gray-800 dark:text-gray-200 tracking-tight truncate"
              suppressHydrationWarning
            >
              {currentSceneTitle || t('common.loading')}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-4 bg-white/60 dark:bg-gray-800/60 backdrop-blur-md px-2 py-1.5 rounded-full border border-gray-100/50 dark:border-gray-700/50 shadow-sm shrink-0 max-w-[calc(100vw-5rem)] overflow-x-auto">
          {canManageStudents && (
            <>
              <button
                onClick={openScenePromptEditor}
                disabled={!canEditScenePrompt}
                className={cn(
                  'h-9 rounded-full px-3 text-xs font-semibold transition-all flex items-center gap-1.5',
                  canEditScenePrompt
                    ? 'text-purple-700 dark:text-purple-300 bg-purple-100/80 dark:bg-purple-900/35 hover:bg-purple-200/90 dark:hover:bg-purple-900/55 cursor-pointer'
                    : 'text-gray-300 dark:text-gray-600 bg-gray-100/70 dark:bg-gray-800/70 cursor-not-allowed',
                )}
                title="Edit current scene with prompt"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Edit Prompt</span>
              </button>

              <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />
            </>
          )}

          {/* Student Management — admin and instructor */}
          {canManageStudents && stageId && (
            <>
              <div className="relative" ref={studentsRef}>
                <button
                  onClick={() => setStudentsOpen((v) => !v)}
                  className="h-9 w-9 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all flex items-center justify-center"
                  title="Student Management"
                >
                  <Users className="h-4 w-4" />
                </button>
                {studentsOpen && (
                  <div className="absolute top-full mt-2 right-0 z-50">
                    <StudentManager stageId={stageId} open={studentsOpen} onOpenChange={setStudentsOpen} />
                  </div>
                )}
              </div>
              <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />
            </>
          )}

          {/* Language Selector */}
          <LanguageSwitcher onOpen={() => setPrefOpen(false)} />

          <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

          {/* Preferences Button — admin and instructor */}
          {(isAdmin || isInstructor) && (
            <div className="relative" ref={prefRef}>
              <button
                onClick={() => setPrefOpen((v) => !v)}
                className="h-9 w-9 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all flex items-center justify-center"
                title="Preferences"
              >
                <Settings className="h-4 w-4" />
              </button>

              {prefOpen && (
                <div className="absolute top-full mt-2 right-0 w-64 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-slate-900/95 p-4 shadow-2xl backdrop-blur-md z-50">
                  <p className="mb-3 text-sm font-semibold text-gray-800 dark:text-white">Preferences</p>

                  {/* Theme */}
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-slate-400">Theme</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(['light', 'dark', 'system'] as const).map((t_) => (
                        <button
                          key={t_}
                          type="button"
                          onClick={() => setTheme(t_)}
                          className={cn(
                            'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors',
                            theme === t_
                              ? 'border-purple-400 bg-purple-500/10 text-purple-600 dark:text-purple-300'
                              : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/10',
                          )}
                        >
                          {t_ === 'light' && <Sun className="h-3 w-3" />}
                          {t_ === 'dark' && <Moon className="h-3 w-3" />}
                          {t_ === 'system' && <Monitor className="h-3 w-3" />}
                          {t_.charAt(0).toUpperCase() + t_.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Size */}
                  <div className="mt-3 space-y-2">
                    <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-slate-400">Size</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {FONT_SIZES.map((size) => (
                        <button
                          key={size.value}
                          type="button"
                          onClick={() => setFontSize(size.value)}
                          className={cn(
                            'inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs transition-colors',
                            fontSize === size.value
                              ? 'border-purple-400 bg-purple-500/10 text-purple-600 dark:text-purple-300'
                              : 'border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-white/10',
                          )}
                        >
                          <Type className="h-3 w-3" /> {size.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Admin-only advanced settings */}
                  {session.user.role === 'ADMIN' && (
                    <div className="mt-3 border-t border-gray-200 dark:border-white/10 pt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setPrefOpen(false);
                          router.push('/admin/system-config/settings');
                        }}
                        className="w-full rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-left text-xs font-medium text-amber-700 dark:text-amber-200 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20"
                      >
                        Open General Settings
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

          {/* User Menu */}
          {session?.user && (
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen((v) => !v)}
                className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-purple-600 text-white text-xs font-semibold hover:ring-2 hover:ring-purple-400 transition-all"
                title={session.user.name ?? session.user.email ?? 'User'}
              >
                {session.user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={session.user.image} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  (session.user.name?.[0] ?? session.user.email?.[0] ?? 'U').toUpperCase()
                )}
              </button>
              {userMenuOpen && (
                <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden z-50 min-w-[200px]">
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                      {session.user.name ?? 'User'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {session.user.email}
                    </p>
                    <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 font-medium">
                      {session.user.role}
                    </span>
                  </div>
                  <button
                    onClick={() => { setUserMenuOpen(false); router.push('/profile'); }}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-300"
                  >
                    <User className="w-4 h-4" /> Profile & Privacy
                  </button>
                  {session.user.role === 'ADMIN' && (
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push('/admin'); }}
                      className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-300"
                    >
                      <Shield className="w-4 h-4" /> Admin Panel
                    </button>
                  )}
                  <button
                    onClick={() => signOut({ callbackUrl: '/auth/signin' })}
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2 text-red-500 border-t border-gray-100 dark:border-gray-700"
                  >
                    <LogOut className="w-4 h-4" /> Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Export Dropdown */}
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => {
              if (canExport && !isExporting) setExportMenuOpen(!exportMenuOpen);
            }}
            disabled={!canExport || isExporting}
            title={
              canExport
                ? isExporting
                  ? t('export.exporting')
                  : t('export.pptx')
                : t('share.notReady')
            }
            className={cn(
              'shrink-0 p-2 rounded-full transition-all',
              canExport && !isExporting
                ? 'text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed opacity-50',
            )}
          >
            {isExporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
          {exportMenuOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportPPTX();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <FileDown className="w-4 h-4 text-gray-400 shrink-0" />
                <span>{t('export.pptx')}</span>
              </button>
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportResourcePack();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <Package className="w-4 h-4 text-gray-400 shrink-0" />
                <div>
                  <div>{t('export.resourcePack')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.resourcePackDesc')}
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>
      </header>
    </>
  );
}
