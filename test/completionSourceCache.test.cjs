const assert = require("node:assert/strict");
const {
  CompletionSourcesCache,
  refreshReadyCompletionSources
} = require("../out/server/completionSourceCache.js");

const cache = new CompletionSourcesCache(2);
let builds = 0;
const build = (value) => () => {
  builds++;
  return { value };
};

const first = cache.getOrCreate("main.pwn", build("initial"));
assert.equal(first.cacheHit, false);
assert.deepEqual(first.value, { value: "initial" });

const repeated = cache.getOrCreate("main.pwn", build("stale"));
assert.equal(repeated.cacheHit, true);
assert.equal(repeated.value, first.value, "cached prepared sources should be reused");
assert.equal(builds, 1, "cache hits must not rebuild prepared sources");

cache.getOrCreate("other.pwn", build("other"));
cache.getOrCreate("third.pwn", build("third"));
const rebuiltAfterEviction = cache.getOrCreate("main.pwn", build("after-eviction"));
assert.equal(rebuiltAfterEviction.cacheHit, false, "least recently used entries should be evicted");
assert.deepEqual(rebuiltAfterEviction.value, { value: "after-eviction" });

const iteratedValues = [];
cache.forEachValue((value) => iteratedValues.push(value.value));
assert.ok(iteratedValues.includes("other") || iteratedValues.includes("third"),
  "cache iteration should expose current LRU values for dependency invalidation");

const staleUris = new Set(["main.pwn", "dependency.inc"]);
const refreshedUris = [];
const deferredCount = refreshReadyCompletionSources(
  staleUris,
  (uri) => uri === "dependency.inc",
  (uri) => refreshedUris.push(uri)
);
assert.equal(deferredCount, 1, "pending documents should be deferred");
assert.deepEqual(refreshedUris, ["dependency.inc"], "ready sources should refresh immediately");
assert.deepEqual([...staleUris], ["main.pwn"], "deferred sources should remain stale for the next request");

const completedRefreshCount = refreshReadyCompletionSources(
  staleUris,
  () => true,
  (uri) => refreshedUris.push(uri)
);
assert.equal(completedRefreshCount, 0);
assert.deepEqual([...staleUris], [], "a completed background parse should clear the stale entry");
assert.deepEqual(refreshedUris, ["dependency.inc", "main.pwn"]);

cache.clear();
const rebuiltAfterInvalidation = cache.getOrCreate("main.pwn", build("after-change"));
assert.equal(rebuiltAfterInvalidation.cacheHit, false, "source changes must be able to invalidate cached snapshots");
assert.deepEqual(rebuiltAfterInvalidation.value, { value: "after-change" });

console.log("Completion source cache tests passed.");
