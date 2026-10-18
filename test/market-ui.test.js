import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSymbols } from "../public/js/fn/market-utils.js";

test("market board batches stay within the public 25-symbol API cap", () => {
  const symbols = Array.from({ length: 26 }, (_, i) => `S${i}`);
  assert.deepEqual(chunkSymbols(symbols), [symbols.slice(0, 25), symbols.slice(25)]);
});

test("market board batching keeps an in-cap board in one request", () => {
  const symbols = Array.from({ length: 25 }, (_, i) => `S${i}`);
  assert.deepEqual(chunkSymbols(symbols), [symbols]);
});

test("market board batching returns no requests for an empty board", () => {
  assert.deepEqual(chunkSymbols([]), []);
});
