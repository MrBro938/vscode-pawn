const assert = require("node:assert/strict");
const { CompletionSourcesCache } = require("../out/server/completionSourceCache.js");

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

cache.clear();
const rebuiltAfterInvalidation = cache.getOrCreate("main.pwn", build("after-change"));
assert.equal(rebuiltAfterInvalidation.cacheHit, false, "source changes must be able to invalidate cached snapshots");
assert.deepEqual(rebuiltAfterInvalidation.value, { value: "after-change" });

console.log("Completion source cache tests passed.");
