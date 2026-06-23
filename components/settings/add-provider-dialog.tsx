'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import {
  TOKEN_PLAN_PRESETS,
  PRESET_CATEGORY_ORDER,
  type TokenPlanPreset,
  type PresetCategory,
} from '@/lib/config/token-plan-presets';

export interface NewProviderData {
  name: string;
  type: 'openai' | 'anthropic' | 'google';
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: NewProviderData) => void;
}

const CATEGORY_LABEL_KEYS: Record<PresetCategory, string> = {
  token_plan: 'settings.presetCategory.tokenPlan',
  aggregator: 'settings.presetCategory.aggregator',
  third_party: 'settings.presetCategory.thirdParty',
  official: 'settings.presetCategory.official',
};

export function AddProviderDialog({ open, onOpenChange, onAdd }: AddProviderDialogProps) {
  const { t } = useI18n();

  // Custom-tab form state
  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'anthropic' | 'google'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(true);
  const [activeTab, setActiveTab] = useState<'preset' | 'custom'>('preset');

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setType('openai');
      setBaseUrl('');
      setIcon('');
      setRequiresApiKey(true);
      setActiveTab('preset');
    }
  }

  const handleClose = () => onOpenChange(false);

  const handleAddCustom = () => {
    onAdd({ name, type, baseUrl, icon, requiresApiKey });
  };

  const handlePickPreset = (preset: TokenPlanPreset) => {
    onAdd({
      name: preset.name,
      type: preset.apiFormat,
      baseUrl: preset.baseUrl,
      icon: preset.icon ?? '',
      requiresApiKey: preset.requiresApiKey,
      modelsUrl: preset.modelsUrl,
    });
  };

  // Group presets by category in display order.
  const grouped = PRESET_CATEGORY_ORDER.map((cat) => ({
    category: cat,
    presets: TOKEN_PLAN_PRESETS.filter((p) => p.category === cat),
  })).filter((g) => g.presets.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogTitle className="sr-only">{t('settings.addProviderDialog')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.addProviderDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{t('settings.addProviderDialog')}</h2>
          </div>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'preset' | 'custom')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="preset">{t('settings.selectProvider')}</TabsTrigger>
              <TabsTrigger value="custom">{t('settings.customProvider')}</TabsTrigger>
            </TabsList>

            {/* ── Preset picker ───────────────────────────────────────────── */}
            <TabsContent value="preset" className="space-y-4 max-h-[420px] overflow-y-auto pr-1">
              {grouped.map((group) => (
                <div key={group.category} className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground px-1">
                    {t(CATEGORY_LABEL_KEYS[group.category])}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.presets.map((preset) => (
                      <button
                        key={preset.id}
                        onClick={() => handlePickPreset(preset)}
                        className="flex items-center gap-2.5 p-3 rounded-lg border text-left text-sm hover:bg-muted/50 hover:border-primary/40 transition-colors"
                      >
                        {preset.icon ? (
                          <img src={preset.icon} alt="" className="h-5 w-5 shrink-0" />
                        ) : (
                          <span className="h-5 w-5 shrink-0 rounded bg-muted" />
                        )}
                        <span className="flex flex-col min-w-0">
                          <span className="truncate font-medium">{preset.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {preset.apiFormat}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground px-1">{t('settings.presetPickHint')}</p>
            </TabsContent>

            {/* ── Custom form (unchanged behavior) ────────────────────────── */}
            <TabsContent value="custom" className="space-y-4">
              <div className="space-y-2">
                <Label>{t('settings.providerName')}</Label>
                <Input
                  placeholder={t('settings.providerNamePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>{t('settings.providerApiMode')}</Label>
                <div className="grid grid-cols-3 gap-2">
                  {(['openai', 'anthropic', 'google'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setType(mode)}
                      className={cn(
                        'p-2 rounded-lg border text-left text-sm transition-colors',
                        type === mode
                          ? 'bg-primary/5 border-primary/50'
                          : 'hover:bg-muted/50 border-transparent',
                      )}
                    >
                      {t(
                        mode === 'openai'
                          ? 'settings.apiModeOpenAI'
                          : mode === 'anthropic'
                            ? 'settings.apiModeAnthropic'
                            : 'settings.apiModeGoogle',
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('settings.defaultBaseUrl')}</Label>
                <Input
                  type="url"
                  placeholder="https://api.example.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>{t('settings.providerIcon')}</Label>
                <Input
                  type="url"
                  placeholder="https://example.com/icon.svg"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="requires-api-key"
                  checked={requiresApiKey}
                  onCheckedChange={(checked) => setRequiresApiKey(checked as boolean)}
                />
                <label htmlFor="requires-api-key" className="text-sm cursor-pointer">
                  {t('settings.requiresApiKey')}
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t">
                <Button variant="outline" size="sm" onClick={handleClose}>
                  {t('settings.cancelEdit')}
                </Button>
                <Button size="sm" onClick={handleAddCustom} className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  {t('settings.addProviderButton')}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
