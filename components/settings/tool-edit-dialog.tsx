'use client';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';

interface Tool {
  type: string;
  name: string;
}

interface ToolEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: Tool | null;
  setTool: (tool: Tool | null) => void;
  onSave: () => void;
}

export function ToolEditDialog({ open, onOpenChange, tool, setTool, onSave }: ToolEditDialogProps) {
  const { t } = useI18n();

  const handleClose = () => {
    onOpenChange(false);
    setTool(null);
  };

  if (!tool) return null;

  const canSave = !!(tool.type.trim() && tool.name.trim());

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogTitle>
          {tool.type === ''
            ? t('settings.webSearchAddToolTitle')
            : t('settings.webSearchEditToolTitle')}
        </DialogTitle>
        <DialogDescription>{t('settings.webSearchToolDialogDesc')}</DialogDescription>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>{t('settings.webSearchToolType')}</Label>
            <Input
              placeholder="web_search_20260209"
              value={tool.type}
              onChange={(e) => setTool({ ...tool, type: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.webSearchToolName')}</Label>
            <Input
              placeholder="web_search"
              value={tool.name}
              onChange={(e) => setTool({ ...tool, name: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={handleClose}>
              {t('settings.cancelEdit')}
            </Button>
            <Button onClick={onSave} disabled={!canSave}>
              {t('settings.saveModel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
