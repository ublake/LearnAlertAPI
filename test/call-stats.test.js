import test from "node:test";
import assert from "node:assert/strict";
import {
  RANGES,
  resolveFilters,
  bucketSeries,
  totalsFor,
  listFiltered
} from "../src/lib/callStats.js";

/**
 * Records the SQL and bound values of every statement, so a test can assert
 * that a filter actually reached the query rather than only the heading.
 */
function recordingD1(rows = []) {
  const calls = [];

  return {
    calls,
    prepare(sql) {
      let bound = [];

      const statement = {
        bind(...args) {
          bound = args;
          calls.push({ sql, bound });
          return statement;
        },
        async all() {
          return { results: rows };
        },
        async first() {
          return rows[0] || {};
        }
      };

      return statement;
    }
  };
}

test("unknown filter values fall back rather than reaching SQL", () => {
  const params = new URLSearchParams(
    "range=drop-table&endpoint=../../etc&provider=nope"
  );

  assert.deepEqual(resolveFilters(params), {
    range: "1d",
    endpoint: "all",
    provider: "all"
  });

  // Known values are honoured.
  assert.deepEqual(
    resolveFilters(new URLSearchParams("range=7d&endpoint=refine&provider=openai")),
    { range: "7d", endpoint: "refine", provider: "openai" }
  );
});

test("an endpoint filter binds its path, and 'all' binds nothing extra", async () => {
  const db = recordingD1();
  const now = Date.parse("2026-09-19T12:00:00Z");

  await totalsFor(
    { LOGS_DB: db },
    { range: "1d", endpoint: "refine", provider: "openai" },
    now
  );

  const [{ sql, bound }] = db.calls;

  assert.match(sql, /endpoint = \?/);
  assert.match(sql, /provider = \?/);
  assert.deepEqual(bound, [
    now - RANGES["1d"].windowMs,
    "/v1/decks/refine",
    "openai"
  ]);

  const open = recordingD1();
  await totalsFor(
    { LOGS_DB: open },
    { range: "1h", endpoint: "all", provider: "all" },
    now
  );

  assert.doesNotMatch(open.calls[0].sql, /endpoint = \?/);
  assert.deepEqual(open.calls[0].bound, [now - RANGES["1h"].windowMs]);
});

test("empty buckets are filled in so a gap in traffic stays visible", async () => {
  const now = Date.parse("2026-09-19T12:00:00Z");
  const range = RANGES["1d"];
  const width = Math.ceil(range.windowMs / range.buckets);

  // Only two of the twenty-four hourly buckets saw traffic.
  const db = recordingD1([
    { bucket: 0, calls: 3, succeeded: 3, failed: 0, cost: 0.01 },
    { bucket: 23, calls: 1, succeeded: 0, failed: 1, cost: 0 }
  ]);

  const { buckets } = await bucketSeries(
    { LOGS_DB: db },
    { range: "1d", endpoint: "all", provider: "all" },
    now
  );

  assert.equal(buckets.length, 24);
  assert.equal(buckets[0].calls, 3);
  assert.equal(buckets[23].failed, 1);

  // The quiet hours are present as zeroes, not missing.
  assert.equal(buckets[7].calls, 0);
  assert.equal(buckets[7].cost, 0);

  // Buckets are contiguous and ordered.
  assert.equal(buckets[1].startedAt - buckets[0].startedAt, width);
  assert.equal(buckets[23].endedAt, now - range.windowMs + 24 * width);
});

test("every range covers the window it advertises", () => {
  assert.equal(RANGES["1h"].windowMs, 60 * 60 * 1000);
  assert.equal(RANGES["1d"].windowMs, 24 * 60 * 60 * 1000);
  assert.equal(RANGES["7d"].windowMs, 7 * 24 * 60 * 60 * 1000);

  // "all" cannot outrun retention, so it is the same window, honestly labelled.
  assert.equal(RANGES.all.windowMs, RANGES["7d"].windowMs);
});

test("the row limit is capped even when the query string asks for more", async () => {
  const db = recordingD1();
  const now = Date.parse("2026-09-19T12:00:00Z");
  const filters = { range: "all", endpoint: "all", provider: "all" };

  await listFiltered({ LOGS_DB: db }, filters, "99999", now);
  assert.equal(db.calls[0].bound.at(-1), 500);

  const other = recordingD1();
  await listFiltered({ LOGS_DB: other }, filters, "-5", now);
  assert.equal(other.calls[0].bound.at(-1), 100);
});

test("stats degrade to empty without a database rather than throwing", async () => {
  const filters = { range: "1d", endpoint: "all", provider: "all" };

  assert.deepEqual(await listFiltered({}, filters, 10), []);
  assert.equal(await totalsFor({}, filters), null);
  assert.deepEqual((await bucketSeries({}, filters)).buckets, []);
});
