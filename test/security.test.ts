import test from "node:test";
import assert from "node:assert/strict";
import { isValidBearerAuthorization, validConfiguredToken } from "../src/security.js";

const token = "A".repeat(43);

test("accepts an exact Bearer token and rejects missing, malformed, and wrong tokens", () => {
  assert.equal(validConfiguredToken(token), true);
  assert.equal(isValidBearerAuthorization(`Bearer ${token}`, token), true);
  assert.equal(isValidBearerAuthorization(undefined, token), false);
  assert.equal(isValidBearerAuthorization(token, token), false);
  assert.equal(isValidBearerAuthorization(`Bearer ${token}x`, token), false);
  assert.equal(isValidBearerAuthorization(`Bearer ${"B".repeat(43)}`, token), false);
});

test("rejects weak or malformed configured tokens", () => {
  for (const invalid of [undefined, "", "short", "A".repeat(42), "A".repeat(43) + "="]) {
    assert.equal(validConfiguredToken(invalid), false);
  }
});
