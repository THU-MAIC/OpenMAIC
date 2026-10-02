'use client';

import { useState, useCallback, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { modelChange, modelRef } from '@/lib/model-settings/edit';
import { MediaServicePanel } from './media-service-panel';
import { reportApply, rootUse, type ServicePanelProps } from './server-settings';

interface WorkflowEntry {
  id: string;
  name: string;
}

/**
 * An image generation service (see MediaServicePanel). ComfyUI, which the
 * server configures, lists its workflows instead of models; picking one makes
 * it the workspace's image model.
 */
export function ImageSettings(props: ServicePanelProps) {
  const { view, apply, entry } = props;
  const { t } = useI18n();
  const registry = IMAGE_PROVIDERS[entry.registryId as ImageProviderId];
  const isComfyUI = entry.registryId === 'comfyui-image';
  const use = rootUse(view, 'image', entry.id);

  // ComfyUI workflow list state
  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);

  // Fetch ComfyUI workflows when the provider is selected
  const fetchWorkflows = useCallback(async () => {
    setWorkflowsLoading(true);
    setWorkflowsError(null);
    try {
      const res = await fetch('/api/comfyui-workflows');
      const data = await res.json();
      setWorkflows(data.workflows || []);
    } catch (err) {
      setWorkflowsError(t('settings.comfyuiLoadError').replace('{error}', String(err)));
      setWorkflows([]);
    } finally {
      setWorkflowsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isComfyUI && entry.provider) {
      void fetchWorkflows();
    }
  }, [isComfyUI, entry.provider, fetchWorkflows]);

  // Picking a workflow makes ComfyUI (with it) the workspace's image model.
  const pickWorkflow = async (workflowId: string) => {
    if (!use.slot || use.slot.locked || !entry.provider) return;
    reportApply(await apply(modelChange(use.slot, modelRef(entry.id, workflowId)), view), t);
  };

  const workflowList = isComfyUI && entry.provider && (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Label className="text-base">{t('settings.comfyuiWorkflows')}</Label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchWorkflows()}
          disabled={workflowsLoading}
          className="gap-1.5"
        >
          {workflowsLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('settings.comfyuiRefresh')}
        </Button>
      </div>

      {workflowsError && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300">
          {workflowsError}
        </div>
      )}

      {!workflowsLoading && !workflowsError && workflows.length === 0 && (
        <div className="rounded-lg border border-border/50 bg-muted/30 p-4 text-sm text-muted-foreground text-center">
          {t('settings.comfyuiNoWorkflowsFoundPrefix')}{' '}
          <code className="font-mono text-xs">public/</code>.
          <br />
          {t('settings.comfyuiAddWorkflowPrefix')}{' '}
          <code className="font-mono text-xs">comfyui-*.json</code>{' '}
          {t('settings.comfyuiAddWorkflowSuffix')}
        </div>
      )}

      <div className="space-y-1.5">
        {workflows.map((workflow) => {
          const selected = use.inUse && use.modelId === workflow.id;
          return (
            <button
              key={workflow.id}
              type="button"
              disabled={use.slot?.locked}
              className={cn(
                'flex w-full items-center justify-between p-3 rounded-lg border text-left transition-colors disabled:cursor-not-allowed',
                selected
                  ? 'border-primary bg-primary/5'
                  : 'border-border/50 bg-card hover:border-border hover:bg-accent/30',
              )}
              onClick={() => void pickWorkflow(workflow.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{workflow.name}</div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5">{workflow.id}</div>
              </div>
              {selected && <CheckCircle2 className="h-4 w-4 text-primary shrink-0 ml-2" />}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {t('settings.comfyuiFolderHintPrefix')} <code className="font-mono">public/</code>{' '}
        {t('settings.comfyuiFolderHintMiddle')}{' '}
        <code className="font-mono">comfyui-anime-style.json</code> → &quot;Anime Style&quot;.
      </p>
    </div>
  );

  return (
    <MediaServicePanel
      {...props}
      kind="image"
      defaultBaseUrl={registry?.defaultBaseUrl}
      catalogue={registry?.models ?? []}
    >
      {workflowList || undefined}
    </MediaServicePanel>
  );
}
