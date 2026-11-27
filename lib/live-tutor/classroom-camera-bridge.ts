export interface ClassroomCameraSnapshot {
  data: string;
  mimeType: 'image/jpeg' | 'image/png';
}

type CaptureFn = () => ClassroomCameraSnapshot | null;

let activeCaptureFn: CaptureFn | null = null;

/**
 * Registers the active inline Q&A notebook camera capture callback so any
 * spoken or typed classroom Q&A turn automatically attaches the current frame.
 */
export function registerClassroomCameraCapture(fn: CaptureFn | null): () => void {
  activeCaptureFn = fn;
  return () => {
    if (activeCaptureFn === fn) {
      activeCaptureFn = null;
    }
  };
}

export function captureClassroomCameraSnapshot(): ClassroomCameraSnapshot | null {
  if (!activeCaptureFn) return null;
  try {
    return activeCaptureFn();
  } catch {
    return null;
  }
}
