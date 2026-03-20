'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@/lib/types/slides';

interface LinkDialogProps {
  visible: boolean;
  onClose: () => void;
}

export function LinkDialog({ visible, onClose }: LinkDialogProps) {
  const [url, setUrl] = useState('');

  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );
  const { updateElement } = useCanvasOperations();

  const activeElementId = activeElementIdList[0];
  const activeElement = elements?.find((el) => el.id === activeElementId);
  const currentLink = activeElement?.link;

  useEffect(() => {
    if (visible) {
      setUrl(currentLink?.type === 'web' ? currentLink.target : '');
    }
  }, [visible, currentLink]);

  const handleSave = () => {
    if (!activeElementId) return;
    const trimmed = url.trim();
    if (trimmed) {
      updateElement({
        id: activeElementId,
        props: { link: { type: 'web', target: trimmed } } as Partial<PPTElement>,
      });
    } else {
      // Remove link if URL is cleared
      updateElement({
        id: activeElementId,
        props: { link: undefined } as Partial<PPTElement>,
      });
    }
    onClose();
  };

  const handleRemove = () => {
    if (!activeElementId) return;
    updateElement({
      id: activeElementId,
      props: { link: undefined } as Partial<PPTElement>,
    });
    onClose();
  };

  return (
    <Dialog open={visible} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set Link</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="link-url">URL</Label>
            <Input
              id="link-url"
              type="url"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          {currentLink && (
            <Button variant="ghost" onClick={handleRemove} className="mr-auto">
              Remove
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
