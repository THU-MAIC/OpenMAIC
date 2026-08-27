/**
 * Clipboard / drag-and-drop image extraction for the workbench composer —
 * turning pasted or dropped images into uploads without hijacking ordinary
 * text paste.
 *
 */
interface ComposerTransferItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

export interface ComposerFileTransfer {
  files: ArrayLike<File>;
  items?: ArrayLike<ComposerTransferItem>;
}

function isImageFile(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/');
}

function pastedImageExtension(mime: string): string {
  const subtype = mime.toLowerCase().split('/', 2)[1]?.split('+', 1)[0];
  if (subtype === 'jpeg') return 'jpg';
  return subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'png';
}

function withPastedImageName(file: File, timestamp: number): File {
  if (file.name.trim()) return file;
  return new File([file], `pasted-image-${timestamp}.${pastedImageExtension(file.type)}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/** Extract clipboard image files without turning ordinary text paste into an upload. */
export function composerImagesFromClipboard(
  transfer: ComposerFileTransfer,
  timestamp = Date.now(),
): File[] {
  const itemImages = Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isImageFile(file));
  const images = itemImages.length
    ? itemImages
    : Array.from(transfer.files).filter((file) => isImageFile(file));
  return images.map((file) => withPastedImageName(file, timestamp));
}

/** Drag-and-drop intentionally accepts images only; the `+` menu remains the all-file path. */
export function composerImagesFromDrop(transfer: ComposerFileTransfer): File[] {
  return Array.from(transfer.files).filter((file) => isImageFile(file));
}

export function composerTransferHasImages(transfer: ComposerFileTransfer): boolean {
  return (
    Array.from(transfer.items ?? []).some(
      (item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'),
    ) || Array.from(transfer.files).some((file) => isImageFile(file))
  );
}
