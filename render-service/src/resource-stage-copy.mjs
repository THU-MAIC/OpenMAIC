import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COPY_BUFFER_BYTES = 1024 * 1024;
const STAGE_MODE = 0o600;

function close(fd) {
  if (fd === undefined) return;
  closeSync(fd);
}

/**
 * Copy only bytes from a no-follow regular source into a new fixed-mode stage.
 *
 * The task runner invokes this program only after setpriv has dropped to the
 * HTTP/worker uid. Consequently every path lookup and file open happens with
 * unprivileged authority; root never opens a worker-controlled path for it.
 */
export function copyStage(
  sourcePath,
  destinationPath,
  expectedUid,
  expectedGid,
  dependencies = {},
) {
  if (!isAbsolute(sourcePath) || !isAbsolute(destinationPath))
    throw new Error('Stage copy paths must be absolute');
  const getuid = dependencies.getuid ?? (() => process.getuid?.());
  const getgid = dependencies.getgid ?? (() => process.getgid?.());
  const getgroups = dependencies.getgroups ?? (() => process.getgroups?.() ?? []);
  if (getuid() !== expectedUid || getgid() !== expectedGid)
    throw new Error('Stage copy did not enter the configured worker identity');
  const supplementary = getgroups();
  if (supplementary.some((group) => group !== expectedGid))
    throw new Error('Stage copy retained supplementary groups');

  let sourceFd;
  let destinationFd;
  let destinationCreated = false;
  try {
    sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const source = fstatSync(sourceFd);
    if (!source.isFile() || source.size <= 0)
      throw new Error('Render candidate must be a non-empty regular file');

    destinationFd = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      STAGE_MODE,
    );
    destinationCreated = true;
    fchmodSync(destinationFd, STAGE_MODE);

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        const next = writeSync(destinationFd, buffer, written, count - written, null);
        if (next <= 0) throw new Error('Stage copy made no write progress');
        written += next;
      }
      bytes += count;
    }
    const sourceAfterCopy = fstatSync(sourceFd);
    if (
      sourceAfterCopy.dev !== source.dev ||
      sourceAfterCopy.ino !== source.ino ||
      sourceAfterCopy.size !== source.size ||
      bytes !== source.size
    )
      throw new Error('Render candidate changed during stage copy');

    fsyncSync(destinationFd);
    const destination = fstatSync(destinationFd);
    if (
      !destination.isFile() ||
      destination.uid !== expectedUid ||
      destination.gid !== expectedGid ||
      (destination.mode & 0o7777) !== STAGE_MODE ||
      destination.size !== bytes
    )
      throw new Error('Staging file identity or mode is invalid');

    close(destinationFd);
    destinationFd = undefined;
    const directoryFd = openSync(
      dirname(destinationPath),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }

    return {
      bytes,
      sourceDevice: source.dev,
      destinationDevice: destination.dev,
      uid: destination.uid,
      gid: destination.gid,
      mode: STAGE_MODE,
    };
  } catch (error) {
    if (destinationCreated) {
      try {
        unlinkSync(destinationPath);
      } catch {}
    }
    throw error;
  } finally {
    close(destinationFd);
    close(sourceFd);
  }
}

async function main() {
  const [sourcePath, destinationPath, uidText, gidText] = process.argv.slice(2);
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0)
    throw new Error('Invalid stage copy identity');
  const result = copyStage(sourcePath, destinationPath, uid, gid);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
