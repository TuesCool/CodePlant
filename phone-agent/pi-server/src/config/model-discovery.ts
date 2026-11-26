import fs from "node:fs";
import path from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type AuthInteraction,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export type ApiDialect = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface CustomModelEntry {
  id: string;
  contextWindow?: number;
  images?: boolean;
  reasoning?: boolean;
  api?: ApiDialect;
}

export interface CustomProviderEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api?: ApiDialect;
  models: CustomModelEntry[];
}

export interface ModelRoutingConfig {
  primaryProvider: string;
  primaryModel: string;
  visionProvider?: string;
  visionModel?: string;
  compactionProvider?: string;
  compactionModel?: string;
}

export interface PersistedModelState {
  customProviders: CustomProviderEntry[];
  credentials: Record<string, Credential>;
  routing: ModelRoutingConfig;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
export const CHATGPT_OAUTH_PROVIDER = "openai-codex";

/**
 * File-backed credential store so ChatGPT OAuth refresh tokens survive Termux restarts.
 */
class FileCredentialStore implements CredentialStore {
  private readonly inner = new InMemoryCredentialStore();

  constructor(private readonly onPersist: () => void) {}

  async load(saved: Record<string, Credential>) {
    for (const [id, cred] of Object.entries(saved)) {
      await this.inner.modify(id, async () => cred);
    }
  }

  async exportAll(): Promise<Record<string, Credential>> {
    const out: Record<string, Credential> = {};
    for (const info of await this.inner.list()) {
      const c = await this.inner.read(info.providerId);
      if (c) out[info.providerId] = c;
    }
    return out;
  }

  read: CredentialStore["read"] = (id, opts) => this.inner.read(id, opts);
  list: CredentialStore["list"] = (opts) => this.inner.list(opts);

  modify: CredentialStore["modify"] = async (id, fn, opts) => {
    const res = await this.inner.modify(id, fn, opts);
    this.onPersist();
    return res;
  };

  delete: CredentialStore["delete"] = async (id, opts) => {
    await this.inner.delete(id, opts);
    this.onPersist();
  };
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function inferImageSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("gpt-4o") ||
    lower.includes("gpt-4.1") ||
    lower.includes("gpt-5") ||
    lower.includes("o3") ||
    lower.includes("o4") ||
    lower.includes("claude-3") ||
    lower.includes("claude-4") ||
    lower.includes("claude-sonnet") ||
    lower.includes("claude-opus") ||
    lower.includes("gemini") ||
    lower.includes("qwen-vl") ||
    lower.includes("qwen2.5-vl") ||
    lower.includes("glm-4v") ||
    lower.includes("vision")
  );
}

/**
 * Probes an OpenAI-compatible or Anthropic-compatible endpoint's `/models` endpoint
 * and falls back gracefully if the relay omits `/v1` or requires manual entry.
 */
export async function discoverRemoteModels(
  baseUrl: string,
  apiKey: string,
  api: ApiDialect = "openai-completions",
): Promise<{ models: CustomModelEntry[]; endpointUsed: string }> {
  const clean = normalizeUrl(baseUrl);
  const candidates = clean.endsWith("/v1")
    ? [`${clean}/models`]
    : [`${clean}/v1/models`, `${clean}/models`];

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (api === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let lastError = "未获取到模型列表";
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} (${url})`;
        continue;
      }
      const payload = (await resp.json()) as any;
      const list: any[] = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];
      const parsed = list
        .map((item): CustomModelEntry | null => {
          const id = String(item?.id ?? item?.name ?? "").trim();
          if (!id) return null;
          const ctx = Number(item?.context_length ?? item?.contextWindow ?? 0);
          return {
            id,
            api,
            contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : DEFAULT_CONTEXT_WINDOW,
            images: inferImageSupport(id),
            reasoning: /o1|o3|o4|reason|r1|thinking/i.test(id),
          };
        })
        .filter((x): x is CustomModelEntry => x !== null);

      if (parsed.length > 0) {
        return { models: parsed, endpointUsed: url };
      }
      lastError = `接口返回空模型列表 (${url})`;
    } catch (err: any) {
      lastError = `${err?.message ?? String(err)} (${url})`;
    }
  }
  throw new Error(`自动发现模型失败: ${lastError}`);
}

export class ModelManager {
  readonly credentials: FileCredentialStore;
  readonly models: MutableModels;
  private customProviders = new Map<string, CustomProviderEntry>();
  private routing: ModelRoutingConfig = {
    primaryProvider: CHATGPT_OAUTH_PROVIDER,
    primaryModel: "gpt-5.1-codex",
  };
  private readonly storePath: string;
  private oauthLogBuffer: string[] = [];
  private oauthPendingPrompt: {
    resolve: (v: string) => void;
    reject: (e: unknown) => void;
    prompt: Omit<AuthPrompt, "signal">;
  } | null = null;
  private loginAbort: AbortController | null = null;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.storePath = path.join(dataDir, "models-state.json");
    this.credentials = new FileCredentialStore(() => {
      void this.persist();
    });
    this.models = createModels({ credentials: this.credentials });
    this.registerBuiltins();
  }

  private registerBuiltins() {
    for (const provider of [
      openaiCodexProvider(),
      openaiProvider(),
      deepseekProvider(),
      anthropicProvider(),
      googleProvider(),
    ]) {
      this.models.setProvider(provider);
    }
  }

  async init() {
    if (!fs.existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, "utf-8")) as Partial<PersistedModelState>;
      if (raw.credentials) {
        await this.credentials.load(raw.credentials);
      }
      if (Array.isArray(raw.customProviders)) {
        for (const p of raw.customProviders) {
          await this.upsertCustomProvider(p, false);
        }
      }
      if (raw.routing?.primaryProvider && raw.routing?.primaryModel) {
        this.routing = raw.routing;
      }
    } catch (err) {
      console.error("[ModelManager] failed to load models-state.json:", err);
    }
  }

  async persist() {
    const state: PersistedModelState = {
      customProviders: [...this.customProviders.values()],
      credentials: await this.credentials.exportAll(),
      routing: this.routing,
    };
    fs.writeFileSync(this.storePath, JSON.stringify(state, null, 2), "utf-8");
  }

  async upsertCustomProvider(entry: CustomProviderEntry, save = true) {
    const cleanBase = normalizeUrl(entry.baseUrl);
    const normalized: CustomProviderEntry = { ...entry, baseUrl: cleanBase };
    this.customProviders.set(entry.id, normalized);

    const providerObj = createProvider({
      id: entry.id,
      name: entry.name,
      baseUrl: cleanBase,
      auth: { apiKey: envApiKeyAuth(`${entry.name} API key`, []) },
      models: entry.models.map((m) => {
        const api = m.api ?? entry.api ?? "openai-completions";
        const resolvedBase =
          api === "openai-completions" && !cleanBase.endsWith("/v1")
            ? `${cleanBase}/v1`
            : cleanBase;
        return {
          id: m.id,
          name: m.id,
          api,
          provider: entry.id,
          baseUrl: resolvedBase,
          reasoning: Boolean(m.reasoning),
          input: m.images ? (["text", "image"] as const) : (["text"] as const),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: 16_384,
          compat:
            api === "openai-completions"
              ? { supportsStore: false, supportsDeveloperRole: false }
              : undefined,
        };
      }),
      api: {
        "openai-completions": openAICompletionsApi(),
        "openai-responses": openAIResponsesApi(),
        "anthropic-messages": anthropicMessagesApi(),
      },
    });
    this.models.setProvider(providerObj);
    if (entry.apiKey) {
      await this.credentials.modify(entry.id, async () => ({
        type: "api_key",
        key: entry.apiKey,
      }));
    }
    if (save) await this.persist();
  }

  getRouting(): ModelRoutingConfig {
    return { ...this.routing };
  }

  async setRouting(next: Partial<ModelRoutingConfig>) {
    this.routing = { ...this.routing, ...next };
    await this.persist();
  }

  resolveModel(role: "primary" | "vision" | "compaction" = "primary"): Model<any> {
    const r = this.routing;
    const target =
      role === "vision" && r.visionProvider && r.visionModel
        ? { provider: r.visionProvider, model: r.visionModel }
        : role === "compaction" && r.compactionProvider && r.compactionModel
          ? { provider: r.compactionProvider, model: r.compactionModel }
          : { provider: r.primaryProvider, model: r.primaryModel };

    const m = this.models.getModel(target.provider, target.model);
    if (m) return m;

    for (const p of this.customProviders.values()) {
      if (p.models.length > 0) {
        const fallback = this.models.getModel(p.id, p.models[0].id);
        if (fallback) return fallback;
      }
    }
    const codexModels = this.models.getModels(CHATGPT_OAUTH_PROVIDER);
    if (codexModels.length > 0) return codexModels[codexModels.length - 1];
    throw new Error("当前没有可用模型，请先配置 Base URL + Key 或登录 ChatGPT。");
  }

  async getStatus() {
    const creds = await this.credentials.list();
    const providers = this.models.getProviders().map((p) => ({
      id: p.id,
      name: p.id === CHATGPT_OAUTH_PROVIDER ? "ChatGPT Plus/Pro (OAuth)" : p.name,
      custom: this.customProviders.has(p.id),
      authenticated: creds.some((c) => c.providerId === p.id),
      credentialType: creds.find((c) => c.providerId === p.id)?.type ?? null,
      models: this.models.getModels(p.id).map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        images: m.input.includes("image"),
      })),
    }));
    return {
      routing: this.routing,
      providers,
      oauthPendingPrompt: this.oauthPendingPrompt?.prompt ?? null,
      oauthLogs: this.oauthLogBuffer.slice(-15),
    };
  }

  startChatGptOAuth(preferredMethod: "browser" | "device" = "browser") {
    this.loginAbort?.abort();
    const controller = new AbortController();
    this.loginAbort = controller;
    this.oauthLogBuffer = [`[OAuth] 正在启动 ChatGPT (${preferredMethod}) 登录...`];

    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event: any) => {
        const msg = typeof event === "string" ? event : JSON.stringify(event);
        this.oauthLogBuffer.push(msg);
      },
      prompt: (p: AuthPrompt) => {
        if (p.type === "select") {
          const match = p.options.find((o) => o.id.includes(preferredMethod));
          if (match) return Promise.resolve(match.id);
        }
        return new Promise<string>((resolve, reject) => {
          const { signal: _s, ...shown } = p;
          this.oauthPendingPrompt = { resolve, reject, prompt: shown };
        });
      },
    };

    void this.models
      .login(CHATGPT_OAUTH_PROVIDER, "oauth", interaction, { agentName: "codeplant-phone-agent" })
      .then(async () => {
        this.oauthLogBuffer.push("[OAuth] ChatGPT 登录成功，凭据已持久化。");
        this.oauthPendingPrompt = null;
        await this.persist();
      })
      .catch((err: any) => {
        this.oauthLogBuffer.push(`[OAuth] 失败: ${err?.message ?? String(err)}`);
        this.oauthPendingPrompt = null;
      });
  }

  submitOAuthPrompt(value: string) {
    if (!this.oauthPendingPrompt) return false;
    const pending = this.oauthPendingPrompt;
    this.oauthPendingPrompt = null;
    pending.resolve(value);
    return true;
  }
}
