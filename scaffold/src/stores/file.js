import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  StoreContractError,
  StoreConflictError,
  StoreCorruptionError,
  assertStateStore,
  createEmptySnapshot,
  validateSnapshot,
} from './contracts.js';
import { defaultMigrationRegistry } from './migrations.js';
import { createSnapshotStore } from './snapshot-store.js';

const CHECKSUM_PREFIX = 'sha256:';
const LOCK_RETRY_MS = 10;
const INCOMPLETE_LOCK_STALE_MS = 30_000;
let tempSequence = 0;
const fileSerializers = new Map();

function acquireFileSerializer(filePath) {
  let coordinator = fileSerializers.get(filePath);
  if (!coordinator) {
    coordinator = {
      references: 0,
      tail: Promise.resolve(),
      serialize(operation) {
        const run = coordinator.tail.then(operation, operation);
        coordinator.tail = run.catch(() => {});
        return run;
      },
    };
    fileSerializers.set(filePath, coordinator);
  }
  coordinator.references += 1;
  let released = false;
  return {
    serialize: coordinator.serialize,
    release() {
      if (released) return;
      released = true;
      coordinator.references -= 1;
      if (coordinator.references === 0) {
        void coordinator.tail.then(() => {
          if (coordinator.references === 0 && fileSerializers.get(filePath) === coordinator) {
            fileSerializers.delete(filePath);
          }
        });
      }
    },
  };
}

function snapshotChecksum(snapshot) {
  return `${CHECKSUM_PREFIX}${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function removeAbandonedLock(lockPath) {
  // Serialize stale-lock reclamation separately from the data lock. Without
  // this tiny reaper mutex, two waiters can both inspect the same dead owner:
  // one removes it and a new writer acquires it, then the second waiter removes
  // the *new* writer's lock based on its stale observation. Only the reaper
  // holder is allowed to re-read and unlink the current lock.
  const reaperPath = `${lockPath}.reaper`;
  let reaper;
  try {
    reaper = await open(reaperPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    let owner;
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch {
      try {
        const handle = await open(lockPath, 'r');
        const info = await handle.stat();
        await handle.close();
        if (Date.now() - info.mtimeMs > INCOMPLETE_LOCK_STALE_MS) await rm(lockPath, { force: true });
      } catch {}
      return;
    }
    if (owner?.host === hostname() && !processIsAlive(Number(owner.pid))) {
      await rm(lockPath, { force: true });
    }
  } finally {
    try {
      await reaper.close();
    } catch {}
    await rm(reaperPath, { force: true });
  }
}

async function withFileLock(lockPath, operation, timeoutMs) {
  const startedAt = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid, host: hostname(), createdAt: new Date().toISOString() }), 'utf8');
      await handle.sync();
      break;
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error.code !== 'EEXIST') throw error;
      await removeAbandonedLock(lockPath);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new StoreConflictError('[state-store:file] timed out acquiring the cross-process state lock');
      }
      await wait(LOCK_RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
}

/** Exported for deterministic migration/corruption fixtures. */
export function encodeFileSnapshot(snapshot) {
  const canonical = validateSnapshot(snapshot, { expectedSchemaVersion: snapshot.schemaVersion });
  return `${JSON.stringify({ ...canonical, checksum: snapshotChecksum(canonical) }, null, 2)}\n`;
}

export function decodeFileSnapshot(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new StoreCorruptionError('[state-store:file] state file is not valid JSON', { cause: error });
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new StoreCorruptionError('[state-store:file] state file must contain an object');
  }
  const { checksum, ...snapshot } = envelope;
  if (typeof checksum !== 'string' || !checksum.startsWith(CHECKSUM_PREFIX)) {
    throw new StoreCorruptionError('[state-store:file] state file checksum is missing');
  }
  const expected = snapshotChecksum(snapshot);
  if (checksum !== expected) {
    throw new StoreCorruptionError('[state-store:file] state file checksum mismatch');
  }
  return validateSnapshot(snapshot);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows and some filesystems do not allow fsync on a directory. The
    // file itself was fsynced before rename, so do not replace atomic rename
    // with an unsafe unlink/write fallback.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(filePath, snapshot) {
  const directory = dirname(filePath);
  const fileName = basename(filePath);
  await mkdir(directory, { recursive: true });
  tempSequence += 1;
  const tempPath = join(directory, `.${fileName}.tmp-${process.pid}-${tempSequence}`);
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(encodeFileSnapshot(snapshot), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupStaleTemps(filePath) {
  const directory = dirname(filePath);
  const prefix = `.${basename(filePath)}.tmp-`;
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(names
    .filter((name) => name.startsWith(prefix))
    .map((name) => rm(join(directory, name), { force: true })));
}

/**
 * Durable same-host, cross-process adapter. An exclusive sibling lock file
 * serializes writers before each refreshed snapshot is persisted with
 * temp + fsync + atomic rename. Multi-host/shared-filesystem coordination is
 * intentionally not claimed; use a CAS-capable injected driver for that case.
 */
export async function createFileStateStore({
  filePath,
  migrationRegistry = defaultMigrationRegistry,
  idFactory,
  lockTimeoutMs = 30_000,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new StoreContractError('[state-store:file] filePath must be a non-empty string');
  }
  if (!migrationRegistry || !Number.isInteger(migrationRegistry.currentVersion)) {
    throw new StoreContractError('[state-store:file] migrationRegistry is invalid');
  }

  const absoluteFilePath = resolve(filePath);
  await mkdir(dirname(absoluteFilePath), { recursive: true });
  const lockPath = `${absoluteFilePath}.lock`;
  const coordinator = acquireFileSerializer(absoluteFilePath);
  const serialize = (operation) => coordinator.serialize(() => withFileLock(lockPath, operation, lockTimeoutMs));
  try {
    const snapshot = await serialize(async () => {
      await cleanupStaleTemps(absoluteFilePath);
      let loaded;
      let mustPersist = false;
      try {
        loaded = decodeFileSnapshot(await readFile(absoluteFilePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        loaded = createEmptySnapshot(migrationRegistry.currentVersion);
        mustPersist = true;
      }

      if (loaded.schemaVersion !== migrationRegistry.currentVersion) {
        loaded = await migrationRegistry.migrate(loaded);
        mustPersist = true;
      }
      loaded = validateSnapshot(loaded, { expectedSchemaVersion: migrationRegistry.currentVersion });
      if (mustPersist) await atomicWrite(absoluteFilePath, loaded);
      return loaded;
    });

    return assertStateStore(createSnapshotStore({
      adapterName: 'file',
      capabilities: {
        durable: true,
        restartRecovery: true,
        transactions: true,
        compareAndSwap: true,
        multiProcess: true,
        multiHost: false,
        migrations: true,
        atomicRename: true,
        conformance: 'built-in-cross-process-file-lock',
      },
      initialSnapshot: snapshot,
      persist: (nextSnapshot) => atomicWrite(absoluteFilePath, nextSnapshot),
      refresh: async () => decodeFileSnapshot(await readFile(absoluteFilePath, 'utf8')),
      serialize,
      onClose: coordinator.release,
      idFactory,
    }));
  } catch (error) {
    coordinator.release();
    throw error;
  }
}
