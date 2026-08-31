import type { AppDatabase } from "./database.js";
import type { ExtractedSchoolItem, SchoolClass, SchoolImportItem, SchoolTerm } from "./types.js";

const REFERENCE_FIELDS = new Set(["termName", "className", "classCode"]);

/** Normalizes human-entered identity and formatting for conservative matching. */
export function normalizeSchoolValue(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase() : String(value ?? "");
}

/** Finds a term from a trusted numeric id or an extracted name. */
export function resolveImportedTerm(database: AppDatabase, payload: Record<string, unknown>): SchoolTerm | undefined {
  const id = Number(payload.termId);
  if (Number.isInteger(id) && id > 0) return database.getTerm(id);
  const name = normalizeSchoolValue(payload.termName);
  return name ? database.listTerms().find((term) => normalizeSchoolValue(term.name) === name) : undefined;
}

/** Finds a class from a trusted numeric id or extracted class and term identity. */
export function resolveImportedClass(database: AppDatabase, payload: Record<string, unknown>): SchoolClass | undefined {
  const id = Number(payload.classId);
  if (Number.isInteger(id) && id > 0) return database.getClass(id);
  const name = normalizeSchoolValue(payload.className);
  const code = normalizeSchoolValue(payload.classCode);
  const term = resolveImportedTerm(database, payload);
  const hasTermReference = (Number.isInteger(Number(payload.termId)) && Number(payload.termId) > 0) || Boolean(normalizeSchoolValue(payload.termName));
  if (hasTermReference && !term) return undefined;
  const matches = database.listClasses().filter((schoolClass) => (!term || schoolClass.termId === term.id)
    && ((code && normalizeSchoolValue(schoolClass.code) === code) || (name && normalizeSchoolValue(schoolClass.name) === name)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Matches extracted records and marks every consequential or ambiguous change for review. */
export function matchSchoolItems(database: AppDatabase, extracted: ExtractedSchoolItem[]): Omit<SchoolImportItem, "id">[] {
  const terms = database.listTerms(), classes = database.listClasses(), assignments = database.listAssignments();
  return extracted.map((source) => {
    const payload = { ...source.payload };
    const term = source.kind === "class" ? resolveImportedTerm(database, payload) : undefined;
    const schoolClass = source.kind === "assignment" ? resolveImportedClass(database, payload) : undefined;
    let target: ({ id: number } & Record<string, unknown>) | undefined;
    if (source.kind === "term") target = terms.find((item) => normalizeSchoolValue(item.name) === normalizeSchoolValue(payload.name)) as never;
    if (source.kind === "class") {
      const hasTermReference = (Number.isInteger(Number(payload.termId)) && Number(payload.termId) > 0) || Boolean(normalizeSchoolValue(payload.termName));
      if (!hasTermReference || term) target = classes.find((item) => (!term || item.termId === term.id)
        && ((payload.code && normalizeSchoolValue(item.code) === normalizeSchoolValue(payload.code)) || normalizeSchoolValue(item.name) === normalizeSchoolValue(payload.name))) as never;
    }
    if (source.kind === "assignment" && schoolClass) target = assignments.find((item) => item.classId === schoolClass.id && normalizeSchoolValue(item.title) === normalizeSchoolValue(payload.title)) as never;
    if (term) payload.termId = term.id;
    if (schoolClass) payload.classId = schoolClass.id;
    if (source.operation === "delete") return { kind: source.kind, action: "delete", targetId: target?.id ?? null, needsReview: true, payload, conflicts: target ? ["deletion"] : ["delete target not found"] };
    if (!target) return { kind: source.kind, action: "create", targetId: null, needsReview: false, payload, conflicts: [] };
    const changed: string[] = [], conflicts: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
      if (REFERENCE_FIELDS.has(key) || key === "status" || key === "completedAt" || key === "id" || value === undefined) continue;
      const old = target[key];
      if (sameValue(key, old, value)) continue;
      changed.push(key);
      if (old !== "" && old !== null && old !== undefined) conflicts.push(key);
      if (key === "due" || key === "termId" || key === "classId" || key === "name" || key === "code") conflicts.push(key);
    }
    return { kind: source.kind, action: changed.length ? "update" : "noop", targetId: target.id, needsReview: conflicts.length > 0, payload, conflicts: [...new Set(conflicts)] };
  });
}

/** Treats equivalent timestamps and harmless formatting changes as equal. */
function sameValue(key: string, left: unknown, right: unknown): boolean {
  if ((key === "due" || key === "start" || key === "end") && left && right) {
    const leftTime = Date.parse(String(left)), rightTime = Date.parse(String(right));
    if (!Number.isNaN(leftTime) && leftTime === rightTime) return true;
  }
  return normalizeSchoolValue(left) === normalizeSchoolValue(right);
}
