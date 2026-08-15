'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  ArchiveRestore,
  ChevronRight,
  CloudOff,
  FolderKanban,
  Home,
  LibraryBig,
  Menu,
  Moon,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/hooks/use-theme';
import {
  WorkspaceImportController,
  useWorkspaceImport,
} from '@/components/workspace/workspace-import-controller';

const navigation = [
  { href: '/', label: '工作台', icon: Home },
  { href: '/courses', label: '我的课程', icon: FolderKanban },
  { href: '/library', label: '课程资源库', icon: LibraryBig },
  { href: '/imports', label: '导入记录', icon: ArchiveRestore },
  { href: '/offline', label: '离线资源', icon: CloudOff },
];

function WorkspaceShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { openImporter } = useWorkspaceImport();
  const { resolvedTheme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Keep the server and first client render deterministic; read the browser's
  // real connectivity immediately after hydration.
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobilePanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    queueMicrotask(() => setOnline(navigator.onLine));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => setQuery(searchParams.get('q') ?? ''));
  }, [searchParams]);

  useEffect(() => {
    queueMicrotask(() => setMobileOpen(false));
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    const menuButton = menuButtonRef.current;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        mobilePanelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      menuButton?.focus();
    };
  }, [mobileOpen]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    router.push(`/courses${suffix}`);
  };

  const sidebar = (
    <aside className="flex h-full w-[252px] flex-col border-r border-violet-100/80 bg-white/90 px-3 py-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#17131d]/95">
      <div className="flex h-14 items-center gap-3 px-3">
        <Link href="/" className="flex min-w-0 items-center gap-3" aria-label="OpenMAIC 工作台">
          <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-2xl bg-violet-100 ring-1 ring-violet-200/70 dark:bg-violet-950 dark:ring-violet-800">
            <Image src="/openmaic-mark.png" width={32} height={32} alt="OpenMAIC" priority />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight">OpenMAIC</p>
            <p className="truncate text-[11px] text-muted-foreground">教师课程工作台</p>
          </div>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto rounded-xl md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭导航"
        >
          <X />
        </Button>
      </div>

      <Button
        onClick={openImporter}
        className="mx-2 mt-5 h-11 justify-start rounded-xl bg-violet-600 px-4 shadow-sm shadow-violet-200 hover:bg-violet-700 dark:shadow-none"
      >
        <Upload className="size-4" />
        导入课程资源
      </Button>

      <nav className="mt-5 space-y-1" aria-label="工作台导航">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMobileOpen(false)}
              className={cn(
                'group flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-sm transition-colors',
                active
                  ? 'bg-violet-50 font-medium text-violet-700 dark:bg-violet-950/70 dark:text-violet-200'
                  : 'text-muted-foreground hover:bg-[#f6f2fa] hover:text-foreground dark:hover:bg-white/5',
              )}
            >
              <Icon
                className={cn('size-[18px]', active && 'text-violet-600 dark:text-violet-300')}
              />
              <span className="flex-1">{item.label}</span>
              {active && <ChevronRight className="size-3.5 opacity-60" />}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 px-2">
        <p className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
          创作
        </p>
        <Link
          href="/create"
          className="flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-sm text-muted-foreground transition-colors hover:bg-[#f6f2fa] hover:text-foreground dark:hover:bg-white/5"
        >
          <Sparkles className="size-[18px]" />
          AI 创建新课程
        </Link>
      </div>

      <div className="mt-auto space-y-3 px-2 pt-6">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/25">
          <div className="flex items-center gap-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">
            {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            {online ? '网络增强可用' : '当前处于离线模式'}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-emerald-800/70 dark:text-emerald-300/70">
            已保存课程的核心内容可在本机打开
          </p>
        </div>
        <Link
          href="/offline"
          className="flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          <Settings2 className="size-4" />
          存储与离线设置
        </Link>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen bg-[#f7f4f0] text-foreground dark:bg-[#100d14]">
      <div className="fixed inset-y-0 left-0 z-40 hidden md:block">{sidebar}</div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            className="absolute inset-0 bg-black/35 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航"
          />
          <div
            ref={mobilePanelRef}
            role="dialog"
            aria-modal="true"
            aria-label="工作台导航"
            className="relative h-full w-[280px] max-w-[86vw]"
          >
            {sidebar}
          </div>
        </div>
      )}

      <div className="md:pl-[252px]">
        <header className="sticky top-0 z-30 flex h-[72px] items-center gap-3 border-b border-violet-100/70 bg-[#fbf9f6]/88 px-4 backdrop-blur-xl dark:border-white/10 dark:bg-[#100d14]/88 lg:px-7">
          <Button
            ref={menuButtonRef}
            variant="ghost"
            size="icon-lg"
            className="rounded-xl md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="打开导航"
          >
            <Menu />
          </Button>

          <form onSubmit={submitSearch} className="relative min-w-0 flex-1 sm:max-w-xl">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索课程、学科或知识点"
              className="h-11 rounded-2xl border-white bg-white/90 pl-10 shadow-sm shadow-violet-100/50 focus-visible:ring-violet-300 dark:border-white/10 dark:bg-white/5 dark:shadow-none"
            />
          </form>

          <div className="ml-auto flex items-center gap-1.5">
            <div
              className={cn(
                'hidden h-9 items-center gap-1.5 rounded-full border px-3 text-xs sm:flex',
                online
                  ? 'border-emerald-100 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-amber-100 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
              )}
            >
              {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {online ? '在线' : '离线'}
            </div>
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon-lg"
              className="rounded-xl"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            >
              {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
            </Button>
            <Button
              onClick={openImporter}
              className="hidden h-10 rounded-xl bg-violet-600 px-4 hover:bg-violet-700 lg:inline-flex"
            >
              <Plus />
              导入课程
            </Button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceImportController>
      <Suspense
        fallback={
          <div className="min-h-screen bg-[#f7f4f0] dark:bg-[#100d14]">
            <div className="h-[72px] border-b border-violet-100/70 bg-white/70 dark:border-white/10 dark:bg-white/5" />
          </div>
        }
      >
        <WorkspaceShellInner>{children}</WorkspaceShellInner>
      </Suspense>
    </WorkspaceImportController>
  );
}
