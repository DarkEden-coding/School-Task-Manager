import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import type { AppDatabase } from "./database.js";

export interface StoredDocument { id: number; folderId: number; name: string; path: string; mimeType: string; sourceKind: string; immutable: boolean; derivedFromId: number | null; createdAt: string; updatedAt: string; }
export interface DocumentFolder { id: number; parentId: number | null; name: string; path: string; createdAt: string; updatedAt: string; }

/** Owns document files and keeps their SQLite paths inside the configured document root. */
export class DocumentStore {
  readonly root: string;

  public constructor(private readonly database: AppDatabase, stateDir: string) {
    this.root = resolve(stateDir, "documents");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "Unsorted"), { recursive: true, mode: 0o700 });
    database.db.prepare("INSERT OR IGNORE INTO document_folders(name,path) VALUES('Unsorted','Unsorted')").run();
  }

  /** Returns the complete view-only folder and document tree. */
  public list(): { folders: DocumentFolder[]; documents: StoredDocument[] } {
    const folders = (this.database.db.prepare("SELECT * FROM document_folders ORDER BY path COLLATE NOCASE").all() as Record<string, unknown>[]).map(folderRow);
    const documents = (this.database.db.prepare("SELECT * FROM documents ORDER BY path COLLATE NOCASE").all() as Record<string, unknown>[]).map(documentRow);
    return { folders, documents };
  }

  /** Stores one immutable upload or paste in Unsorted without invoking the agent. */
  public addSource(name: string, mimeType: string, content: Buffer, sourceKind: "paste" | "upload"): StoredDocument {
    if (!content.length) throw new Error("Document content is empty");
    const safeName = uniqueName(join(this.root, "Unsorted"), cleanName(name || (sourceKind === "paste" ? "Pasted text.txt" : "Upload")));
    writeFileSync(join(this.root, "Unsorted", safeName), content, { mode: 0o600, flag: "wx" });
    const folderId = this.folderByPath("Unsorted").id;
    const result = this.database.db.prepare("INSERT INTO documents(folder_id,name,path,mime_type,source_kind,immutable) VALUES(?,?,?,?,?,1)").run(folderId, safeName, `Unsorted/${safeName}`, mimeType, sourceKind);
    return this.requireDocument(Number(result.lastInsertRowid));
  }

  /** Reads a document and returns image bytes or bounded UTF-8 text for a model tool result. */
  public read(id: number): { document: StoredDocument; data: string; image: boolean } {
    const document = this.requireDocument(id);
    const content = readFileSync(this.absolute(document.path));
    if (content.length > 5_000_000) throw new Error("Document is too large to read");
    return { document, data: document.mimeType.startsWith("image/") ? content.toString("base64") : content.toString("utf8").slice(0, 100_000), image: document.mimeType.startsWith("image/") };
  }

  /** Creates an agent-managed folder, including missing parent folders. */
  public createFolder(path: string): DocumentFolder {
    const clean = cleanRelativePath(path);
    let current = "";
    let parentId: number | null = null;
    for (const part of clean.split("/")) {
      current = current ? `${current}/${part}` : part;
      const found = this.maybeFolder(current);
      if (found) { parentId = found.id; continue; }
      mkdirSync(this.absolute(current), { recursive: false, mode: 0o700 });
      const inserted: { lastInsertRowid: number | bigint } = this.database.db.prepare("INSERT INTO document_folders(parent_id,name,path) VALUES(?,?,?)").run(parentId, part, current);
      parentId = Number(inserted.lastInsertRowid);
    }
    return this.folderByPath(clean);
  }

  /** Moves a document to an agent-created folder and resolves filename collisions. */
  public moveDocument(id: number, folderPath: string): StoredDocument {
    const document = this.requireDocument(id), folder = this.createFolder(folderPath);
    const name = uniqueName(this.absolute(folder.path), document.name);
    const nextPath = `${folder.path}/${name}`;
    renameSync(this.absolute(document.path), this.absolute(nextPath));
    this.database.db.prepare("UPDATE documents SET folder_id=?,name=?,path=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(folder.id, name, nextPath, id);
    return this.requireDocument(id);
  }

  /** Creates an editable UTF-8 document, optionally derived from an immutable source. */
  public createText(name: string, content: string, folderPath: string, derivedFromId?: number): StoredDocument {
    const folder = this.createFolder(folderPath), safeName = uniqueName(this.absolute(folder.path), cleanName(name.endsWith(".txt") || name.endsWith(".md") ? name : `${name}.md`));
    const path = `${folder.path}/${safeName}`;
    writeFileSync(this.absolute(path), content.slice(0, 500_000), { mode: 0o600, flag: "wx" });
    if (derivedFromId) this.requireDocument(derivedFromId);
    const result = this.database.db.prepare("INSERT INTO documents(folder_id,name,path,mime_type,source_kind,immutable,derived_from_id) VALUES(?,?,?,?,?,0,?)")
      .run(folder.id, safeName, path, safeName.endsWith(".md") ? "text/markdown" : "text/plain", "agent", derivedFromId ?? null);
    return this.requireDocument(Number(result.lastInsertRowid));
  }

  /** Replaces an editable text document while protecting immutable sources and binary files. */
  public editText(id: number, content: string): StoredDocument {
    const document = this.requireDocument(id);
    if (document.immutable) throw new Error("Original source documents cannot be overwritten; create a derived document instead");
    if (!document.mimeType.startsWith("text/")) throw new Error("Only text documents can be edited");
    writeFileSync(this.absolute(document.path), content.slice(0, 500_000), { mode: 0o600 });
    this.database.db.prepare("UPDATE documents SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    return this.requireDocument(id);
  }

  /** Permanently deletes a document after the caller obtains confirmation. */
  public deleteDocument(id: number): void {
    const document = this.requireDocument(id);
    rmSync(this.absolute(document.path));
    this.database.db.prepare("DELETE FROM documents WHERE id=?").run(id);
  }

  private absolute(path: string): string {
    const target = resolve(this.root, path);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) throw new Error("Document path escapes the app data directory");
    return target;
  }
  private maybeFolder(path: string): DocumentFolder | undefined { const row = this.database.db.prepare("SELECT * FROM document_folders WHERE path=?").get(path) as Record<string, unknown> | undefined; return row ? folderRow(row) : undefined; }
  private folderByPath(path: string): DocumentFolder { const folder = this.maybeFolder(path); if (!folder) throw new Error("Folder not found"); return folder; }
  private requireDocument(id: number): StoredDocument { const row = this.database.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as Record<string, unknown> | undefined; if (!row) throw new Error("Document not found"); return documentRow(row); }
}

/** Sanitizes a single uploaded filename without preserving client paths. */
function cleanName(name: string): string { const value = basename(name).normalize("NFKC").replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").trim(); return value.slice(0, 180) || "Document"; }
/** Validates an agent folder path and rejects traversal and reserved Unsorted descendants. */
function cleanRelativePath(path: string): string {
  const value = path.normalize("NFKC").replace(/\\/g, "/").split("/").map(cleanName).filter(Boolean).join("/");
  if (!value || value === "." || value.includes("..") || value.startsWith("Unsorted/")) throw new Error("Invalid folder path");
  return value;
}
function uniqueName(directory: string, requested: string): string { let name = requested, index = 2; const extension = extname(requested), stem = requested.slice(0, requested.length - extension.length); while (existsSync(join(directory, name))) name = `${stem} ${index++}${extension}`; return name; }
function folderRow(row: Record<string, unknown>): DocumentFolder { return { id: Number(row.id), parentId: row.parent_id === null ? null : Number(row.parent_id), name: String(row.name), path: String(row.path), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function documentRow(row: Record<string, unknown>): StoredDocument { return { id: Number(row.id), folderId: Number(row.folder_id), name: String(row.name), path: String(row.path), mimeType: String(row.mime_type), sourceKind: String(row.source_kind), immutable: Boolean(row.immutable), derivedFromId: row.derived_from_id === null ? null : Number(row.derived_from_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
