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
 * That profile is edited in place: the menu's identity row opens into the
 * same fields the classic home's greeting bar edits (avatar, name, bio).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookText,
  Check,
  ChevronsUpDown,
  Github,
  ImagePlus,
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
import { AVATAR_OPTIONS, useUserProfileStore } from '@/lib/store/user-profile';
import { readAvatarUpload } from '@/components/user-profile';
import { Textarea } from '@/components/ui/textarea';
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

  // The identity row opens into the profile editor in place. While it is open
  // the rest of the menu steps aside, so hovering an item cannot pull focus
  // out of a field; closing the menu (a click outside) leaves the editor too.
  const [editing, setEditing] = useState(false);

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
        className="ws-account-menu w-[272px] rounded-2xl p-1.5"
        onEscapeKeyDown={(event) => {
          // Escape first leaves the editor, keeping what was already saved.
          if (!editing) return;
          event.preventDefault();
          setEditing(false);
        }}
      >
        {editing ? (
          <ProfileInlineEditor onDone={() => setEditing(false)} />
        ) : (
          <>
            {account.signedIn && profileEditable ? (
              <DropdownMenuItem
                data-testid="workspace-account-profile"
                onSelect={(event) => {
                  event.preventDefault();
                  setEditing(true);
                }}
                title={t('profile.editTooltip')}
                className="ws-menu-item ws-menu-profile group/profile mb-1"
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
              data-testid="workspace-account-about"
              onSelect={onOpenAbout}
              className="ws-menu-item"
            >
              <Info className="size-4" aria-hidden="true" />
              <span className="flex-1">{t('workspace.account.about')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="ws-menu-item">
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
            <DropdownMenuItem asChild className="ws-menu-item">
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
                  data-testid="workspace-account-sign-out"
                  onSelect={onSignOut}
                  className="ws-menu-item"
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  <span className="flex-1">{t('workspace.account.signOut')}</span>
                </DropdownMenuItem>
              </>
            ) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The local profile, edited in place at the top of the account menu: the
 * classic greeting bar's fields — an avatar from the preset choices or an
 * upload, the name, and the bio the AI teacher reads — written to the same
 * store. An avatar applies as soon as it is picked; the name and bio are saved
 * by Enter in the name field or Done, and Escape leaves them as they were.
 */
function ProfileInlineEditor({ onDone }: { readonly onDone: () => void }) {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);
  const [nameDraft, setNameDraft] = useState(nickname);
  const [bioDraft, setBioDraft] = useState(bio);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const displayName = nameDraft.trim() || t('profile.defaultNickname');

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const save = () => {
    setNickname(nameDraft.trim());
    setBio(bioDraft);
    onDone();
  };

  return (
    <div
      data-testid="workspace-profile-editor"
      className="ws-profile-editor px-2 pb-2 pt-1.5"
      // The menu's typeahead would otherwise take the letters typed here.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') event.stopPropagation();
      }}
    >
      <div className="flex items-center gap-2.5">
        <AccountAvatar src={avatar || null} name={displayName} size={36} />
        <input
          ref={nameRef}
          data-testid="workspace-profile-name"
          value={nameDraft}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
          maxLength={20}
          placeholder={t('profile.defaultNickname')}
          aria-label={t('profile.title')}
          className="ws-profile-input min-w-0 flex-1"
        />
      </div>
      <div
        role="radiogroup"
        aria-label={t('profile.chooseAvatar')}
        className="mt-2.5 flex flex-wrap items-center gap-1"
      >
        {AVATAR_OPTIONS.map((url) => (
          <button
            key={url}
            type="button"
            role="radio"
            aria-checked={avatar === url}
            data-testid="workspace-profile-avatar"
            onClick={() => setAvatar(url)}
            className={cn('ws-profile-avatar', avatar === url && 'ws-profile-avatar-on')}
          >
            <img src={url} alt="" className="size-full rounded-full" />
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={avatar.startsWith('data:')}
          onClick={() => fileRef.current?.click()}
          title={t('profile.uploadAvatar')}
          aria-label={t('profile.uploadAvatar')}
          className={cn(
            'ws-profile-avatar ws-profile-upload',
            avatar.startsWith('data:') && 'ws-profile-avatar-on',
          )}
        >
          <ImagePlus className="size-3.5" aria-hidden="true" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void readAvatarUpload(file, t).then((next) => {
              if (next) setAvatar(next);
            });
          }}
        />
      </div>
      <Textarea
        data-testid="workspace-profile-bio"
        value={bioDraft}
        onChange={(event) => setBioDraft(event.target.value)}
        placeholder={t('profile.bioPlaceholder')}
        maxLength={200}
        rows={3}
        className="mt-2.5 min-h-[68px] resize-none bg-transparent !text-[13px] leading-relaxed"
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          data-testid="workspace-profile-done"
          onClick={save}
          className="ws-profile-done"
        >
          {t('workspace.account.profileDone')}
        </button>
      </div>
    </div>
  );
}

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
      <DropdownMenuItem asChild className="ws-menu-item">
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
