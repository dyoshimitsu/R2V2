// The sync engine. It only talks to the two interfaces below, so it runs
// unchanged against Obsidian + R2 in the plugin and against in-memory fakes
// in tests.
import { sameBytes } from "./bytes";
export interface LocalEntry {
  mtime: number;
  size: number;
}

export interface RemoteEntry {
  etag: string;
  size: number;
}

/** What both sides looked like the last time this device synced a file. */
export interface BaseEntry {
  mtime: number;
  size: number;
  etag: string;
}

export interface SyncState {
  /** Identifies the bucket/prefix this state belongs to. */
  remoteId: string;
  files: Record<string, BaseEntry>;
}

export interface LocalFs {
  list(): Promise<Map<string, LocalEntry>>;
  stat(path: string): Promise<LocalEntry | null>;
  read(path: string): Promise<ArrayBuffer>;
  /** Create or overwrite; returns the resulting stat. */
  write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalEntry>;
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface PutOptions {
  mtime?: number;
  /** Only overwrite if the remote object still has this ETag. */
  ifMatch?: string;
  /** Only create if the remote object does not exist. */
  ifNoneMatch?: boolean;
}

export interface Remote {
  list(): Promise<Map<string, RemoteEntry>>;
  get(key: string): Promise<{ data: ArrayBuffer; etag: string; mtime?: number }>;
  /** Returns the new ETag. Throws PreconditionFailedError on a lost race. */
  put(key: string, data: ArrayBuffer, opts: PutOptions): Promise<string>;
  delete(key: string): Promise<void>;
}

export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`remote changed during sync: ${key}`);
    this.name = "PreconditionFailedError";
  }
}

export type ActionType = "upload" | "download" | "conflict" | "deleteLocal" | "deleteRemote" | "forget";

export interface Action {
  type: ActionType;
  key: string;
  local?: LocalEntry;
  remote?: RemoteEntry;
}

/**
 * Three-way comparison of local, remote and the last-synced base.
 * Pure: decides what to do, performs nothing.
 */
export function planSync(
  local: Map<string, LocalEntry>,
  remote: Map<string, RemoteEntry>,
  base: Record<string, BaseEntry>,
): Action[] {
  const keys = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
  const actions: Action[] = [];
  for (const key of [...keys].sort()) {
    const l = local.get(key);
    const r = remote.get(key);
    const b: BaseEntry | undefined = base[key];
    const localChanged = l ? !b || l.mtime !== b.mtime || l.size !== b.size : !!b;
    const remoteChanged = r ? !b || r.etag !== b.etag : !!b;

    let type: ActionType | null = null;
    if (!l && !r) {
      type = "forget";
    } else if (l && r) {
      if (localChanged && remoteChanged) type = "conflict";
      else if (localChanged) type = "upload";
      else if (remoteChanged) type = "download";
    } else if (l) {
      // Missing remotely: deleted there, unless we changed it since (edit wins).
      type = b && !localChanged ? "deleteLocal" : "upload";
    } else {
      type = b && !remoteChanged ? "deleteRemote" : "download";
    }
    if (type) actions.push({ type, key, local: l, remote: r });
  }
  return actions;
}

export interface Risk {
  /** Existing files this pass would overwrite or delete. */
  changes: number;
  /** How many of those are deletions. */
  deletions: number;
  /** Files synced before this pass. */
  total: number;
}

/**
 * How much existing data a plan puts at stake. A pass that rewrites or removes
 * a large part of the vault at once usually means something is off (wrong
 * bucket, wiped remote, lost sync record) rather than a real wave of edits.
 */
export function assessRisk(actions: Action[], total: number): Risk {
  let deletions = 0;
  let overwrites = 0;
  for (const a of actions) {
    if (a.type === "deleteLocal" || a.type === "deleteRemote") deletions++;
    else if (a.type === "conflict" || (a.type === "upload" && a.remote) || (a.type === "download" && a.local))
      overwrites++;
  }
  return { changes: deletions + overwrites, deletions, total };
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  skipped: number;
  errors: { key: string; message: string }[];
  aborted: boolean;
}

export interface SyncOptions {
  /** Return false to leave a path alone on both sides. */
  include?: (key: string, size: number) => boolean;
  /** What to do when both sides changed the same file. Default: keep both. */
  conflictAction?: ConflictAction;
  /**
   * Ask before a pass that would overwrite or delete more than this share of
   * the previously synced files (default 50). Without a callback it aborts.
   */
  protectPercent?: number;
  confirmLargeChange?: (risk: Risk) => Promise<boolean>;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  now?: () => Date;
}

export type ConflictAction = "keep_both" | "keep_newer";

export function conflictPath(path: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${stem} (conflict ${stamp})${ext}`;
}

const sameStat = (a: LocalEntry | null | undefined, b: LocalEntry | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.mtime === b.mtime && a.size === b.size);

/** Run one sync pass. Mutates `state.files` as operations succeed. */
export async function runSync(
  local: LocalFs,
  remote: Remote,
  state: SyncState,
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    conflicts: [],
    skipped: 0,
    errors: [],
    aborted: false,
  };
  const include = opts.include ?? (() => true);
  const now = opts.now ?? (() => new Date());

  const [localAll, remoteAll] = await Promise.all([local.list(), remote.list()]);

  // A path excluded on either side is left alone on both.
  const excluded = new Set<string>();
  for (const [k, v] of localAll) if (!include(k, v.size)) excluded.add(k);
  for (const [k, v] of remoteAll) if (!include(k, v.size)) excluded.add(k);
  const localMap = new Map([...localAll].filter(([k]) => !excluded.has(k)));
  const remoteMap = new Map([...remoteAll].filter(([k]) => !excluded.has(k)));
  const base: Record<string, BaseEntry> = {};
  for (const [k, v] of Object.entries(state.files)) {
    if (!excluded.has(k) && include(k, v.size)) base[k] = v;
  }

  const actions = planSync(localMap, remoteMap, base);

  const risk = assessRisk(actions, Object.keys(base).length);
  if (risk.changes > 10 && risk.changes > (risk.total * (opts.protectPercent ?? 50)) / 100) {
    const ok = opts.confirmLargeChange ? await opts.confirmLargeChange(risk) : false;
    if (!ok) {
      summary.aborted = true;
      return summary;
    }
  }

  const record = (key: string, st: LocalEntry, etag: string) => {
    state.files[key] = { mtime: st.mtime, size: st.size, etag };
  };

  /** Upload unless the remote moved since we looked; the next pass then sees a conflict. */
  const upload = async (key: string, data: ArrayBuffer, st: LocalEntry, expected: string | undefined) => {
    try {
      const etag = await remote.put(key, data, {
        mtime: st.mtime,
        ifMatch: expected,
        ifNoneMatch: !expected,
      });
      record(key, st, etag);
      summary.uploaded++;
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
      summary.skipped++;
    }
  };

  const exec = async (a: Action): Promise<void> => {
    const { key } = a;
    switch (a.type) {
      case "forget":
        delete state.files[key];
        return;

      case "upload":
        await upload(key, await local.read(key), a.local!, a.remote?.etag);
        return;

      case "download": {
        if (!sameStat(await local.stat(key), a.local)) {
          summary.skipped++; // edited locally since the scan
          return;
        }
        const obj = await remote.get(key);
        const st = await local.write(key, obj.data, obj.mtime);
        record(key, st, obj.etag);
        summary.downloaded++;
        return;
      }

      case "conflict": {
        const [data, obj] = await Promise.all([local.read(key), remote.get(key)]);
        if (!sameStat(await local.stat(key), a.local)) {
          summary.skipped++;
          return;
        }
        if (sameBytes(data, obj.data)) {
          // Both sides hold the same content (e.g. first sync of two copies).
          record(key, a.local!, obj.etag);
          return;
        }
        if (opts.conflictAction === "keep_newer") {
          if (a.local!.mtime > (obj.mtime ?? 0)) {
            await upload(key, data, a.local!, obj.etag);
          } else {
            const st = await local.write(key, obj.data, obj.mtime);
            record(key, st, obj.etag);
            summary.downloaded++;
          }
          return;
        }
        // Keep the local version under a new name; the remote one takes the path.
        const copy = conflictPath(key, now());
        await local.rename(key, copy);
        const st = await local.write(key, obj.data, obj.mtime);
        record(key, st, obj.etag);
        summary.conflicts.push(copy);
        return;
      }

      case "deleteLocal": {
        if (!sameStat(await local.stat(key), a.local)) {
          summary.skipped++;
          return;
        }
        await local.trash(key);
        delete state.files[key];
        summary.deletedLocal++;
        return;
      }

      case "deleteRemote":
        await remote.delete(key);
        delete state.files[key];
        summary.deletedRemote++;
        return;
    }
  };

  let done = 0;
  await runPool(actions, opts.concurrency ?? 4, async (a) => {
    try {
      await exec(a);
    } catch (e) {
      summary.errors.push({ key: a.key, message: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.(++done, actions.length);
  });

  return summary;
}

/** Run `task` over `items`, at most `limit` at a time. */
async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
