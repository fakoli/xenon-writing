/**
 * Reads the local base rewrite route's server identity file (see serverIdentity.ts). The
 * only main-process file besides the Electron chooser allowed
 * `node:fs/promises` (tests/contract/offline.test.ts), and it reads one
 * compiled-in path.
 *
 * The secret is only as private as the file, so the file is refused unless
 * the directory and the file are owned by this user, are not symlinks, and
 * have no group or other permission bits. The file must also be small. It
 * logs nothing and never puts the file's contents in an error.
 */
import { constants, lstat, open } from 'node:fs/promises';
import type { IdentityExpectation } from './serverIdentity.ts';
import { IdentityUnavailable, parseIdentityRecord } from './serverIdentity.ts';

/** Far above the real file (about 220 bytes); anything larger is not it. */
const MAX_IDENTITY_FILE_BYTES = 4096;

function ownerOnly(info: { mode: number; uid: number }, uid: number): boolean {
  return info.uid === uid && (info.mode & 0o077) === 0;
}

/** Returns this start's secret from `filePath`, or throws IdentityUnavailable. */
export async function readIdentitySecret(filePath: string, expected: IdentityExpectation): Promise<Uint8Array> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new IdentityUnavailable('no user ID on this platform');
  const slash = filePath.lastIndexOf('/');
  if (!filePath.startsWith('/') || slash <= 0) throw new IdentityUnavailable('identity file path is not absolute');

  try {
    const directory = await lstat(filePath.slice(0, slash));
    // lstat: a symlink in the directory's place is not a directory.
    if (!directory.isDirectory() || !ownerOnly(directory, uid)) {
      throw new IdentityUnavailable('identity directory is not private to this user');
    }
    // O_NOFOLLOW: a symlink in the file's place fails to open instead of being
    // followed. O_NONBLOCK: a FIFO there opens at once (and is then refused as
    // not a file) instead of waiting for a writer.
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = await handle.stat();
      if (!file.isFile() || !ownerOnly(file, uid)) throw new IdentityUnavailable('identity file is not private to this user');
      // One byte past the limit is enough to know the file is not the identity file.
      const bytes = new Uint8Array(MAX_IDENTITY_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (bytesRead > MAX_IDENTITY_FILE_BYTES) throw new IdentityUnavailable('identity file is too large');
      return parseIdentityRecord(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), expected);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof IdentityUnavailable) throw error;
    // ENOENT, ELOOP, EACCES, invalid UTF-8: the reason only, never a path or contents.
    throw new IdentityUnavailable('identity file could not be read');
  }
}
