'use client';

/**
 * The account block at the foot of the workspace rail, and the menu it opens.
 *
 * The workspace has no top bar, so everything the classic home keeps in its
 * floating corner controls lives here: the interface language, the theme, the
 * model and provider settings, and the ways out to the project (about, docs,
 * GitHub). A deployment with accounts adds who is signed in, a sign-in entry,
 * its own menu entries and a summary line through the shell extensions
 * (`lib/workbench/shell-extensions.tsx`); without them the block shows the
 * local learner profile, which is the identity a single-owner deployment has.
 * That profile is edited in the menu itself: the identity row opens the
 * profile editor (`UserProfileCard`, the classic editor) at the top of the
 * same panel, which grows upward from where it is anchored, and it saves
 * itself.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookText,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Github,
  Info,
  Languages,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Pencil,
  Settings,
  SunMedium,
  SquareArrowOutUpRight,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { supportedLocales } from '@/lib/i18n';
import { useBrand } from '@/lib/brand/brand-context';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { UserProfileCard } from '@/components/user-profile';
import {
  useWorkbenchShellExtensions,
  type WorkbenchShellMenuItem,
} from '@/lib/workbench/shell-extensions';
import { OPENMAIC_GITHUB_URL } from '@/lib/workbench/shell-links';
import { docsHref } from '@/lib/docs-link';
import { cn } from '@/lib/utils/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** Who the block shows: the host's identity, or the local learner profile. */
function useAccountIdentity() {
  const { t } = useI18n();
  const { identity } = useWorkbenchShellExtensions();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  if (identity) {
    return {
      signedIn: identity.signedIn,
      name: identity.name || t('profile.defaultNickname'),
      avatar: identity.avatarUrl ?? null,
      detail: identity.detail ?? null,
      /** The host owns this identity; the local profile editor cannot change it. */
      editable: false,
    };
  }
  return {
    signedIn: true,
    name: nickname || t('profile.defaultNickname'),
    avatar: avatar || null,
    detail: null,
    editable: true,
  };
}

function AccountAvatar({
  src,
  name,
  size,
  badge = false,
}: {
  readonly src: string | null;
  readonly name: string;
  readonly size: number;
  readonly badge?: boolean;
}) {
  const isImage =
    !!src && (src.startsWith('/') || src.startsWith('http') || src.startsWith('data:'));
  return (
    <span
      className="ws-avatar relative inline-flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {isImage ? (
        <img src={src} alt="" className="size-full rounded-full object-cover" />
      ) : (
        <span className="text-[13px] font-semibold">{src || name.slice(0, 1).toUpperCase()}</span>
      )}
      {badge ? <span data-testid="workspace-account-badge" className="ws-avatar-badge" /> : null}
    </span>
  );
}

/**
 * The block itself. `mini` is the folded rail's form: the avatar alone (or, while
 * signed out, the sign-in glyph and the menu's ⋯).
 */
export function WorkspaceAccountBlock({
  mini = false,
  onOpenSettings,
}: {
  readonly mini?: boolean;
  readonly onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const extensions = useWorkbenchShellExtensions();
  const account = useAccountIdentity();
  const [aboutOpen, setAboutOpen] = useState(false);
  const signIn = extensions.identity?.signIn;
  const badge = !!extensions.accountBadge;

  const menu = (trigger: ReactNode) => (
    <AccountMenu
      trigger={trigger}
      mini={mini}
      onOpenSettings={onOpenSettings}
      onOpenAbout={() => setAboutOpen(true)}
      profileEditable={account.editable}
    />
  );

  let block: ReactNode;
  if (!account.signedIn) {
    const signInLabel = signIn?.label ?? t('workspace.account.signIn');
    const more = (
      <button
        type="button"
        data-testid="workspace-account-more"
        aria-label={t('workspace.account.menu')}
        title={t('workspace.account.menu')}
        className={mini ? 'ws-mini-btn' : 'ws-account-more'}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
    );
    block = mini ? (
      <div className="flex flex-col items-center gap-1">
        {menu(more)}
        {signIn ? (
          <button
            type="button"
            data-testid="workspace-account-sign-in"
            onClick={signIn.onSelect}
            aria-label={signInLabel}
            title={signInLabel}
            className="ws-mini-btn ws-mini-accent"
          >
            <LogIn className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          {signIn ? (
            <button
              type="button"
              data-testid="workspace-account-sign-in"
              onClick={signIn.onSelect}
              className="ws-account-signin"
            >
              <LogIn className="size-4" aria-hidden="true" />
              <span className="truncate">{signInLabel}</span>
            </button>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          {menu(more)}
        </div>
        {signIn?.hint ? <div className="ws-account-hint">{signIn.hint}</div> : null}
      </div>
    );
  } else {
    const trigger = mini ? (
      <button
        type="button"
        data-testid="workspace-account"
        aria-label={t('workspace.account.menu')}
        title={account.name}
        className="ws-account-mini"
      >
        <AccountAvatar src={account.avatar} name={account.name} size={32} badge={badge} />
      </button>
    ) : (
      <button
        type="button"
        data-testid="workspace-account"
        aria-label={t('workspace.account.menu')}
        className="ws-account"
      >
        <AccountAvatar src={account.avatar} name={account.name} size={32} badge={badge} />
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span className="ws-account-name truncate">{account.name}</span>
          {extensions.accountSummary ? (
            <span className="ws-account-sub truncate" data-testid="workspace-account-summary">
              {extensions.accountSummary}
            </span>
          ) : null}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
      </button>
    );
    block = menu(trigger);
  }

  return (
    <>
      {block}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
}

function AccountMenu({
  trigger,
  mini,
  onOpenSettings,
  onOpenAbout,
  profileEditable,
}: {
  readonly trigger: ReactNode;
  readonly mini: boolean;
  readonly onOpenSettings: () => void;
  readonly onOpenAbout: () => void;
  /** The identity is the local profile, which the learner can edit here. */
  readonly profileEditable: boolean;
}) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const extensions = useWorkbenchShellExtensions();
  const account = useAccountIdentity();
  const hostItems = extensions.accountMenuItems ?? [];
  const onSignOut = account.signedIn ? extensions.identity?.onSignOut : undefined;
  const currentLocale = supportedLocales.find((l) => l.code === locale);
  const themes = [
    { value: 'light', icon: SunMedium, label: t('settings.themeOptions.light') },
    { value: 'dark', icon: Moon, label: t('settings.themeOptions.dark') },
    { value: 'system', icon: Monitor, label: t('settings.themeOptions.system') },
  ] as const;

  // The profile editor opens at the top of this same panel. Escape, or the
  // collapse at its corner, folds it; closing the menu folds it too.
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  // The editor's and the identity row's natural heights, for the spacer.
  // Both stay mounted while the menu is open (folded, they are clipped, not
  // removed), so they measure at their natural size all along.
  const [editorHeight, setEditorHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
  const editorRef = useObservedHeight(setEditorHeight);
  const rowRef = useObservedHeight(setRowHeight);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1600);
  }, []);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setEditing(false);
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="workspace-account-menu"
        side={mini ? 'right' : 'top'}
        align={mini ? 'end' : 'start'}
        sideOffset={8}
        // The positioned box keeps ONE height whether the profile editor is
        // open or not: a spacer above the panel gives back exactly what the
        // editor takes, on the same curve. The popper therefore never moves
        // while the panel grows upward from its anchored bottom — moving it
        // per frame is what made the growth twitch.
        className="ws-account-menu-shell w-[272px] !overflow-visible !rounded-none !bg-transparent !p-0 !shadow-none !ring-0"
        onEscapeKeyDown={(event) => {
          // Escape first folds the editor (what it holds is already saved).
          if (!editing) return;
          event.preventDefault();
          setEditing(false);
        }}
      >
        {account.signedIn && profileEditable ? (
          <div
            aria-hidden="true"
            className="ws-profile-spacer"
            style={{ height: editing ? 0 : Math.max(0, editorHeight - rowHeight) }}
          />
        ) : null}
        <div className="ws-account-menu rounded-2xl p-1.5">
          {account.signedIn && profileEditable ? (
            <div
              data-testid="workspace-profile-expand"
              data-open={editing || undefined}
              aria-hidden={!editing || undefined}
              className="ws-profile-expand"
            >
              {/* Mounted while the menu is open, so folding plays its height back
                down; inert while folded. */}
              <div className="min-h-0 overflow-hidden" inert={!editing}>
                {
                  <div
                    ref={editorRef}
                    data-testid="workspace-profile-editor"
                    data-profile-editor=""
                    className="relative px-1 pb-1.5 pt-1"
                    // The menu's typeahead and arrows would otherwise take the keys typed here.
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') event.stopPropagation();
                    }}
                  >
                    <UserProfileCard
                      className="!border-0 !bg-transparent !p-2.5 !shadow-none !backdrop-blur-none"
                      onSaved={markSaved}
                    />
                    <div className="absolute right-2 top-2.5 flex items-center gap-1.5">
                      <span
                        data-testid="workspace-profile-saved"
                        aria-live="polite"
                        className={cn('ws-profile-saved', saved && 'ws-profile-saved-on')}
                      >
                        {saved ? (
                          <>
                            <Check className="size-3" aria-hidden="true" />
                            {t('workspace.account.profileSaved')}
                          </>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        data-testid="workspace-profile-collapse"
                        onClick={() => setEditing(false)}
                        aria-label={t('workspace.showLess')}
                        title={t('workspace.showLess')}
                        className="ws-profile-collapse"
                      >
                        <ChevronDown className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                }
              </div>
            </div>
          ) : null}
          {account.signedIn && profileEditable ? (
            // While the editor is open its own header is the identity: the row
            // folds away on the same curve the editor opens on.
            <div className="ws-profile-row" data-folded={editing || undefined} inert={editing}>
              <div className="min-h-0 overflow-hidden">
                <div ref={rowRef} className="pb-1">
                  <DropdownMenuItem
                    {...HOLD_FOCUS}
                    data-testid="workspace-account-profile"
                    onSelect={(event) => {
                      event.preventDefault();
                      setEditing(true);
                    }}
                    title={t('profile.editTooltip')}
                    className="ws-menu-item ws-menu-profile group/profile"
                  >
                    <AccountAvatar src={account.avatar} name={account.name} size={36} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">
                      {account.name}
                    </span>
                    <Pencil
                      className="size-3.5 shrink-0 text-muted-foreground opacity-50 transition-opacity group-hover/profile:opacity-100"
                      aria-hidden="true"
                    />
                  </DropdownMenuItem>
                </div>
              </div>
            </div>
          ) : account.signedIn ? (
            <div className="flex items-center gap-2.5 px-2.5 pb-2.5 pt-2">
              <AccountAvatar src={account.avatar} name={account.name} size={36} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-foreground">
                  {account.name}
                </div>
                {account.detail ? (
                  <div className="truncate text-xs text-muted-foreground">{account.detail}</div>
                ) : null}
              </div>
            </div>
          ) : null}
          {extensions.accountSummary ? (
            <div
              data-testid="workspace-account-menu-summary"
              className="ws-account-summary mx-1 mb-1.5 rounded-xl px-3 py-2.5 text-[13px]"
            >
              {extensions.accountSummary}
            </div>
          ) : null}

          {hostItems.length > 0 ? (
            <>
              <div data-testid="workspace-account-host-items">
                {hostItems.map((item) => (
                  <HostMenuItem key={item.id} item={item} />
                ))}
              </div>
              <DropdownMenuSeparator />
            </>
          ) : null}

          <DropdownMenuItem
            {...HOLD_FOCUS}
            data-testid="workspace-account-settings"
            onSelect={onOpenSettings}
            className="ws-menu-item"
          >
            <Settings className="size-4" aria-hidden="true" />
            <span className="flex-1">{t('settings.title')}</span>
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              data-testid="workspace-account-language"
              className="ws-menu-item"
            >
              <Languages className="size-4" aria-hidden="true" />
              <span className="flex-1">{t('workspace.account.language')}</span>
              <span className="text-xs text-muted-foreground">
                {currentLocale?.label ?? locale}
              </span>
            </DropdownMenuSubTrigger>
            {/* Sized to its content: the whole list fits any ordinary viewport, and
              collision handling slides it up from the trigger to make room. It
              scrolls only when the viewport is genuinely shorter than the list. */}
            <DropdownMenuSubContent
              collisionPadding={8}
              className="ws-scroll max-h-(--radix-dropdown-menu-content-available-height) min-w-[160px] overflow-y-auto"
            >
              {supportedLocales.map((l) => (
                <DropdownMenuItem
                  {...HOLD_FOCUS}
                  key={l.code}
                  onSelect={() => setLocale(l.code)}
                  className="ws-menu-item"
                >
                  <span className="flex-1">{l.label}</span>
                  {locale === l.code ? <Check className="size-3.5" aria-hidden="true" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <div className="ws-menu-item ws-menu-static" data-testid="workspace-account-theme">
            <SunMedium className="size-4" aria-hidden="true" />
            <span className="flex-1">{t('settings.theme')}</span>
            <div role="radiogroup" aria-label={t('settings.theme')} className="ws-mini-seg">
              {themes.map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  aria-label={label}
                  title={label}
                  data-testid={`workspace-account-theme-${value}`}
                  onClick={() => setTheme(value)}
                  className={cn('ws-mini-seg-btn', theme === value && 'ws-mini-seg-on')}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            {...HOLD_FOCUS}
            data-testid="workspace-account-about"
            onSelect={onOpenAbout}
            className="ws-menu-item"
          >
            <Info className="size-4" aria-hidden="true" />
            <span className="flex-1">{t('workspace.account.about')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem {...HOLD_FOCUS} asChild className="ws-menu-item">
            <a
              href={docsHref(locale)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="workspace-account-docs"
            >
              <BookText className="size-4" aria-hidden="true" />
              <span className="flex-1">{t('workspace.account.docs')}</span>
              <SquareArrowOutUpRight className="size-3 opacity-50" aria-hidden="true" />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem {...HOLD_FOCUS} asChild className="ws-menu-item">
            <a
              href={OPENMAIC_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="workspace-account-github"
            >
              <Github className="size-4" aria-hidden="true" />
              <span className="flex-1">GitHub</span>
              <SquareArrowOutUpRight className="size-3 opacity-50" aria-hidden="true" />
            </a>
          </DropdownMenuItem>

          {onSignOut ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                {...HOLD_FOCUS}
                data-testid="workspace-account-sign-out"
                onSelect={onSignOut}
                className="ws-menu-item"
              >
                <LogOut className="size-4" aria-hidden="true" />
                <span className="flex-1">{t('workspace.account.signOut')}</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Keep the focus in the profile editor while the pointer crosses the menu: a
 * menu item takes the focus on hover unless its pointer event was handled.
 */
/** A callback ref reporting the element's border-box height as it changes. */
function useObservedHeight(onHeight: (height: number) => void) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || typeof ResizeObserver === 'undefined') return;
      const report = () => onHeight(node.offsetHeight);
      report();
      observer.current = new ResizeObserver(report);
      observer.current.observe(node);
    },
    [onHeight],
  );
}

function holdProfileFocus(event: { preventDefault: () => void }) {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (active instanceof HTMLElement && active.closest('[data-profile-editor]')) {
    event.preventDefault();
  }
}
const HOLD_FOCUS = { onPointerMove: holdProfileFocus, onPointerLeave: holdProfileFocus };

function HostMenuItem({ item }: { readonly item: WorkbenchShellMenuItem }) {
  const Icon = item.icon;
  const body = (
    <>
      {Icon ? <Icon className="size-4" aria-hidden /> : <span className="size-4" />}
      <span className="flex-1">{item.label}</span>
      {item.trailing ? (
        <span className="text-xs text-muted-foreground">{item.trailing}</span>
      ) : item.external ? (
        <SquareArrowOutUpRight className="size-3 opacity-50" aria-hidden="true" />
      ) : null}
    </>
  );
  if (item.href) {
    return (
      <DropdownMenuItem {...HOLD_FOCUS} asChild className="ws-menu-item">
        <a
          href={item.href}
          data-testid={`workspace-account-item-${item.id}`}
          {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {body}
        </a>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      {...HOLD_FOCUS}
      data-testid={`workspace-account-item-${item.id}`}
      onSelect={() => item.onSelect?.()}
      className="ws-menu-item"
    >
      {body}
    </DropdownMenuItem>
  );
}

function AboutDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const brand = useBrand();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="workspace-about" className="sm:max-w-[400px]">
        <div className="flex flex-col items-center gap-3 px-2 pb-1 pt-3 text-center">
          <img src={brand.logoSrc} alt="" aria-hidden="true" className="h-9 w-auto" />
          <DialogTitle className="sr-only">{t('workspace.account.about')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t('home.slogan')}</p>
          <DialogDescription className="text-[13px] leading-relaxed text-foreground/80">
            {t('workspace.account.aboutBody')}
          </DialogDescription>
          <a
            href={OPENMAIC_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground/80 hover:bg-muted"
          >
            <Github className="size-3.5" aria-hidden="true" />
            {t('workspace.account.viewOnGithub')}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
