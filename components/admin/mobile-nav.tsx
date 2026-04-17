'use client';

import { useState } from 'react';
import {
  Menu,
  X,
  GraduationCap,
  LayoutDashboard,
  Users,
  LibraryBig,
  Shield,
  Settings,
  ScrollText,
  LogOut,
} from 'lucide-react';
import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { useI18n } from '@/lib/hooks/use-i18n';

interface MobileAdminNavProps {
  readonly userName: string;
  readonly userEmail: string;
  readonly canViewDashboard: boolean;
  readonly canViewUsers: boolean;
  readonly canViewRoles: boolean;
  readonly canViewClassrooms: boolean;
  readonly canManageSystemConfig: boolean;
  readonly canViewPrompts: boolean;
  readonly canViewAuditLog: boolean;
}

function MobileNavLink({
  href,
  icon,
  label,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors"
    >
      {icon} {label}
    </Link>
  );
}

export function MobileAdminNav({
  userName,
  userEmail,
  canViewDashboard,
  canViewUsers,
  canViewRoles,
  canViewClassrooms,
  canManageSystemConfig,
  canViewPrompts,
  canViewAuditLog,
}: MobileAdminNavProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { t } = useI18n();

  return (
    <>
      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 bg-slate-800 border-b border-white/5 sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-purple-600 flex items-center justify-center">
            <GraduationCap className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-white font-semibold text-sm">{t('adminNav.mobileTitle')}</span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          aria-label={t('adminNav.openMenu')}
        >
          <Menu className="w-5 h-5" />
        </button>
      </header>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          aria-hidden
          onClick={close}
        />
      )}

      {/* Slide-in drawer */}
      <nav
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-800 border-r border-white/5 flex flex-col transform transition-transform duration-200 ease-in-out md:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Mobile admin navigation"
      >
        <div className="p-5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-600 flex items-center justify-center flex-shrink-0">
              <GraduationCap className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="text-white font-semibold text-sm leading-tight">MU-OpenMAIC</p>
              <p className="text-slate-400 text-xs">{t('adminNav.panel')}</p>
            </div>
          </div>
          <button
            onClick={close}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={t('adminNav.closeMenu')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 py-4 px-3 space-y-3 overflow-y-auto">
          {canViewDashboard && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500">{t('adminNav.overview')}</p>
              <MobileNavLink href="/admin" icon={<LayoutDashboard className="w-4 h-4" />} label={t('adminNav.dashboard')} onClick={close} />
            </div>
          )}
          {(canViewUsers || canViewRoles || canViewClassrooms) && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500">{t('adminNav.management')}</p>
              {canViewUsers && <MobileNavLink href="/admin/users" icon={<Users className="w-4 h-4" />} label={t('adminNav.users')} onClick={close} />}
              {canViewRoles && <MobileNavLink href="/admin/roles" icon={<Shield className="w-4 h-4" />} label={t('adminNav.roles')} onClick={close} />}
              {canViewClassrooms && <MobileNavLink href="/admin/classrooms" icon={<LibraryBig className="w-4 h-4" />} label={t('adminNav.classrooms')} onClick={close} />}
            </div>
          )}
          {(canManageSystemConfig || canViewPrompts || canViewAuditLog) && (
            <div>
              <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500">{t('adminNav.governance')}</p>
              {canManageSystemConfig && <MobileNavLink href="/admin/system-config/settings" icon={<Settings className="w-4 h-4" />} label={t('adminNav.generalSettings')} onClick={close} />}
              {canViewPrompts && <MobileNavLink href="/admin/system-config/prompts" icon={<Settings className="w-4 h-4" />} label={t('adminNav.promptStudio')} onClick={close} />}
              {canViewAuditLog && <MobileNavLink href="/admin/audit-log" icon={<ScrollText className="w-4 h-4" />} label={t('adminNav.auditLog')} onClick={close} />}
            </div>
          )}

          <div>
            <p className="px-3 pb-1 text-[11px] uppercase tracking-wider text-slate-500">{t('adminNav.account')}</p>
            <div className="px-3 py-2 mb-2">
              <p className="text-slate-200 text-xs font-medium truncate">{userName}</p>
              <p className="text-slate-500 text-xs truncate">{userEmail}</p>
            </div>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: '/auth/signin' })}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
              <LogOut className="w-4 h-4" /> {t('adminNav.signOut')}
            </button>
          </div>
        </div>
      </nav>
    </>
  );
}
