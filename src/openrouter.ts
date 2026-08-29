import { getSupportedThinkingLevels, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import type { AppDatabase } from "./database.js";
import { buildClassifyPrompt, CLASSIFY_SYSTEM_PROMPT, CLASSIFY_TOOL, classifiedEventsFromToolCall, type ApprovedEventRef, type ClassifiedEvent, type EmailForModel } from "./classify.js";
import type { AvailableModel, ModelProviderId, ReasoningLevel } from "./types.js";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const SYNC_TIMEOUT_MS = 45_000;
const BATCH_TIMEOUT_MS = 24 * 60 * 60_000;
const PROVIDER_ID = "openrouter";

interface OpenRouterChatBody {
  messages: Array<{ role: "system" | "user"; content: string }>;
  tools: unknown[];
  tool_choice: { type: "function"; function: { name: string } };
  reasoning?: { effort: string };
}

interface OpenRouterChatCompletion {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  error?: { message?: string };
}

interface OpenRouterBatch {
  id?: string;
  status?: string;
  error?: { message?: string } | string | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
  results?: Array<{
    custom_id?: string;
    response?: { status_code?: number; body?: OpenRouterChatCompletion };
    error?: { message?: string } | string | null;
  }>;
}

export interface BatchProgress {
  batchId: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
}

export interface ClassifyEmailResult {
  emailId: string;
  events: ClassifiedEvent[];
  error?: string;
}

/** True when the selected OpenRouter slug is a batch-priced variant. */
export function isOpenRouterBatchModel(modelId: string): boolean {
  return modelId.endsWith(":batch");
}

/** True when classification should use one OpenRouter Batch API submission. */
export function isOpenRouterBatchSettings(settings: { modelProvider: ModelProviderId; modelId: string }): boolean {
  return settings.modelProvider === "openrouter" && isOpenRouterBatchModel(settings.modelId);
}

/** Returns the slug the Batch API expects, without the `:batch` suffix. */
export function openRouterInferenceModelId(modelId: string): string {
  return isOpenRouterBatchModel(modelId) ? modelId.slice(0, -":batch".length) : modelId;
}

/** OpenRouter API-key auth and email classification, including Batch API routing. */
export class OpenRouterService {
  public constructor(private readonly database: AppDatabase) {}

  /** Reports whether an OpenRouter API key is stored. Does not touch Codex credentials. */
  public async isConnected(): Promise<boolean> {
    const credential = await this.database.read(PROVIDER_ID);
    if (credential?.type !== "api_key" || !credential.key) return false;
    return isOpenRouterApiKey(normalizeOpenRouterKey(credential.key));
  }

  /**
   * Stores an OpenRouter API key under its own provider id so Codex OAuth stays intact.
   */
  public async login(apiKey: string): Promise<void> {
    const key = normalizeOpenRouterKey(apiKey);
    if (!key) throw new Error("OpenRouter API key is required");
    if (key.length > 500) throw new Error("OpenRouter API key is too long");
    if (!isOpenRouterApiKey(key)) throw new Error("Enter a valid OpenRouter API key beginning with sk-or-");
    await this.database.modify(PROVIDER_ID, async () => ({ type: "api_key", key }));
  }

  /** Lists catalog models, optionally filtered by id or display name. */
  public listModels(query = ""): AvailableModel[] {
    const needle = query.trim().toLowerCase();
    return Object.values(OPENROUTER_MODELS)
      .filter((model) => !needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle))
      .map((model) => ({
        id: model.id,
        name: model.name,
        reasoningLevels: getSupportedThinkingLevels(model) as ReasoningLevel[],
        batch: isOpenRouterBatchModel(model.id),
      }));
  }

  /** Extracts event candidates, using the Batch API whenever a `:batch` model is selected. */
  public async classifyEmail(email: EmailForModel): Promise<ClassifiedEvent[]> {
    if (isOpenRouterBatchSettings(this.database.getSettings())) {
      const [result] = await this.classifyEmails([email]);
      if (!result) return [];
      if (result.error) throw new Error(result.error);
      return result.events;
    }
    const prepared = this.prepareRequest(email);
    const completion = await this.completeSync(await this.apiKey(), prepared.modelId, prepared.body);
    return classifiedEventsFromToolCall(toolCallFromCompletion(completion), this.database.getSettings().timezone, prepared.approved);
  }

  /** Classifies every email in one OpenRouter Batch API submission. */
  public async classifyEmails(emails: EmailForModel[], onProgress?: (progress: BatchProgress) => void): Promise<ClassifyEmailResult[]> {
    if (!emails.length) return [];
    const settings = this.database.getSettings();
    const catalogModel = Object.values(OPENROUTER_MODELS).find((item) => item.id === settings.modelId);
    if (!catalogModel) throw new Error("Choose an OpenRouter model");
    const apiKey = await this.apiKey();
    const approved: ApprovedEventRef[] = this.database.listCandidates("history")
      .filter((item) => item.status === "approved" && (!item.end || Date.parse(item.end) > Date.now()))
      .slice(0, 100)
      .map((item) => ({ id: item.id, title: item.title, start: item.start, location: item.location }));
    const reasoning = reasoningEffort(catalogModel.reasoning, settings.reasoningLevel, catalogModel.thinkingLevelMap);
    const prepared = emails.map((email) => ({ email, body: this.chatBody(buildClassifyPrompt(email, settings.timezone, settings.interests, settings.filterRules, approved), reasoning) }));
    const model = openRouterInferenceModelId(catalogModel.id);
    const requests = prepared.map((item) => ({ custom_id: item.email.id, body: item.body }));
    const created = await this.request<OpenRouterBatch>(apiKey, "/api/beta/batches", {
      method: "POST",
      body: `{"endpoint":"/v1/chat/completions","model":${JSON.stringify(model)},"requests":${JSON.stringify(requests)}}`,
    });
    if (!created.id) throw new Error(batchErrorMessage(created.error) || "OpenRouter batch was not created");
    onProgress?.({ batchId: created.id, status: created.status ?? "validating", total: emails.length, completed: 0, failed: 0 });
    const finished = await this.pollBatch(apiKey, created.id, emails.length, onProgress);
    const byId = new Map((finished.results ?? []).map((result) => [result.custom_id, result]));
    const timezone = this.database.getSettings().timezone;
    return prepared.map((item) => {
      const result = byId.get(item.email.id);
      if (!result) return { emailId: item.email.id, events: [], error: "OpenRouter batch result was missing" };
      if (result.error) return { emailId: item.email.id, events: [], error: batchErrorMessage(result.error) };
      const status = result.response?.status_code ?? 0;
      if (status >= 400) return { emailId: item.email.id, events: [], error: `OpenRouter batch request failed (${status})` };
      const completion = result.response?.body ?? {};
      if (completion.error?.message) return { emailId: item.email.id, events: [], error: completion.error.message };
      try {
        return { emailId: item.email.id, events: classifiedEventsFromToolCall(toolCallFromCompletion(completion), timezone, approved) };
      } catch (error) {
        return { emailId: item.email.id, events: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /** Builds one chat-completions body from current settings and approved events. */
  private prepareRequest(email: EmailForModel): { modelId: string; body: OpenRouterChatBody; approved: ApprovedEventRef[] } {
    const settings = this.database.getSettings();
    const model = Object.values(OPENROUTER_MODELS).find((item) => item.id === settings.modelId);
    if (!model) throw new Error("Choose an OpenRouter model");
    const approved: ApprovedEventRef[] = this.database.listCandidates("history")
      .filter((item) => item.status === "approved" && (!item.end || Date.parse(item.end) > Date.now()))
      .slice(0, 100)
      .map((item) => ({ id: item.id, title: item.title, start: item.start, location: item.location }));
    const body = this.chatBody(buildClassifyPrompt(email, settings.timezone, settings.interests, settings.filterRules, approved), reasoningEffort(model.reasoning, settings.reasoningLevel, model.thinkingLevelMap));
    return { modelId: model.id, body, approved };
  }

  /** Builds the shared chat-completions payload. */
  private chatBody(prompt: string, reasoning: { effort: string } | undefined): OpenRouterChatBody {
    const body: OpenRouterChatBody = {
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      tools: [{
        type: "function",
        function: {
          name: CLASSIFY_TOOL.name,
          description: CLASSIFY_TOOL.description,
          parameters: JSON.parse(JSON.stringify(CLASSIFY_TOOL.parameters)) as unknown,
          strict: true,
        },
      }],
      tool_choice: { type: "function", function: { name: CLASSIFY_TOOL.name } },
    };
    if (reasoning) body.reasoning = reasoning;
    return body;
  }

  /** Completes one request through the synchronous Chat Completions API. */
  private async completeSync(apiKey: string, modelId: string, body: OpenRouterChatBody): Promise<OpenRouterChatCompletion> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
      return await this.request<OpenRouterChatCompletion>(apiKey, "/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: modelId, ...body }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("OpenRouter request timed out after 45s");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Polls a batch until it reaches a terminal status or times out. */
  private async pollBatch(apiKey: string, batchId: string, total: number, onProgress?: (progress: BatchProgress) => void): Promise<OpenRouterBatch> {
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let delay = 5_000;
    while (Date.now() < deadline) {
      let batch: OpenRouterBatch;
      try {
        batch = await this.request<OpenRouterBatch>(apiKey, `/api/beta/batches/${encodeURIComponent(batchId)}`);
      } catch (error) {
        if (!(error instanceof OpenRouterRequestError) || error.status !== 404) throw error;
        await sleep(delay);
        delay = Math.min(15_000, Math.round(delay * 1.4));
        continue;
      }
      const status = batch.status ?? "";
      onProgress?.({
        batchId,
        status,
        total: batch.request_counts?.total ?? total,
        completed: batch.request_counts?.completed ?? 0,
        failed: batch.request_counts?.failed ?? 0,
      });
      if (status === "completed") return batch;
      if (status === "failed" || status === "expired" || status === "cancelled") {
        throw new Error(batchErrorMessage(batch.error) || `OpenRouter batch ${status}`);
      }
      await sleep(delay);
      delay = Math.min(15_000, Math.round(delay * 1.4));
    }
    throw new Error("OpenRouter batch timed out after 24 hours");
  }

  /** Reads the stored OpenRouter key without inspecting other provider credentials. */
  private async apiKey(): Promise<string> {
    const credential = await this.database.read(PROVIDER_ID);
    if (credential?.type !== "api_key" || !credential.key) throw new Error("OpenRouter is not connected");
    const apiKey = normalizeOpenRouterKey(credential.key);
    if (!isOpenRouterApiKey(apiKey)) throw new Error("The saved OpenRouter credential is invalid. Reconnect with an API key beginning with sk-or-");
    return apiKey;
  }

  /** Sends one authenticated JSON request to OpenRouter. */
  private async request<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("HTTP-Referer", "http://127.0.0.1");
      headers.set("X-OpenRouter-Title", "Signal Mail");
      if (init.body) headers.set("Content-Type", "application/json");
      response = await fetch(`${OPENROUTER_ORIGIN}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("OpenRouter")) throw error;
      throw new Error("OpenRouter network request failed");
    }
    let payload: unknown = {};
    try { payload = await response.json(); } catch { /* Non-JSON error bodies still use the status text. */ }
    const message = openRouterErrorMessage(payload);
    if (!response.ok) throw new OpenRouterRequestError(message || `OpenRouter request failed (${response.status})`, response.status);
    if (payload && typeof payload === "object" && batchErrorMessage((payload as { error?: { message?: string } | string | null }).error)) {
      throw new Error(message);
    }
    return payload as T;
  }
}

/** HTTP failure that preserves status for retry decisions. */
class OpenRouterRequestError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

/** Maps the saved reasoning level onto OpenRouter's nested effort object. */
function reasoningEffort(supportsReasoning: boolean, level: ReasoningLevel, map: ThinkingLevelMap | undefined): { effort: string } | undefined {
  if (!supportsReasoning) return undefined;
  if (level === "off") {
    const off = map?.off;
    return off === null ? undefined : { effort: off ?? "none" };
  }
  const mapped = map?.[level];
  return mapped === null ? undefined : { effort: mapped ?? level };
}

/** Converts an OpenRouter chat completion into the shared tool-call shape. */
function toolCallFromCompletion(completion: OpenRouterChatCompletion) {
  const call = completion.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.name) return undefined;
  let parsed: unknown = {};
  try { parsed = JSON.parse(call.function.arguments || "{}") as unknown; } catch { throw new Error("OpenRouter returned invalid tool arguments"); }
  if (!parsed || typeof parsed !== "object") throw new Error("OpenRouter returned invalid tool arguments");
  return { type: "toolCall" as const, id: call.id || "openrouter-tool", name: call.function.name, arguments: parsed as Record<string, unknown> };
}

/** Flattens OpenRouter batch error payloads. */
function batchErrorMessage(error: { message?: string; metadata?: { raw?: string } } | string | null | undefined): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message || error.metadata?.raw || "";
}

/** Reads a human-readable OpenRouter error from a JSON body. */
function openRouterErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as { error?: { message?: string; metadata?: { raw?: string } } | string | null; message?: string };
  return batchErrorMessage(record.error) || (typeof record.message === "string" ? record.message : "");
}

/** Strips copy/paste noise from a stored OpenRouter API key. */
function normalizeOpenRouterKey(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "").trim();
}

/** Checks the stable prefix and rejects whitespace that cannot occur in an API key. */
function isOpenRouterApiKey(value: string): boolean {
  return value.startsWith("sk-or-") && value.length >= 20 && !/\s/.test(value);
}

/** Waits for the next batch poll. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
