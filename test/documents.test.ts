import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/database.js";
import { DocumentStore } from "../src/documents.js";

test("document sources stay immutable and agent files stay inside the app root", () => {
  const state = mkdtempSync(join(tmpdir(), "school-documents-"));
  const database = new AppDatabase(join(state, "app.sqlite"), state);
  try {
    const store = new DocumentStore(database, state);
    const source = store.addSource("../syllabus.txt", "text/plain", Buffer.from("original"), "upload");
    assert.equal(source.path, "Unsorted/syllabus.txt");
    assert.throws(() => store.editText(source.id, "changed"), /cannot be overwritten/);
    assert.throws(() => store.createFolder("../../outside"), /Invalid folder path/);
    const derived = store.createText("notes.md", "editable", "Classes/Physics", source.id);
    store.editText(derived.id, "updated");
    assert.equal(readFileSync(join(store.root, derived.path), "utf8"), "updated");
    assert.equal(store.moveDocument(source.id, "Classes/Physics").path, "Classes/Physics/syllabus.txt");
    store.deleteDocument(source.id);
    assert.doesNotThrow(() => store.deleteDocument(source.id));
  } finally {
    database.close();
    rmSync(state, { recursive: true, force: true });
  }
});
