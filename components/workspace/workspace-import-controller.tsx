'use client';

import {
  createContext,
  type DragEvent,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { FileArchive, FolderOpen, LoaderCircle, UploadCloud, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ClassroomPackageDropzone, ImportPreviewDialog } from '@/components/import';
import {
  collectDroppedPackage,
  scanClassroomPackage,
  type ClassroomPackageScan,
} from '@/lib/import/classroom-package';

type WorkspaceImportContextValue = {
  openImporter: () => void;
};

const WorkspaceImportContext = createContext<WorkspaceImportContextValue | null>(null);

export function useWorkspaceImport() {
  const value = useContext(WorkspaceImportContext);
  if (!value) {
    throw new Error('useWorkspaceImport must be used inside WorkspaceImportController');
  }
  return value;
}

export function WorkspaceImportController({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [chooserOpen, setChooserOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [scan, setScan] = useState<ClassroomPackageScan | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [dropScanning, setDropScanning] = useState(false);
  const dragDepth = useRef(0);

  const acceptScan = useCallback((nextScan: ClassroomPackageScan) => {
    setScan(nextScan);
    setChooserOpen(false);
    setPreviewOpen(true);
  }, []);

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragActive(false);
    setDropScanning(true);
    try {
      const input = await collectDroppedPackage(event.dataTransfer);
      const nextScan = await scanClassroomPackage(input);
      acceptScan(nextScan);
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取这个资源包';
      toast.error('资源包扫描失败', { description: message });
    } finally {
      setDropScanning(false);
    }
  };

  return (
    <WorkspaceImportContext.Provider value={{ openImporter: () => setChooserOpen(true) }}>
      <div
        className="min-h-screen"
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {children}

        {(dragActive || dropScanning) && (
          <div className="fixed inset-0 z-[120] grid place-items-center bg-[#261535]/75 p-5 backdrop-blur-sm">
            <div
              className={cn(
                'relative flex min-h-[320px] w-full max-w-2xl flex-col items-center justify-center rounded-[32px]',
                'border-2 border-dashed border-white/70 bg-white/95 px-8 text-center shadow-2xl dark:bg-[#201729]/95',
              )}
            >
              {!dropScanning && (
                <Button
                  aria-label="取消拖入"
                  variant="ghost"
                  size="icon-lg"
                  className="absolute right-4 top-4 rounded-full"
                  onClick={() => {
                    dragDepth.current = 0;
                    setDragActive(false);
                  }}
                >
                  <X />
                </Button>
              )}
              <div className="mb-6 grid size-20 place-items-center rounded-3xl bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-200">
                {dropScanning ? (
                  <LoaderCircle className="size-10 animate-spin" />
                ) : (
                  <UploadCloud className="size-10" />
                )}
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">
                {dropScanning ? '正在本机检查资源包' : '松开即可导入课程'}
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                支持 .maic.zip
                压缩包和完整资源文件夹。文件只在当前设备中解析，确认前不会写入课程库。
              </p>
              {!dropScanning && (
                <div className="mt-7 flex flex-wrap justify-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
                    <FileArchive className="size-3.5" /> .maic.zip
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5">
                    <FolderOpen className="size-3.5" /> 课程文件夹
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
        <DialogContent className="max-w-2xl rounded-3xl p-0 sm:max-w-2xl">
          <DialogHeader className="px-7 pt-7">
            <DialogTitle className="text-xl">导入 OpenMAIC 课程</DialogTitle>
            <DialogDescription>
              选择资源包或文件夹。系统会先检查格式、安全性和离线完整度，再让你确认导入。
            </DialogDescription>
          </DialogHeader>
          <div className="px-7 pb-7">
            <ClassroomPackageDropzone
              onScanComplete={acceptScan}
              onError={(error) =>
                toast.error('资源包扫描失败', {
                  description: error instanceof Error ? error.message : String(error),
                })
              }
            />
          </div>
        </DialogContent>
      </Dialog>

      <ImportPreviewDialog
        scan={scan}
        open={previewOpen}
        onOpenChange={(open) => {
          setPreviewOpen(open);
          if (!open) setScan(null);
        }}
        onImported={({ stageId }) => {
          window.dispatchEvent(new CustomEvent('openmaic:workspace-changed'));
          toast.success('课程已保存到本机', { description: '现在可以断网打开核心课程内容。' });
          setPreviewOpen(false);
          setScan(null);
          router.push(`/courses/${stageId}`);
        }}
      />
    </WorkspaceImportContext.Provider>
  );
}
