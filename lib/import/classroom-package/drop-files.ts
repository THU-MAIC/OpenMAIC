import type { ClassroomPackageInput, FolderPackageFile } from './types';
import { ClassroomPackageError } from './types';

const MAX_DROPPED_FILES = 5_000;

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryChunk(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readAllDirectoryEntries(
  entry: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  while (true) {
    const chunk = await readDirectoryChunk(reader);
    if (chunk.length === 0) return all;
    all.push(...chunk);
  }
}

async function flattenEntry(
  entry: FileSystemEntry,
  parentPath: string,
  output: FolderPackageFile[],
) {
  if (output.length >= MAX_DROPPED_FILES) {
    throw new ClassroomPackageError('limits-exceeded', '拖入的文件数量超过安全上限。');
  }
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    output.push({ file, path: currentPath });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry);
    for (const child of children) await flattenEntry(child, currentPath, output);
  }
}

/** Convert a browser drop into the same input accepted by scanClassroomPackage. */
export async function collectDroppedPackage(
  dataTransfer: DataTransfer,
): Promise<ClassroomPackageInput> {
  // Capture entries synchronously: some browsers invalidate DataTransferItem after the event returns.
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length > 0) {
    if (entries.length === 1 && entries[0].isFile) {
      const file = await readEntryFile(entries[0] as FileSystemFileEntry);
      if (file.name.toLocaleLowerCase('en-US').endsWith('.maic.zip')) return file;
    }
    const files: FolderPackageFile[] = [];
    for (const entry of entries) await flattenEntry(entry, '', files);
    return { kind: 'folder', name: entries.length === 1 ? entries[0].name : undefined, files };
  }

  const files = Array.from(dataTransfer.files);
  if (files.length === 1 && files[0].name.toLocaleLowerCase('en-US').endsWith('.maic.zip')) {
    return files[0];
  }
  if (files.length > 0) return { kind: 'folder', files };
  throw new ClassroomPackageError('invalid-input', '没有检测到可导入的文件。');
}
