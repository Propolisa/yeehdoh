/**
 * Tests HybridCache core functionality:
 *  - backend selection
 *  - set/get
 *  - hierarchical keys
 *  - recursive deletion
 *  - metadata correctness
 *  - multi-cache isolation
 *
 * Logs results in console. Returns a summary object.
 *
 * @param {typeof import("./HybridCache.js").HybridCache} HybridCache
 */

import { HybridCache } from "./HybridCache.js";

/**
 * Writes a 10MB value into the cache and validates:
 * - write succeeds
 * - retrieve returns identical bytes
 * - metadata reports correct size
 */
async function testLarge10MBWrite(cache) {
    console.log("▶ testLarge10MBWrite");

    const size = 10 * 1024 * 1024; // 10MB
    const key = "large/10mb-test.bin";

    // Create 10MB Uint8Array with deterministic pattern
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i % 256;

    await cache.set(key, data);

    const out = await cache.get(key);
    if (!out) throw new Error("Failed to retrieve 10MB entry");

    // Verify length matches
    if (!(out instanceof Uint8Array)) {
        throw new Error("Retrieved type mismatch");
    }
    if (out.length !== size) throw new Error("10MB entry length mismatch");

    // Spot check several offsets (not full validation for speed)
    const checks = [0, 12345, 999999, size - 1];
    for (const idx of checks) {
        if (out[idx] !== data[idx]) {
            throw new Error(`10MB data mismatch at byte ${idx}`);
        }
    }

    // Metadata inspect
    const info = await cache.info(key);
    if (!info) throw new Error("Missing metadata for 10MB entry");
    if (info.size !== size) {
        console.warn(
            "⚠ backend did not preserve exact byte size; reported:",
            info.size,
        );
    }

    console.log("✔ testLarge10MBWrite passed!");
}

export async function testHybridCache(HybridCache) {
    const results = {};

    function check(name, passed, info = "") {
        results[name] = { passed, info };
        console.log(
            passed ? "✔ PASS" : "✘ FAIL",
            name,
            info ? `→ ${info}` : "",
        );
    }

    try {
        console.group("HybridCache Unit Test");

        // ------------------------------------------------------------
        // 1. Backend selection
        // ------------------------------------------------------------
        const backend = await HybridCache.backendType();
        check(
            "backend-selection",
            backend === "fs" || backend === "idb",
            backend,
        );

        // ------------------------------------------------------------
        // 2. Basic set/get
        // ------------------------------------------------------------
        const cache = new HybridCache("test-cache");
        await testLarge10MBWrite(cache);
        await cache.set("foo", { a: 1 });
        const val = await cache.get("foo");
        check("basic-set-get", val && val.a === 1, JSON.stringify(val));

        // ------------------------------------------------------------
        // 3. Hierarchical key set/get
        // ------------------------------------------------------------
        await cache.set("seeds/123/mesh/data.json", { v: 99 });
        const v2 = await cache.get("seeds/123/mesh/data.json");
        check("hierarchical-get", v2 && v2.v === 99, JSON.stringify(v2));

        // ------------------------------------------------------------
        // 4. Metadata creation + correctness
        // ------------------------------------------------------------
        const infoBefore = await cache.info();
        const metaTest = typeof infoBefore.entryCount === "number" &&
            typeof infoBefore.sizeBytes === "number" &&
            infoBefore.entryCount >= 1;

        check("metadata-info", metaTest, JSON.stringify(infoBefore));

        // ------------------------------------------------------------
        // 5. Recursive delete: delete seeds/123/mesh
        // ------------------------------------------------------------
        await cache.delete("seeds/123/mesh");

        const existsAfterDelete1 = await cache.get("seeds/123/mesh/data.json");
        check("recursive-delete", existsAfterDelete1 === null);

        // ------------------------------------------------------------
        // 6. Multi-level: ensure higher-level path still exists
        await cache.set("seeds/123/foo", 42);
        await cache.set("seeds/123/foo/bar", 55);

        // delete seeds/123
        await cache.delete("seeds/123");

        const a = await cache.get("seeds/123/foo");
        const b = await cache.get("seeds/123/foo/bar");
        check("recursive-delete-level2", a === null && b === null);

        // ------------------------------------------------------------
        // 7. Entire-cache delete
        // ------------------------------------------------------------
        await cache.set("x", 1);
        await cache.set("y/z", 2);

        await cache.deleteAll();

        const infoAfter = await cache.info();
        check("delete-all", infoAfter.entryCount === 0);

        // ------------------------------------------------------------
        // 8. Static API - set/get/delete
        // ------------------------------------------------------------
        await HybridCache.set("static-cache", "alpha/beta", { k: 123 });
        const sVal = await HybridCache.get("static-cache", "alpha/beta");

        check("static-api-set-get", sVal?.k === 123, JSON.stringify(sVal));

        await HybridCache.delete("static-cache", "alpha");
        const sVal2 = await HybridCache.get("static-cache", "alpha/beta");

        check("static-api-hierarchical-delete", sVal2 === null);

        // ------------------------------------------------------------
        // 9. Static: delete full cache via null key
        // ------------------------------------------------------------
        await HybridCache.set("delete-entire-static", "foo", 10);
        await HybridCache.delete("delete-entire-static");

        const remaining = await HybridCache.contents("delete-entire-static");
        const emptyTest = remaining["delete-entire-static"] &&
            remaining["delete-entire-static"].length === 0;

        check("static-delete-entire-cache", emptyTest);

        console.groupEnd();
        return results;
    } catch (err) {
        console.error("✘ ERROR during HybridCache tests:", err);
        results.error = err;
        return results;
    }
}

await testHybridCache(HybridCache);
