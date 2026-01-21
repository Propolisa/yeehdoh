// HybridCache.js
// Unified hierarchical cache over File System Access API (preferred) or IndexedDB.
// Keys use slash-separated "paths" similar to S3 / Vault.
// Values are JSON-serializable (serialized via JSON.stringify).
let HYBRID_CACHE_ENABLED = false;

export function disableHybridCache() {
    HYBRID_CACHE_ENABLED = false;
}

export function enableHybridCache() {
    HYBRID_CACHE_ENABLED = true;
}

/**
 * @typedef {Object} HybridCacheEntryMeta
 * @property {string} cacheName        Name of the cache.
 * @property {string} key              Key within the cache (slash path).
 * @property {string} backend          Backend identifier ("fs" or "idb").
 * @property {string} createdAt        ISO timestamp of first creation.
 * @property {string} modifiedAt       ISO timestamp of last write.
 * @property {string=} lastAccessedAt  ISO timestamp of last read (best-effort).
 * @property {number} sizeBytes        Approximate size of stored payload in bytes.
 */

/**
 * @typedef {Object} HybridCacheEntry
 * @property {string} key
 * @property {HybridCacheEntryMeta} meta
 */

/**
 * @typedef {Object} HybridCacheInfo
 * @property {string} cacheName
 * @property {string} backend
 * @property {number} entryCount
 * @property {number} sizeBytes
 * @property {string|null} createdAt
 * @property {string|null} modifiedAt
 */

/**
 * @typedef {Object} HybridCacheBackend
 * @property {string} backendType
 * @property {(cacheName: string, key: string) => Promise<{ value: any, meta: HybridCacheEntryMeta } | null>} readEntry
 * @property {(cacheName: string, key: string, value: any) => Promise<{ value: any, meta: HybridCacheEntryMeta }>} writeEntry
 * @property {(cacheName: string, keyPrefix: string | null) => Promise<void>} deleteByPrefix
 * @property {(cacheName?: string) => Promise<HybridCacheEntry[]>} listEntries
 * @property {() => Promise<string[]>} listCaches
 */

const HYBRID_TYPE_REGISTRY = {
    "Float32Array": {
        serialize(value) {
            return {
                __type: "Float32Array",
                data: Array.from(value), // backend may override with binary
            };
        },
        deserialize(obj) {
            return new Float32Array(obj.data);
        },
        toBinary(value) {
            return new Uint8Array(value.buffer); // FS/IDB can store binary blobs
        },
        fromBinary(buffer) {
            return new Float32Array(buffer);
        },
    },

    "Uint8Array": {
        serialize(value) {
            return {
                __type: "Uint8Array",
                data: Array.from(value),
            };
        },
        deserialize(obj) {
            return new Uint8Array(obj.data);
        },
        toBinary(value) {
            return new Uint8Array(value.buffer);
        },
        fromBinary(buffer) {
            return new Uint8Array(buffer);
        },
    },
};

function encodeForStorage(value) {
    if (value?.constructor?.name) {
        const reg = HYBRID_TYPE_REGISTRY[value.constructor.name];
        if (reg) {
            return {
                __encoded: true,
                __type: value.constructor.name,
                binary: true,
                payload: reg.serialize(value),
            };
        }
    }

    if (Array.isArray(value)) {
        return value.map((v) => encodeForStorage(v));
    }

    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = encodeForStorage(v);
        }
        return out;
    }

    return value;
}

function decodeFromStorage(value) {
    if (value && value.__encoded && value.__type) {
        const reg = HYBRID_TYPE_REGISTRY[value.__type];
        if (reg) {
            return reg.deserialize(value.payload);
        }
    }

    if (Array.isArray(value)) {
        return value.map((v) => decodeFromStorage(v));
    }

    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = decodeFromStorage(v);
        }
        return out;
    }

    return value;
}

/**
 * @implements {HybridCacheBackend}
 */
class NullBackend {
    constructor() {
        this.backendType = "disabled";
    }

    async readEntry(cacheName, key) {
        return null;
    }

    async writeEntry(cacheName, key, value) {
        const now = new Date().toISOString();
        return {
            value,
            meta: {
                cacheName,
                key,
                backend: this.backendType,
                createdAt: now,
                modifiedAt: now,
                lastAccessedAt: now,
                sizeBytes: 0,
            },
        };
    }

    async deleteByPrefix(cacheName, keyPrefix) {
        // no-op
    }

    async listEntries(cacheName) {
        return [];
    }

    async listCaches() {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Backend A: File System Access API (Origin Private File System)
// ---------------------------------------------------------------------------

/**
 * @implements {HybridCacheBackend}
 */
class FileSystemBackend {
    constructor() {
        this.backendType = "fs";
        /** @type {Promise<FileSystemDirectoryHandle>} */
        this._rootPromise = this._initRoot();
    }

    async _initRoot() {
        // Origin Private File System root
        const opfsRoot = await navigator.storage.getDirectory();
        // Single root folder for all caches
        const root = await opfsRoot.getDirectoryHandle("hybrid-cache", {
            create: true,
        });
        return root;
    }

    /** @returns {Promise<FileSystemDirectoryHandle>} */
    async _getRootDir() {
        return this._rootPromise;
    }

    /**
     * Get (or create) directory for given cache/key.
     * Each key path "a/b/c" becomes nested directories under cacheName.
     * The value is stored in a file "__value__.json" inside the leaf directory.
     *
     * @param {string} cacheName
     * @param {string} key
     * @param {{ create?: boolean }} [opts]
     * @returns {Promise<FileSystemDirectoryHandle | null>}
     */
    async _getDirForKey(cacheName, key, opts = {}) {
        const { create = false } = opts;
        const root = await this._getRootDir();

        let cacheDir;
        try {
            cacheDir = await root.getDirectoryHandle(cacheName, { create });
        } catch (err) {
            if (!create) return null;
            throw err;
        }

        if (!key || key === "/") {
            return cacheDir;
        }

        const segments = key.split("/").filter(Boolean);
        let dir = cacheDir;

        for (const seg of segments) {
            try {
                dir = await dir.getDirectoryHandle(seg, { create });
            } catch (err) {
                if (!create) return null;
                throw err;
            }
        }
        return dir;
    }

    /**
     * Read metadata file from a key directory.
     * @param {FileSystemDirectoryHandle} dir
     * @returns {Promise<HybridCacheEntryMeta | null>}
     */
    async _readMeta(dir) {
        try {
            const mh = await dir.getFileHandle("__meta__.json", {
                create: false,
            });
            const file = await mh.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    /**
     * Write metadata file to a key directory.
     * @param {FileSystemDirectoryHandle} dir
     * @param {HybridCacheEntryMeta} meta
     */
    async _writeMeta(dir, meta) {
        const mh = await dir.getFileHandle("__meta__.json", { create: true });
        const writable = await mh.createWritable();
        await writable.write(JSON.stringify(meta));
        await writable.close();
    }

    /**
     * Recursively delete a directory.
     * @param {FileSystemDirectoryHandle} parent
     * @param {string} entryName
     */
    async _deleteEntry(parent, entryName) {
        // removeEntry supports { recursive: true } in modern Chromium.
        await parent.removeEntry(entryName, { recursive: true });
    }

    /**
     * Recursively walk a cache directory and collect entries.
     * Each directory that contains "__value__.json" is a key.
     *
     * @param {FileSystemDirectoryHandle} dir
     * @param {string} prefix
     * @param {HybridCacheEntry[]} out
     * @param {string} cacheName
     */
    async _walk(dir, prefix, out, cacheName) {
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind === "directory") {
                const childPrefix = prefix ? `${prefix}/${name}` : name;
                const childDir = await dir.getDirectoryHandle(name);

                const meta = await this._readMeta(childDir);
                if (meta) {
                    out.push({
                        key: childPrefix,
                        meta,
                    });
                }

                await this._walk(childDir, childPrefix, out, cacheName);
            }
        }
    }

    /**
     * @param {string} cacheName
     * @param {string} key
     * @returns {Promise<{ value: any, meta: HybridCacheEntryMeta } | null>}
     */
    async readEntry(cacheName, key) {
        const dir = await this._getDirForKey(cacheName, key, { create: false });
        if (!dir) return null;

        try {
            const fh = await dir.getFileHandle("__value__.json", {
                create: false,
            });
            const file = await fh.getFile();
            const text = await file.text();
            const raw = JSON.parse(text);
            const value = decodeFromStorage(raw);
            const sizeBytes = file.size;

            let meta = await this._readMeta(dir);
            const now = new Date().toISOString();
            if (!meta) {
                meta = {
                    cacheName,
                    key,
                    backend: this.backendType,
                    createdAt: now,
                    modifiedAt: now,
                    lastAccessedAt: now,
                    sizeBytes,
                };
            } else {
                meta.lastAccessedAt = now;
                meta.sizeBytes = sizeBytes;
            }
            await this._writeMeta(dir, meta);

            return { value, meta };
        } catch {
            return null;
        }
    }

    /**
     * @param {string} cacheName
     * @param {string} key
     * @param {any} value
     * @returns {Promise<{ value: any, meta: HybridCacheEntryMeta }>}
     */
    async writeEntry(cacheName, key, value) {
        const dir = await this._getDirForKey(cacheName, key, { create: true });
        const fh = await dir.getFileHandle("__value__.json", { create: true });
        const writable = await fh.createWritable();
        const encoded = encodeForStorage(value);
        const text = JSON.stringify(encoded);
        await writable.write(text);
        await writable.close();

        const sizeBytes = text.length;
        const now = new Date().toISOString();
        let meta = await this._readMeta(dir);

        if (!meta) {
            meta = {
                cacheName,
                key,
                backend: this.backendType,
                createdAt: now,
                modifiedAt: now,
                lastAccessedAt: now,
                sizeBytes,
            };
        } else {
            meta.modifiedAt = now;
            meta.sizeBytes = sizeBytes;
        }

        await this._writeMeta(dir, meta);
        return { value, meta };
    }

    /**
     * Delete entries whose key matches keyPrefix or starts with "keyPrefix/".
     * If keyPrefix is null, delete the entire cache.
     *
     * @param {string} cacheName
     * @param {string | null} keyPrefix
     */
    async deleteByPrefix(cacheName, keyPrefix) {
        const root = await this._getRootDir();
        let cacheDir;
        try {
            cacheDir = await root.getDirectoryHandle(cacheName, {
                create: false,
            });
        } catch {
            return;
        }

        // Delete entire cache directory
        if (keyPrefix == null || keyPrefix === "") {
            await root.removeEntry(cacheName, { recursive: true });
            return;
        }

        const segments = keyPrefix.split("/").filter(Boolean);
        if (!segments.length) {
            await root.removeEntry(cacheName, { recursive: true });
            return;
        }

        // Directly delete the directory corresponding to keyPrefix.
        const parentSegments = segments.slice(0, -1);
        const leafName = segments[segments.length - 1];

        let parentDir = cacheDir;
        for (const seg of parentSegments) {
            try {
                parentDir = await parentDir.getDirectoryHandle(seg, {
                    create: false,
                });
            } catch {
                return;
            }
        }

        try {
            await parentDir.removeEntry(leafName, { recursive: true });
        } catch {
            // Ignore missing / partial failures
        }
    }

    /**
     * List all entries from all caches (or a single cache if name provided).
     * @param {string} [cacheName]
     * @returns {Promise<HybridCacheEntry[]>}
     */
    async listEntries(cacheName) {
        const root = await this._getRootDir();
        /** @type {HybridCacheEntry[]} */
        const entries = [];

        if (cacheName) {
            let cacheDir;
            try {
                cacheDir = await root.getDirectoryHandle(cacheName, {
                    create: false,
                });
            } catch {
                return entries;
            }
            await this._walk(cacheDir, "", entries, cacheName);
            return entries;
        }

        // All caches
        for await (const [name, handle] of root.entries()) {
            if (handle.kind !== "directory") continue;
            const cacheDir = await root.getDirectoryHandle(name, {
                create: false,
            });
            await this._walk(cacheDir, "", entries, name);
        }

        return entries;
    }

    /**
     * @returns {Promise<string[]>}
     */
    async listCaches() {
        const root = await this._getRootDir();
        const caches = [];
        for await (const [name, handle] of root.entries()) {
            if (handle.kind === "directory") caches.push(name);
        }
        return caches;
    }
}

// ---------------------------------------------------------------------------
// Backend B: IndexedDB (flat paths, same semantics)
// ---------------------------------------------------------------------------

/**
 * @implements {HybridCacheBackend}
 */
class IndexedDBBackend {
    constructor() {
        this.backendType = "idb";
        /** @type {Promise<IDBDatabase>} */
        this._dbPromise = this._open();
    }

    _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open("HybridCacheDB", 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                const store = db.createObjectStore("entries", {
                    keyPath: "fullKey",
                });
                store.createIndex("byCache", "cacheName", { unique: false });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /** @returns {Promise<IDBDatabase>} */
    async _db() {
        return this._dbPromise;
    }

    _fullKey(cacheName, key) {
        // flat path, but includes cacheName for quick prefix grouping
        return `${cacheName}::${key}`;
    }

    /**
     * @param {string} cacheName
     * @param {string} key
     * @returns {Promise<{ value: any, meta: HybridCacheEntryMeta } | null>}
     */
    async readEntry(cacheName, key) {
        const db = await this._db();
        const fullKey = this._fullKey(cacheName, key);

        return new Promise((resolve, reject) => {
            const tx = db.transaction("entries", "readonly");
            const store = tx.objectStore("entries");
            const req = store.get(fullKey);

            req.onsuccess = () => {
                const rec = req.result;

                if (!rec) {
                    resolve(null);
                    return;
                }
                const now = new Date().toISOString();
                rec.meta.lastAccessedAt = now;

                // Fire-and-forget update of lastAccessedAt
                const tx2 = db.transaction("entries", "readwrite");
                tx2.objectStore("entries").put(rec);

                resolve({
                    value: decodeFromStorage(rec.value),
                    meta: rec.meta,
                });
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * @param {string} cacheName
     * @param {string} key
     * @param {any} value
     * @returns {Promise<{ value: any, meta: HybridCacheEntryMeta }>}
     */
    async writeEntry(cacheName, key, value) {
        const db = await this._db();
        const fullKey = this._fullKey(cacheName, key);
        const now = new Date().toISOString();
        const encoded = encodeForStorage(value);
        const text = JSON.stringify(encoded);

        const sizeBytes = text.length;

        return new Promise((resolve, reject) => {
            const tx = db.transaction("entries", "readwrite");
            const store = tx.objectStore("entries");
            const reqGet = store.get(fullKey);

            reqGet.onsuccess = () => {
                const existing = reqGet.result;
                /** @type {HybridCacheEntryMeta} */
                const meta = (existing && existing.meta) || {
                    cacheName,
                    key,
                    backend: this.backendType,
                    createdAt: now,
                    modifiedAt: now,
                    lastAccessedAt: now,
                    sizeBytes,
                };

                meta.modifiedAt = now;
                meta.lastAccessedAt = now;
                meta.sizeBytes = sizeBytes;

                const rec = {
                    fullKey,
                    cacheName,
                    key,
                    value,
                    meta,
                };

                const reqPut = store.put(rec);
                reqPut.onsuccess = () => resolve({ value, meta });
                reqPut.onerror = () => reject(reqPut.error);
            };
            reqGet.onerror = () => reject(reqGet.error);
        });
    }

    /**
     * Delete entries whose key matches keyPrefix or starts with "keyPrefix/".
     * If keyPrefix is null, delete entire cache.
     *
     * @param {string} cacheName
     * @param {string | null} keyPrefix
     * @returns {Promise<void>}
     */
    async deleteByPrefix(cacheName, keyPrefix) {
        const db = await this._db();

        return new Promise((resolve, reject) => {
            const tx = db.transaction("entries", "readwrite");
            const store = tx.objectStore("entries");
            const index = store.index("byCache");
            const range = IDBKeyRange.only(cacheName);
            const req = index.openCursor(range);

            req.onsuccess = () => {
                /** @type {IDBCursorWithValue | null} */
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                const rec = cursor.value;
                const k = rec.key || "";

                if (
                    keyPrefix == null ||
                    keyPrefix === "" ||
                    k === keyPrefix ||
                    k.startsWith(`${keyPrefix}/`)
                ) {
                    cursor.delete();
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * @param {string} [cacheName]
     * @returns {Promise<HybridCacheEntry[]>}
     */
    async listEntries(cacheName) {
        const db = await this._db();
        /** @type {HybridCacheEntry[]} */
        const entries = [];

        return new Promise((resolve, reject) => {
            const tx = db.transaction("entries", "readonly");
            const store = tx.objectStore("entries");
            let req;

            if (cacheName) {
                const index = store.index("byCache");
                const range = IDBKeyRange.only(cacheName);
                req = index.openCursor(range);
            } else {
                req = store.openCursor();
            }

            req.onsuccess = () => {
                /** @type {IDBCursorWithValue | null} */
                const cursor = req.result;
                if (!cursor) {
                    resolve(entries);
                    return;
                }
                const rec = cursor.value;
                entries.push({ key: rec.key, meta: rec.meta });
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * @returns {Promise<string[]>}
     */
    async listCaches() {
        const db = await this._db();
        /** @type {Set<string>} */
        const caches = new Set();

        return new Promise((resolve, reject) => {
            const tx = db.transaction("entries", "readonly");
            const store = tx.objectStore("entries");
            const index = store.index("byCache");
            const req = index.openCursor();

            req.onsuccess = () => {
                /** @type {IDBCursorWithValue | null} */
                const cursor = req.result;
                if (!cursor) {
                    resolve(Array.from(caches));
                    return;
                }
                caches.add(cursor.value.cacheName);
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/** @type {Promise<HybridCacheBackend> | null} */
let _backendPromise = null;

/**
 * Resolve and memoize the active backend.
 * Prefers File System Access API; falls back to IndexedDB.
 * @returns {Promise<HybridCacheBackend>}
 */
async function getBackend() {
    if (!HYBRID_CACHE_ENABLED) {
        return new NullBackend();
    }

    if (_backendPromise) return _backendPromise;

    const canFS = typeof navigator !== "undefined" &&
        !!navigator.storage &&
        typeof navigator.storage.getDirectory === "function";

    if (canFS) {
        _backendPromise = Promise.resolve(new FileSystemBackend());
        return _backendPromise;
    }

    if (typeof indexedDB !== "undefined") {
        _backendPromise = Promise.resolve(new IndexedDBBackend());
        return _backendPromise;
    }

    throw new Error(
        "HybridCache: No supported backend (File System Access or IndexedDB) is available.",
    );
}

// ---------------------------------------------------------------------------
// Public HybridCache class
// ---------------------------------------------------------------------------

export class HybridCache {
    /**
     * @param {string} cacheName Name of the logical cache (used like a "folder").
     */
    constructor(cacheName) {
        if (!cacheName) {
            throw new Error("HybridCache: cacheName is required.");
        }
        this.cacheName = cacheName;
    }

    // ---- Instance methods -------------------------------------------------

    /**
     * Get an entry by key.
     * @param {string} key Slash-path key (e.g. "seeds/390293/mesh").
     * @returns {Promise<any | null>}
     */
    async get(key) {
        const backend = await getBackend();
        const res = await backend.readEntry(this.cacheName, key);
        return res ? res.value : null;
    }

    /**
     * Set or overwrite a key.
     * @param {string} key
     * @param {any} value JSON-serializable value.
     * @returns {Promise<HybridCacheEntryMeta>}
     */
    async set(key, value) {
        const backend = await getBackend();
        const res = await backend.writeEntry(this.cacheName, key, value);
        return res.meta;
    }

    /**
     * Ensure a key exists: if present, returns it; otherwise calls producer,
     * stores the result, and returns it.
     *
     * @template T
     * @param {string} key
     * @param {() => Promise<T> | T} producer
     * @returns {Promise<T>}
     */
    async ensure(key, producer) {
        const backend = await getBackend();
        const existing = await backend.readEntry(this.cacheName, key);
        if (existing) return /** @type {T} */ (existing.value);

        const value = await producer();
        await backend.writeEntry(this.cacheName, key, value);
        return value;
    }

    /**
     * Delete a key and all descendants (hierarchical).
     * Example: deleting "seeds/390293/mesh" also deletes
     * "seeds/390293/mesh/texture.dat", etc.
     *
     * @param {string} key
     * @returns {Promise<void>}
     */
    async delete(key) {
        const backend = await getBackend();
        await backend.deleteByPrefix(this.cacheName, key);
    }

    /**
     * Delete the entire cache (all keys).
     * @returns {Promise<void>}
     */
    async deleteAll() {
        const backend = await getBackend();
        await backend.deleteByPrefix(this.cacheName, null);
    }

    /**
     * List entries belonging to this cache.
     * @returns {Promise<HybridCacheEntry[]>}
     */
    async entries() {
        const backend = await getBackend();
        const all = await backend.listEntries(this.cacheName);
        return all;
    }

    /**
     * Aggregate metadata (size, entryCount, etc.) for this cache.
     * @returns {Promise<HybridCacheInfo>}
     */
    async info() {
        const backend = await getBackend();
        const entries = await backend.listEntries(this.cacheName);

        let sizeBytes = 0;
        let entryCount = 0;
        let createdAt = null;
        let modifiedAt = null;

        for (const { meta } of entries) {
            entryCount += 1;
            sizeBytes += meta.sizeBytes || 0;

            if (!createdAt || meta.createdAt < createdAt) {
                createdAt = meta.createdAt;
            }
            if (!modifiedAt || meta.modifiedAt > modifiedAt) {
                modifiedAt = meta.modifiedAt;
            }
        }

        return {
            cacheName: this.cacheName,
            backend: backend.backendType,
            entryCount,
            sizeBytes,
            createdAt,
            modifiedAt,
        };
    }

    // ---- Static helpers (no instance needed) -----------------------------

    /**
     * @param {string | HybridCache} cacheOrName
     * @returns {string}
     * @private
     */
    static _resolveName(cacheOrName) {
        if (typeof cacheOrName === "string") return cacheOrName;
        return cacheOrName.cacheName;
    }

    /**
     * Get value by cacheName + key without constructing an instance.
     * @param {string | HybridCache} cacheOrName
     * @param {string} key
     * @returns {Promise<any | null>}
     */
    static async get(cacheOrName, key) {
        const cacheName = this._resolveName(cacheOrName);
        const backend = await getBackend();
        const res = await backend.readEntry(cacheName, key);
        return res ? res.value : null;
    }

    /**
     * Set value by cacheName + key without constructing an instance.
     * @param {string | HybridCache} cacheOrName
     * @param {string} key
     * @param {any} value
     * @returns {Promise<HybridCacheEntryMeta>}
     */
    static async set(cacheOrName, key, value) {
        const cacheName = this._resolveName(cacheOrName);
        const backend = await getBackend();
        const res = await backend.writeEntry(cacheName, key, value);
        return res.meta;
    }

    /**
     * Ensure entry exists (global).
     * @template T
     * @param {string | HybridCache} cacheOrName
     * @param {string} key
     * @param {() => Promise<T> | T} producer
     * @returns {Promise<T>}
     */
    static async ensure(cacheOrName, key, producer) {
        const cacheName = this._resolveName(cacheOrName);
        const backend = await getBackend();
        const existing = await backend.readEntry(cacheName, key);
        if (existing) return /** @type {T} */ (existing.value);

        const value = await producer();
        await backend.writeEntry(cacheName, key, value);
        return value;
    }

    /**
     * Delete a specific key and its descendants.
     * If key is omitted/null, deletes the entire cache.
     *
     * @param {string | HybridCache} cacheOrName
     * @param {string | null} [key]
     * @returns {Promise<void>}
     */
    static async delete(cacheOrName, key = null) {
        const cacheName = this._resolveName(cacheOrName);
        const backend = await getBackend();
        await backend.deleteByPrefix(cacheName, key);
    }

    /**
     * Delete all caches and all entries.
     * @returns {Promise<void>}
     */
    static async deleteAll() {
        const backend = await getBackend();
        const caches = await backend.listCaches();
        for (const name of caches) {
            await backend.deleteByPrefix(name, null);
        }
    }

    /**
     * List all cache names.
     * @returns {Promise<string[]>}
     */
    static async listCaches() {
        const backend = await getBackend();
        return backend.listCaches();
    }

    /**
     * List entries for a single cache or for all caches.
     * If cacheOrName is omitted, returns entries for all caches.
     *
     * @param {string | HybridCache} [cacheOrName]
     * @returns {Promise<Record<string, HybridCacheEntry[]>>}
     */
    static async contents(cacheOrName) {
        const backend = await getBackend();
        /** @type {Record<string, HybridCacheEntry[]>} */
        const result = {};

        if (cacheOrName) {
            const cacheName = this._resolveName(cacheOrName);
            const entries = await backend.listEntries(cacheName);
            result[cacheName] = entries;
            return result;
        }

        const caches = await backend.listCaches();
        for (const name of caches) {
            result[name] = await backend.listEntries(name);
        }
        return result;
    }

    /**
     * Get backend type ("fs" or "idb").
     * @returns {Promise<string>}
     */
    static async backendType() {
        const backend = await getBackend();
        return backend.backendType;
    }
}

// ---------------------------------------------------------------------------
// Devtools debug helper: window.$FS_CACHE
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
    // Expose a debug API for quick inspection in devtools.
    const debug = {
        /**
         * Inspect contents of a single cache or all caches.
         * @param {string} [cacheName]
         * @returns {Promise<Record<string, HybridCacheEntry[]>>}
         */
        contents(cacheName) {
            return HybridCache.contents(cacheName);
        },

        /**
         * Delete a cache completely, or delete a specific key (and its descendants)
         * if key is provided.
         * @param {string} cacheName
         * @param {string} [key]
         * @returns {Promise<void>}
         */
        delete(cacheName, key) {
            return HybridCache.delete(cacheName, key ?? null);
        },

        /**
         * Delete all caches.
         * @returns {Promise<void>}
         */
        deleteAll() {
            return HybridCache.deleteAll();
        },

        /**
         * List cache names.
         * @returns {Promise<string[]>}
         */
        listCaches() {
            return HybridCache.listCaches();
        },

        /**
         * Return backend type ("fs" or "idb").
         * @returns {Promise<string>}
         */
        backendType() {
            return HybridCache.backendType();
        },
    };

    Object.defineProperty(window, "$FS_CACHE", {
        value: debug,
        writable: false,
        configurable: true,
    });
}
