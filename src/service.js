import {
  readdir,
  readFile,
  rm,
  unlink,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { Mutex } from './mutex.js';
import {
  buildSegment,
  loadSegment,
  parseSegmentFileName,
  segmentFileName,
  segmentPayload,
} from './segment.js';
import { SegmentRefs, SegmentRegistry } from './registry.js';
import { atomicWriteJson, fsyncDir } from './fsutil.js';
import { buildSnapshot, searchSnapshot } from './search.js';
import { parseQuery } from './query.js';

const MANIFEST_NAME = 'manifest.json';
const DEFAULT_FLUSH_THRESHOLD = 100;
const DEFAULT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const MAX_DOCUMENTS = 1000;

function memSource(entries) {
  return {
    *entries() {
      yield* entries;
    },
    get(id) {
      return entries.get(id);
    },
  };
}

function segmentSource(segment) {
  return {
    *entries() {
      yield* segment.map;
    },
    get(id) {
      return segment.get(id);
    },
    getPositions(id, term) {
      return segment.getPositions(id, term);
    },
  };
}

class CursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CursorError';
  }
}

export class DocumentService {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.maxDocuments = options.maxDocuments ?? MAX_DOCUMENTS;
    this.stateLock = new Mutex();
    this.maintenanceLock = new Mutex();
    this.registry = new SegmentRegistry();
    this.active = new Map();
    this.pending = [];
    this.segments = new Map();
    this.manifest = {
      format: 1,
      generation: 0,
      nextSegmentId: 1,
      segmentIds: [],
    };
    this.snapshots = new Map();
    this.orphans = new Set();
    this.maintenanceChain = Promise.resolve();
    this.closed = false;
    this.faults = {
      segmentWrite: null,
      manifestWrite: null,
      reclaim: null,
    };
  }

  static async open(directory, options = {}) {
    const service = new DocumentService(directory, options);
    await service.recover();
    return service;
  }

  async recover() {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    const manifestPath = this.#path(MANIFEST_NAME);
    const hasManifest = names.includes(MANIFEST_NAME);

    if (!hasManifest) {
      for (const name of names) {
        if (name.endsWith('.tmp') || parseSegmentFileName(name) !== null) {
          await rm(join(this.directory, name), { force: true });
        }
      }
      await fsyncDir(this.directory);
      return;
    }

    const rawManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      !rawManifest ||
      rawManifest.format !== 1 ||
      !Number.isSafeInteger(rawManifest.generation) ||
      rawManifest.generation < 0 ||
      !Number.isSafeInteger(rawManifest.nextSegmentId) ||
      rawManifest.nextSegmentId < 1 ||
      !Array.isArray(rawManifest.segmentIds)
    ) {
      throw new Error('invalid manifest');
    }

    const ids = [];
    const seen = new Set();
    for (const id of rawManifest.segmentIds) {
      if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) {
        throw new Error('invalid segment id in manifest');
      }
      seen.add(id);
      if (id >= rawManifest.nextSegmentId) {
        throw new Error('segment id is not below nextSegmentId');
      }
      ids.push(id);
    }

    const segments = new Map();
    for (const id of ids) segments.set(id, await loadSegment(this.directory, id));

    const committed = new Set(ids);
    const uncommittedIds = new Set();
    for (const name of names) {
      const id = parseSegmentFileName(name);
      if (id !== null && !committed.has(id)) {
        uncommittedIds.add(id);
        await rm(join(this.directory, name), { force: true });
      } else if (name.endsWith('.tmp')) {
        await rm(join(this.directory, name), { force: true });
      }
    }

    this.manifest = {
      format: 1,
      generation: rawManifest.generation,
      nextSegmentId: rawManifest.nextSegmentId,
      segmentIds: ids,
    };
    this.segments = segments;
    this.registry = new SegmentRegistry(segments);
    this.orphans = uncommittedIds;
    await fsyncDir(this.directory);
  }

  injectFault(stage) {
    if (!Object.hasOwn(this.faults, stage)) {
      throw new TypeError(`unknown fault stage ${stage}`);
    }
    this.faults[stage] = () => {
      this.faults[stage] = null;
      const error = new Error(`injected ${stage} failure`);
      error.code = 'INJECTED_FAULT';
      throw error;
    };
  }

  #path(name) {
    return join(this.directory, name);
  }

  #assertOpen() {
    if (this.closed) throw new Error('service is closed');
  }

  async #fault(stage, context = {}) {
    const fault = this.faults[stage];
    if (fault) await fault(stage, context);
  }

  #validateEntry(id, rev, text, { allowDeleted = false } = {}) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
      throw new TypeError('document id must be a non-empty string of at most 256 characters');
    }
    if (!Number.isSafeInteger(rev) || rev < 0) {
      throw new TypeError('revision must be a non-negative safe integer');
    }
    if (!allowDeleted && typeof text !== 'string') {
      throw new TypeError('text must be a string');
    }
  }

  #sameEntry(a, b) {
    return a.rev === b.rev && a.deleted === b.deleted && (a.deleted || a.text === b.text);
  }

  #latestLocked() {
    const latest = new Map();
    for (const id of this.manifest.segmentIds) {
      const segment = this.segments.get(id);
      for (const entry of segment.map.values()) latest.set(entry.id, entry);
    }
    for (const sealed of this.pending) {
      for (const entry of sealed.values()) latest.set(entry.id, entry);
    }
    for (const entry of this.active.values()) latest.set(entry.id, entry);
    return latest;
  }

  #sourcesLocked() {
    const sources = this.manifest.segmentIds.map((id) => segmentSource(this.segments.get(id)));
    for (const sealed of this.pending) sources.push(memSource(sealed));
    sources.push(memSource(this.active));
    return sources;
  }

  async put(id, rev, text) {
    this.#validateEntry(id, rev, text);
    const entry = { id, rev, deleted: false, text };
    return this.#writeEntry(entry);
  }

  async delete(id, rev) {
    this.#validateEntry(id, rev, null, { allowDeleted: true });
    const entry = { id, rev, deleted: true };
    return this.#writeEntry(entry);
  }

  async #writeEntry(entry) {
    this.#assertOpen();
    let shouldFlush = false;

    await this.stateLock.run(() => {
      const latest = this.#latestLocked();
      const current = latest.get(entry.id);

      if (current) {
        if (entry.rev < current.rev) {
          const error = new Error(`outdated revision for document ${entry.id}`);
          error.code = 'OUTDATED_REVISION';
          throw error;
        }
        if (entry.rev === current.rev) {
          if (this.#sameEntry(entry, current)) {
            return { changed: false, idempotent: true, revision: entry.rev };
          }
          const error = new Error(`revision conflict for document ${entry.id}`);
          error.code = 'REVISION_CONFLICT';
          throw error;
        }
      } else if (entry.deleted) {
        const error = new Error(`cannot delete unknown document ${entry.id}`);
        error.code = 'DOCUMENT_NOT_FOUND';
        throw error;
      }

      const wasLive = current && !current.deleted;
      const willBeLive = !entry.deleted;
      if (willBeLive && !wasLive) {
        let live = 0;
        for (const existing of latest.values()) {
          if (!existing.deleted) live++;
        }
        if (live >= this.maxDocuments) {
          const error = new Error(`document limit ${this.maxDocuments} reached`);
          error.code = 'DOCUMENT_LIMIT';
          throw error;
        }
      }

      this.active.set(entry.id, entry);
      shouldFlush = this.active.size >= this.flushThreshold;
      return { changed: true, idempotent: false, revision: entry.rev };
    });

    if (shouldFlush) this._scheduleMaintenance(() => this._flush());
    return { buffered: true, revision: entry.rev };
  }

  async flush() {
    return this._withMaintenance(() => this._flush());
  }

  async merge() {
    return this._withMaintenance(() => this._merge());
  }

  _scheduleMaintenance(task) {
    this.maintenanceChain = this._withMaintenance(task).catch(() => {});
  }

  _withMaintenance(task) {
    this.#assertOpen();
    const run = this.maintenanceLock.run(task);
    this.maintenanceChain = run.catch(() => {});
    return run;
  }

  async #writeAtomic(name, payload, stage) {
    return atomicWriteJson(this.#path(name), payload, async () => {
      await this.#fault(stage, { file: name });
    });
  }

  async _flush() {
    let sealed;
    let refs;
    let segment;
    let segmentId;
    let generation;
    let nextSegmentId;
    let oldIds;

    await this.stateLock.run(() => {
      if (this.active.size === 0) return null;
      segmentId = this.manifest.nextSegmentId;
      oldIds = [...this.manifest.segmentIds];
      sealed = this.active;
      this.active = new Map();
      this.pending.push(sealed);
      refs = new SegmentRefs(this.registry, oldIds);
      segment = buildSegment(segmentId, sealed);
      generation = this.manifest.generation + 1;
      nextSegmentId = segmentId + 1;
      return true;
    });

    if (segmentId === undefined) return { skipped: true };

    try {
      await this.#writeAtomic(segmentFileName(segmentId), segmentPayload(segment), 'segmentWrite');
      const manifest = {
        format: 1,
        generation,
        nextSegmentId,
        segmentIds: [...oldIds, segmentId],
      };
      await this.#writeAtomic(MANIFEST_NAME, manifest, 'manifestWrite');

      await this.stateLock.run(() => {
        const segmentMap = new Map(this.segments);
        segmentMap.set(segmentId, segment);
        this.segments = segmentMap;
        this.registry.setPublished(segmentMap);
        this.pending = this.pending.filter((candidate) => candidate !== sealed);
        this.manifest = manifest;
      });

      refs.release();
      await this.reclaimOrphans().catch(() => {});
      return { flushed: true, segmentId, generation };
    } catch (error) {
      const committed = error.committed === true;
      await this.stateLock.run(() => {
        if (committed) {
          const segmentMap = new Map(this.segments);
          segmentMap.set(segmentId, segment);
          this.segments = segmentMap;
          this.registry.setPublished(segmentMap);
          this.pending = this.pending.filter((candidate) => candidate !== sealed);
          this.manifest = {
            format: 1,
            generation,
            nextSegmentId,
            segmentIds: [...oldIds, segmentId],
          };
          return;
        }

        this.pending = this.pending.filter((candidate) => candidate !== sealed);
        const restored = new Map();
        for (const entry of sealed.values()) restored.set(entry.id, entry);
        for (const [id, entry] of this.active) restored.set(id, entry);
        this.active = restored;
      });

      if (committed) {
        refs.release();
        await this.reclaimOrphans().catch(() => {});
        return { flushed: true, segmentId, generation, durableManifest: 'assumed' };
      }

      refs.release();
      await rm(this.#path(segmentFileName(segmentId)), { force: true }).catch(() => {});
      throw error;
    }
  }

  async _merge() {
    let merged;
    let refs;
    let newId;
    let generation;
    let nextSegmentId;
    let oldIds;

    await this.stateLock.run(() => {
      oldIds = [...this.manifest.segmentIds];
      if (oldIds.length < 2) return false;
      newId = this.manifest.nextSegmentId;
      refs = new SegmentRefs(this.registry, oldIds);
      const latest = new Map();
      for (const id of oldIds) {
        for (const entry of this.segments.get(id).map.values()) {
          latest.set(entry.id, entry);
        }
      }
      merged = buildSegment(newId, latest);
      generation = this.manifest.generation + 1;
      nextSegmentId = newId + 1;
      return true;
    });

    if (!merged) return { skipped: true };

    try {
      await this.#writeAtomic(segmentFileName(newId), segmentPayload(merged), 'segmentWrite');
      const manifest = {
        format: 1,
        generation,
        nextSegmentId,
        segmentIds: [newId],
      };
      await this.#writeAtomic(MANIFEST_NAME, manifest, 'manifestWrite');

      await this.stateLock.run(() => {
        const segmentMap = new Map([[newId, merged]]);
        this.segments = segmentMap;
        this.registry.setPublished(segmentMap);
        this.manifest = manifest;
        for (const id of oldIds) this.orphans.add(id);
      });

      refs.release();
      let reclaimError = null;
      try {
        await this.reclaimOrphans();
      } catch (error) {
        reclaimError = error;
      }
      return { merged: true, segmentId: newId, generation, reclaimError };
    } catch (error) {
      const committed = error.committed === true;
      await this.stateLock.run(() => {
        if (!committed) return;
        const segmentMap = new Map([[newId, merged]]);
        this.segments = segmentMap;
        this.registry.setPublished(segmentMap);
        this.manifest = {
          format: 1,
          generation,
          nextSegmentId,
          segmentIds: [newId],
        };
        for (const id of oldIds) this.orphans.add(id);
      });

      if (committed) {
        refs.release();
        let reclaimError = null;
        try {
          await this.reclaimOrphans();
        } catch (reclaimFailure) {
          reclaimError = reclaimFailure;
        }
        return { merged: true, segmentId: newId, generation, reclaimError };
      }

      refs.release();
      await rm(this.#path(segmentFileName(newId)), { force: true }).catch(() => {});
      throw error;
    }
  }

  async reclaimOrphans() {
    const removable = [];
    const retained = [];

    await this.stateLock.run(() => {
      for (const id of [...this.orphans]) {
        if (this.registry.isReferenced(id) || this.segments.has(id)) {
          retained.push(id);
        } else {
          removable.push(id);
          this.orphans.delete(id);
        }
      }
    });

    try {
      for (const id of removable) {
        await this.#fault('reclaim', { segmentId: id });
        await unlink(this.#path(segmentFileName(id)));
      }
      if (removable.length > 0) await fsyncDir(this.directory);
    } catch (error) {
      await this.stateLock.run(() => {
        for (const id of removable) this.orphans.add(id);
      });
      throw error;
    }

    return { reclaimed: removable, retained };
  }

  async createSnapshot() {
    this.#assertOpen();
    return this.stateLock.run(() => {
      const snapshot = buildSnapshot(this.#sourcesLocked());
      const refs = new SegmentRefs(this.registry, this.manifest.segmentIds);
      this.snapshots.set(snapshot.id, {
        snapshot,
        refs,
        createdAt: snapshot.createdAt,
        lastUsedAt: snapshot.lastUsedAt,
      });
      return { id: snapshot.id, createdAt: snapshot.createdAt };
    });
  }

  #expiredSnapshotIdsLocked(now) {
    if (!Number.isFinite(this.snapshotTtlMs)) return [];
    const expired = [];
    for (const [id, entry] of this.snapshots) {
      if (now - entry.lastUsedAt > this.snapshotTtlMs) expired.push(id);
    }
    return expired;
  }

  async #sweepExpiredSnapshots() {
    const released = [];
    await this.stateLock.run(() => {
      const now = Date.now();
      for (const id of this.#expiredSnapshotIdsLocked(now)) {
        const entry = this.snapshots.get(id);
        if (entry) {
          this.snapshots.delete(id);
          released.push(entry.refs);
        }
      }
    });
    for (const refs of released) {
      refs.release();
    }
    if (released.length > 0) await this.reclaimOrphans().catch(() => {});
  }

  async releaseSnapshot(snapshotId) {
    let refs = null;
    await this.stateLock.run(() => {
      const entry = this.snapshots.get(snapshotId);
      if (entry) {
        this.snapshots.delete(snapshotId);
        refs = entry.refs;
      }
    });
    if (!refs) return { released: false };
    refs.release();
    await this.reclaimOrphans().catch(() => {});
    return { released: true };
  }

  #decodeCursor(cursor) {
    let raw;
    try {
      raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new CursorError('invalid pagination cursor');
    }
    if (!raw || raw.v !== 1 || typeof raw.s !== 'string' || typeof raw.a !== 'string') {
      throw new CursorError('invalid pagination cursor');
    }
    return raw;
  }

  #encodeCursor(snapshotId, afterDocId) {
    return Buffer.from(JSON.stringify({ v: 1, s: snapshotId, a: afterDocId }))
      .toString('base64url');
  }

  async query(queryText, options = {}) {
    this.#assertOpen();
    await this.#sweepExpiredSnapshots();
    const pageSize = options.pageSize ?? 20;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.maxDocuments) {
      throw new TypeError(`pageSize must be an integer between 1 and ${this.maxDocuments}`);
    }

    const parsed = parseQuery(queryText);
    const cursor = options.cursor ? this.#decodeCursor(options.cursor) : null;

    let result;
    await this.stateLock.run(() => {
      let entry;
      if (cursor) {
        entry = this.snapshots.get(cursor.s);
        if (!entry) throw new CursorError('pagination cursor is unknown or expired');
        entry.lastUsedAt = Date.now();
      } else {
        const snapshot = buildSnapshot(this.#sourcesLocked());
        const refs = new SegmentRefs(this.registry, this.manifest.segmentIds);
        entry = {
          snapshot,
          refs,
          createdAt: snapshot.createdAt,
          lastUsedAt: snapshot.createdAt,
        };
        this.snapshots.set(snapshot.id, entry);
      }

      const matches = searchSnapshot(entry.snapshot, parsed);
      const start = cursor
        ? matches.findIndex((match) => match.docId > cursor.a)
        : 0;
      const effectiveStart = Math.max(start, 0);
      const page = matches.slice(effectiveStart, effectiveStart + pageSize);
      const hasMore = effectiveStart + page.length < matches.length;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? this.#encodeCursor(entry.snapshot.id, last.docId)
        : null;

      result = {
        snapshotId: entry.snapshot.id,
        total: matches.length,
        hasMore,
        nextCursor,
        matches: page,
      };

      if (!nextCursor) {
        this.snapshots.delete(entry.snapshot.id);
        result._release = entry.refs;
      }
    });

    if (result._release) {
      const refs = result._release;
      delete result._release;
      refs.release();
      await this.reclaimOrphans().catch(() => {});
    }

    return result;
  }

  async stats() {
    return this.stateLock.run(() => {
      const latest = this.#latestLocked();
      let live = 0;
      let tombstones = 0;
      for (const entry of latest.values()) {
        if (entry.deleted) tombstones++;
        else live++;
      }
      return {
        live,
        tombstones,
        buffered: this.active.size,
        sealed: this.pending.reduce((count, map) => count + map.size, 0),
        segmentCount: this.segments.size,
        generation: this.manifest.generation,
        nextSegmentId: this.manifest.nextSegmentId,
        snapshotCount: this.snapshots.size,
        orphanCount: this.orphans.size,
      };
    });
  }

  async close() {
    this.closed = true;
    try {
      await this.maintenanceChain;
    } finally {
      for (const entry of this.snapshots.values()) entry.refs.release();
      this.snapshots.clear();
    }
  }
}
