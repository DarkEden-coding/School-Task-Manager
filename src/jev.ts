import type { EmailForModel } from "./classify.js";
import type { AppSettings } from "./types.js";

export interface JevScores { school: number; event: number; opportunity: number; }

/** Builds conservative, recipient-aware school, event and opportunity checks. */
function questions(courses: string[], interests: string): Record<keyof JevScores, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> {
  const enrolled = courses.length ? courses.join(", ") : "the recipient's enrolled courses";
  return {
    school: {
      type: "noul",
      instructions: `Does this email introduce or change concrete upcoming coursework, a due date, exam, required class meeting, or class schedule for ${enrolled}? Ignore grades, generic materials, and group-membership notices without new work. Exception: a receipt naming an assignment and explicit due date in an enrolled course might be the only source for that deadline; keep it even when submitted.`,
      criteria: { true: "New or changed coursework or schedule worth extracting.", false: "No new academic work or schedule change." },
    },
    event: {
      type: "noul",
      instructions: `Does this email contain a specific future attendable event or change worth proposing on the recipient's calendar? Count events matching ${interests || "the recipient's interests"}, engineering/robotics/outdoors or career events, meetings for ${enrolled}, and personally invited or booked appointments. Ignore unrelated campus/housing socials, events for courses the recipient does not take, vague promotions, assignment deadlines alone, and sweepstakes offering a chance to win an invitation. If one event in a newsletter genuinely fits, keep the whole email.`,
      criteria: { true: "A relevant, concrete future gathering or appointment.", false: "No relevant future attendable event." },
    },
    opportunity: {
      type: "noul",
      instructions: `Is there a NEW non-calendar follow-up task worth saving for this recipient? Count work for ${enrolled}, personally assigned obligations, or concrete engineering, robotics, outdoors or career applications with a real action or deadline. Attendable events belong in the event question, not here. A mass email using the recipient's first name is not a personal assignment. Ignore general policies, housing newsletters, unrelated classes and sports offers, account verification, grades, order and submission receipts, sweepstakes, and generic promotions unless they also contain a distinct qualifying task.`,
      criteria: { true: "A new, relevant, concrete non-calendar follow-up task.", false: "No such task; only general announcements or unrelated offers." },
    },
  };
};

/** Scores three independent reasons to send an email to the full classifier. */
export async function scoreEmailWithJev(email: EmailForModel, settings: AppSettings, courses: string[], apiKey: string): Promise<JevScores> {
  const response = await fetch("https://openrouter.ai/api/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "typesafe/jev-1.13",
      state: { subject: email.subject, sender: email.sender, messageDate: email.date, interests: settings.interests, filterRules: settings.filterRules, schoolImportRules: settings.schoolImportRules, body: email.body, calendarAttachment: email.calendarText },
      questions: questions(courses, settings.interests),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Jev returned HTTP ${response.status}`);
  const data = await response.json() as { answers?: Record<string, { noul?: unknown }> };
  const scores = Object.fromEntries((["school", "event", "opportunity"] as const).map((key) => [key, data.answers?.[key]?.noul])) as Record<keyof JevScores, unknown>;
  if (Object.values(scores).some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Jev returned invalid scores");
  return scores as JevScores;
}

/** Keeps uncertain messages rather than risking a lost assignment or invitation. */
export function shouldProcessJevScores(scores: JevScores): boolean {
  return Math.max(scores.school, scores.event, scores.opportunity) >= 0.1;
}
