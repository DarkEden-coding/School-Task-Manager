import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("month calendar columns stay equal when assignments have long titles", () => {
  const stylesheet = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(stylesheet, /\.assignment-month\s*\{[^}]*grid-template-columns:\s*repeat\(7,minmax\(0,1fr\)\)/);
  assert.match(stylesheet, /\.day-cell\s*\{[^}]*min-width:\s*0/);
});
