import test from "node:test";
import assert from "node:assert/strict";
import { wrapCategoryIndex } from "../src/catalog-state.js";

test("NEXT wraps from the last category to the first", () => {
  assert.equal(wrapCategoryIndex(1, "next", 2), 0);
  assert.equal(wrapCategoryIndex(4, "next", 2), 1);
});

test("PREV wraps from the first category to the last", () => {
  assert.equal(wrapCategoryIndex(0, "prev", 2), 1);
  assert.equal(wrapCategoryIndex(0, -1, 3), 2);
});

test("single-category navigation stays on the only category", () => {
  assert.equal(wrapCategoryIndex(0, "next", 1), 0);
  assert.equal(wrapCategoryIndex(0, "prev", 1), 0);
});

test("invalid or empty category counts do not produce a usable index", () => {
  assert.equal(wrapCategoryIndex(0, "next", 0), -1);
  assert.equal(wrapCategoryIndex(0, "next", -2), -1);
  assert.equal(wrapCategoryIndex(0, "next", Number.NaN), -1);
});

test("invalid current indexes safely start at the first category before navigation", () => {
  assert.equal(wrapCategoryIndex(Number.NaN, "next", 2), 1);
  assert.equal(wrapCategoryIndex(undefined, "prev", 2), 1);
});
