'use client';

import { Globe } from 'lucide-react';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { getAsrLanguageForLocale, getDefaultTTSProviderForLocale, getDefaultTTSVoiceForLocale } from '@/lib/utils/language';
import type { Locale } from '@/lib/i18n';
import type { TTSProviderId } from '@/lib/audio/types';

const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  { value: 'hi-IN', label: 'हिन्दी' },
];

export function LanguageSelector() {
  const { t, locale, setLocale } = useI18n();
  const setTTSProvider = useSettingsStore((state) => state.setTTSProvider);
  const setTTSVoice = useSettingsStore((state) => state.setTTSVoice);
  const setASRLanguage = useSettingsStore((state) => state.setASRLanguage);
  const setASRProvider = useSettingsStore((state) => state.setASRProvider);

  const handleLocaleChange = (value: string) => {
    const nextLocale = value as Locale;
    setLocale(nextLocale);

    const nextTTSProvider = getDefaultTTSProviderForLocale(nextLocale) as TTSProviderId;
    setTTSProvider(nextTTSProvider);
    setTTSVoice(getDefaultTTSVoiceForLocale(nextLocale, nextTTSProvider));

    if (nextLocale === 'hi-IN') {
      setASRProvider('browser-native');
      setASRLanguage('hi-IN');
      return;
    }

    setASRLanguage(getAsrLanguageForLocale(nextLocale, 'browser-native'));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Globe className="w-4 h-4 text-violet-500" />
        <Label>{t('settings.language')}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
      <Select value={locale} onValueChange={handleLocaleChange}>
        <SelectTrigger className="max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LOCALE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
