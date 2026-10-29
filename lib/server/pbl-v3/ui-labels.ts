import 'server-only';
import l0 from '@/lib/i18n/locales/ko-KR.json';
import l1 from '@/lib/i18n/locales/ja-JP.json';
import l2 from '@/lib/i18n/locales/zh-CN.json';
import l3 from '@/lib/i18n/locales/ar-SA.json';
import l4 from '@/lib/i18n/locales/pt-BR.json';
import l5 from '@/lib/i18n/locales/de-DE.json';
import l6 from '@/lib/i18n/locales/fr-FR.json';
import l7 from '@/lib/i18n/locales/zh-TW.json';
import l8 from '@/lib/i18n/locales/ru-RU.json';
import l9 from '@/lib/i18n/locales/en-US.json';
import l10 from '@/lib/i18n/locales/es-MX.json';
import l11 from '@/lib/i18n/locales/vi-VN.json';

const locales: Record<string, typeof l0> = {
  'ko-KR': l0,
  'ja-JP': l1,
  'zh-CN': l2,
  'ar-SA': l3,
  'pt-BR': l4,
  'de-DE': l5,
  'fr-FR': l6,
  'zh-TW': l7,
  'ru-RU': l8,
  'en-US': l9,
  'es-MX': l10,
  'vi-VN': l11,
};
/** Exact localized controls, independent of the Agent response language. */
export function visibleProductLabels(locale = 'en-US') {
  const p = (locales[locale] ?? locales['en-US']!).pblV3;
  return {
    projectFiles: p.files,
    task: p.journey.taskTitle,
    runTests: p.runTests,
    submitQuiz: p.submitQuiz,
    build: p.build,
    continue: p.next,
    report: p.report,
    refresh: p.refresh,
    restore: p.recoverWorkspace,
    toggleWorkspace: p.ide.toggleWorkspace,
    toggleAssistant: p.ide.toggleAssistant,
    application: p.application.open,
    applicationRestart: p.application.restart,
    applicationCollapse: p.application.collapse,
    applicationHelp: p.application.help,
    applicationNewTab: p.application.newTab,
    applicationReopen: p.application.reopen,
    applicationRestore: p.application.restore,
  };
}
