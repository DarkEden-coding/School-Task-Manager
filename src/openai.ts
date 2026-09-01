import { createModels, getSupportedThinkingLevels, type AssistantMessage, type AuthEvent, type AuthPrompt, type Message, type Tool } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { buildClassifyPrompt, CLASSIFY_SYSTEM_PROMPT, CLASSIFY_TOOL, classifiedEmailFromToolCall, SCHOOL_IMPORT_SYSTEM_PROMPT, SCHOOL_IMPORT_TOOL, schoolItemsFromToolCall, type ClassifiedEmail, type ClassifiedEvent, type EmailForModel } from "./classify.js";
import type { AppDatabase } from "./database.js";
import { OpenRouterService } from "./openrouter.js";
import type { AvailableModel, ReasoningLevel } from "./types.js";

export type { ClassifiedEvent, EmailForModel };

/** ChatGPT subscription authentication and provider-routed event extraction. */
export class OpenAIService {
  readonly models;
  readonly openrouter: OpenRouterService;
  #loginEvents: AuthEvent[] = [];
  #loginState: "idle" | "running" | "connected" | "failed" = "idle";
  #loginError: string | null = null;

  public constructor(private readonly database: AppDatabase) {
    this.models = createModels({ credentials: database });
    this.models.setProvider(openaiCodexProvider());
    this.openrouter = new OpenRouterService(database);
  }

  /** Reports whether a usable Codex subscription credential is stored. */
  public async isConnected(): Promise<boolean> {
    try { return Boolean(await this.models.checkAuth("openai-codex")); } catch { return false; }
  }

  /** Reports whether an OpenRouter API key is stored. */
  public async isOpenRouterConnected(): Promise<boolean> {
    return this.openrouter.isConnected();
  }

  /** Lists Codex models and compatible reasoning levels available to the account. */
  public async listModels(): Promise<AvailableModel[]> {
    const available = await this.models.getAvailable("openai-codex");
    return available.map((model) => ({ id: model.id, name: model.name, reasoningLevels: getSupportedThinkingLevels(model) as ReasoningLevel[], batch: false }));
  }

  /** Starts OAuth without holding the HTTP request open for user interaction. */
  public async startLogin(method: "browser" | "device_code"): Promise<{ state: string; events: AuthEvent[]; error: string | null }> {
    if (this.#loginState === "running") return this.loginStatus();
    this.#loginEvents = [];
    this.#loginError = null;
    this.#loginState = "running";
    let resolveFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => { resolveFirstEvent = resolve; });
    const notify = (event: AuthEvent): void => { this.#loginEvents.push(event); resolveFirstEvent(); };
    void this.login(method, notify).then(() => { this.#loginState = "connected"; }).catch((error: unknown) => {
      this.#loginState = "failed";
      this.#loginError = error instanceof Error ? error.message : String(error);
    });
    await Promise.race([firstEvent, new Promise((resolve) => setTimeout(resolve, 1500))]);
    return this.loginStatus();
  }

  /** Runs OAuth and retries the known pi-ai lazy Node-module initialization race once. */
  private async login(method: "browser" | "device_code", notify: (event: AuthEvent) => void): Promise<void> {
    const interaction = { prompt: (prompt: AuthPrompt) => answerAuthPrompt(prompt, method), notify };
    try {
      await this.models.login("openai-codex", "oauth", interaction);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("only available in Node.js environments")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await this.models.login("openai-codex", "oauth", interaction);
    }
  }

  /** Returns current OpenAI login progress without exposing tokens. */
  public loginStatus(): { state: string; events: AuthEvent[]; error: string | null } {
    return { state: this.#loginState, events: this.#loginEvents, error: this.#loginError };
  }

  /** Completes one vision-capable interactive agent turn with caller-supplied tools. */
  public async completeAgent(messages: Message[], tools: Tool[], systemPrompt: string, sessionId: string): Promise<AssistantMessage> {
    const settings = this.database.getSettings();
    if (settings.modelProvider === "openrouter") return this.openrouter.completeAgent(messages, tools, systemPrompt, sessionId);
    const model = this.models.getModel("openai-codex", settings.modelId) ?? (await this.models.getAvailable("openai-codex")).find((item) => item.input.includes("image"));
    if (!model || !model.input.includes("image")) throw new Error("Choose a vision-capable OpenAI Codex model in Settings");
    const response = await this.models.completeSimple(model, { systemPrompt, messages, tools }, { ...(settings.reasoningLevel === "off" ? {} : { reasoning: settings.reasoningLevel }), sessionId, cacheRetention: "short", timeoutMs: 180_000 });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "Agent request failed");
    return response;
  }

  /** Extracts school records through a dedicated interactive (never calendar) request. */
  public async analyzeSchoolImport(text: string, instructions: string, images: Array<{ data: string; mimeType: string }> = []): Promise<ClassifiedEmail["school"]> {
    const settings = this.database.getSettings();
    if (settings.modelProvider === "openrouter") return this.openrouter.analyzeSchoolImport(text, instructions, images);
    const model = this.models.getModel("openai-codex", settings.modelId) ?? (await this.models.getAvailable("openai-codex"))[0];
    if (!model) throw new Error("No OpenAI subscription model is available");
    if (images.length && !model.input.includes("image")) throw new Error("The selected model cannot process images. Choose a vision-capable model in Settings and try again.");
    const existing = this.database.getSchoolDashboard();
    const prompt = `Current date/time: ${new Date().toISOString()}\nTimezone: ${settings.timezone}\nSaved school import rules: ${settings.schoolImportRules}\nOne-off instructions: ${instructions}\nExisting terms and classes (reuse their numeric IDs when matching): ${JSON.stringify({ terms: existing.terms, classes: existing.classes })}\n\nUntrusted import text:\n${text}`;
    const content = [{ type: "text" as const, text: prompt }, ...images.map((image) => ({ type: "image" as const, ...image }))];
    const response = await this.models.completeSimple(model, {
      systemPrompt: SCHOOL_IMPORT_SYSTEM_PROMPT,
      messages: [{ role: "user", content, timestamp: Date.now() }],
      tools: [SCHOOL_IMPORT_TOOL],
    }, { ...(settings.reasoningLevel === "off" ? {} : { reasoning: settings.reasoningLevel }), sessionId: `school-import-${Date.now()}`, cacheRetention: "short", timeoutMs: 45_000 });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "School import request failed");
    const call = response.content.find((block) => block.type === "toolCall" && block.name === SCHOOL_IMPORT_TOOL.name);
    return schoolItemsFromToolCall(call && call.type === "toolCall" ? call : undefined);
  }

  /** Extracts zero or more event candidates from one untrusted email. */
  public async classifyEmail(email: EmailForModel): Promise<ClassifiedEmail> {
    const settings = this.database.getSettings();
    if (settings.modelProvider === "openrouter") return this.openrouter.classifyEmail(email);
    const model = this.models.getModel("openai-codex", settings.modelId) ?? (await this.models.getAvailable("openai-codex"))[0];
    if (!model) throw new Error("No OpenAI subscription model is available");
    const approved = this.database.listCandidates("history").filter((item) => item.status === "approved" && (!item.end || Date.parse(item.end) > Date.now())).slice(0, 100)
      .map((item) => ({ id: item.id, title: item.title, start: item.start, location: item.location }));
    const prompt = buildClassifyPrompt(email, settings.timezone, settings.interests, settings.filterRules, settings.schoolImportRules, approved);
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("OpenAI request timed out after 45s"));
      }, 45_000);
    });
    const response = await Promise.race([
      this.models.completeSimple(model, {
        systemPrompt: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        tools: [CLASSIFY_TOOL],
      }, {
        ...(settings.reasoningLevel === "off" ? {} : { reasoning: settings.reasoningLevel }),
        sessionId: `email-${email.id}`,
        cacheRetention: "short",
        signal: controller.signal,
        timeoutMs: 45_000,
      }),
      timeout,
    ]).finally(() => { if (timeoutId) clearTimeout(timeoutId); });
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? "OpenAI request failed");
    const call = response.content.find((block) => block.type === "toolCall" && block.name === CLASSIFY_TOOL.name);
    return classifiedEmailFromToolCall(call && call.type === "toolCall" ? call : undefined, settings.timezone, approved);
  }
}

/** Answers provider-neutral OAuth prompts from the selected web setup method. */
async function answerAuthPrompt(prompt: AuthPrompt, method: "browser" | "device_code"): Promise<string> {
  if (prompt.type === "select") {
    const preferred = prompt.options.find((option) => option.id === method) ?? prompt.options.find((option) => method === "device_code" ? option.id.includes("device") : option.id.includes("browser"));
    if (!preferred) throw new Error(`OpenAI login does not support ${method}`);
    return preferred.id;
  }
  if (prompt.type === "manual_code") {
    return await new Promise<string>((_resolve, reject) => {
      const fail = (): void => reject(new Error("OpenAI browser callback did not complete"));
      if (prompt.signal?.aborted) fail(); else prompt.signal?.addEventListener("abort", fail, { once: true });
    });
  }
  throw new Error(`OpenAI login requires unsupported ${prompt.type} input`);
}
