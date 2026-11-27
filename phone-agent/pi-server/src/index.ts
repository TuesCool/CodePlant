import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { PromptCacheManager } from "./agent/cache-manager.ts";
import { RollingCompactor } from "./agent/compaction.ts";
import { createAllAgentTools } from "./agent/phone-tools.ts";
import { PortalClient } from "./agent/portal-client.ts";
import { SafetyGuard } from "./agent/safety-guard.ts";
import { ButlerStore } from "./butler/butler-store.ts";
import { fetchChongbuluoBackground } from "./butler/chongbuluo-fetcher.ts";
import {
  discoverRemoteModels,
  FREE_PROVIDER_PRESETS,
  ModelManager,
  type ApiDialect,
} from "./config/model-discovery.ts";
import { NetworkBridgeManager } from "./config/network-bridge.ts";
import { ConnectorHub, type ConnectorsConfig } from "./integrations/connectors.ts";
import { MetasoClient, type MetasoScope } from "./integrations/metaso-client.ts";
import { KbStore } from "./knowledge/kb-store.ts";
import { AppSkillLoader } from "./skills/app-skill-loader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || "./data");
const SKILLS_DIR = path.resolve(ROOT_DIR, "./skills/apps");
const CHONGBULUO_DIR = path.join(DATA_DIR, "chongbuluo");
const WEB_INDEX_PATH = path.resolve(__dirname, "./web/public/index.html");

const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || "http://127.0.0.1:18788";
const PORTAL_TOKEN = process.env.PORTAL_TOKEN || "codeplant-dev-token";
const COMPACTION_THRESHOLD = Number(process.env.COMPACTION_THRESHOLD_PERCENT || 75);
const COMPACTION_KEEP_RECENT = Number(process.env.COMPACTION_KEEP_RECENT_MESSAGES || 6);

const bridgeManager = new NetworkBridgeManager(DATA_DIR);
const bridgeCfg = bridgeManager.getRawConfig();
const SERVER_HOST = process.env.SERVER_HOST || bridgeCfg.listenHost || "127.0.0.1";
const SERVER_PORT = Number(process.env.SERVER_PORT || bridgeCfg.listenPort || 8787);

const modelManager = new ModelManager(DATA_DIR);
await modelManager.init();

const cacheManager = new PromptCacheManager(DATA_DIR);
const kbStore = new KbStore(DATA_DIR);
const metasoClient = new MetasoClient(DATA_DIR);
const connectorHub = new ConnectorHub(DATA_DIR, kbStore);
const portal = new PortalClient(PORTAL_BASE_URL, PORTAL_TOKEN);
const skillLoader = new AppSkillLoader(SKILLS_DIR);
const compactor = new RollingCompactor(DATA_DIR, COMPACTION_THRESHOLD, COMPACTION_KEEP_RECENT);

const safety = new SafetyGuard(DATA_DIR, async (item) => {
  await portal
    .notify({
      id: `confirm-${item.id}`,
      title: `⚠️ ${item.title}`,
      body: item.detail,
      level: "confirm",
      confirmId: item.id,
    })
    .catch(() => {});
});

const butler = new ButlerStore(DATA_DIR, async (title, body) => {
  await portal.notify({
    id: `rem-${Date.now()}`,
    title,
    body,
    level: "reminder",
  });
});
butler.startReminderLoop();

const sseClients = new Set<http.ServerResponse>();
function broadcastEvent(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

let activeAgent: Agent | null = null;
let sessionMessages: AgentMessage[] = [];
const sessionId = crypto.randomUUID();
let runStepCounter = 0;

/**
 * Static prefix kept immutable across turns whenever `stablePrefixAnchor` is enabled,
 * maximizing provider-side Prompt Cache prefix hits (DeepSeek / OpenAI / Claude / Gemini).
 */
function buildStaticSystemPrompt(): string {
  const prefs = butler.readPreferences();
  const skills = skillLoader.buildPromptSection();
  return [
    "你是运行在用户小米 14（HyperOS，无 Root）本地 Termux 上的私人手机管家与自动化 Agent。",
    "工作原则：",
    "1. 默认用 phone_get_screen 读取编号控件树决策点击（省 Token）；仅当控件树为空或需视觉确认时再设 includeImage=true。",
    "2. 打开任意手机应用（如听歌软件、微信、备忘录等）时，若不确定包名，先调用 phone_list_apps(keyword) 查出准确包名，再用 phone_open_app 打开并 phone_wait(1000) 等待界面加载。",
    "3. 手机点击与中文输入标准链路：phone_get_screen -> 找到目标编号 [idx] -> phone_tap_element(index) 点击或 phone_input_text(text, index) 定位输入 -> phone_wait -> 再次 phone_get_screen 验证结果。",
    "4. 微信操作原则：用户主动下达指令“用微信给某人发消息”时，按标准链路搜索联系人、输入并发送；后台被动收到微信通知自动回复时，仍须遵守白名单与安全守则；发起视频通话前须经用户确认。",
    "5. 信息检索与知识沉淀：虫部落检索优先 chongbuluo_search_background；深度研究与导出下载用 metaso_search_export；涉及用户已有资料或“写进知识库/查知识库”时调用 kb_search / kb_save_note。",
    "6. 需求拆解与待办管理：调用 butler_add_todo / butler_generate_daily_plan / butler_weekly_review 落盘并触发原生通知督促。",
    prefs ? `\n## 个人偏好与周复盘迭代规则\n${prefs}` : "",
    skills,
  ]
    .filter(Boolean)
    .join("\n");
}

function enrichPromptWithKb(userText: string): string {
  const kbSnippet = kbStore.buildPromptContext(userText, 3);
  if (!kbSnippet) return userText;
  return `${userText}\n\n[本地个人知识库相关参考]\n${kbSnippet}`;
}

async function runAgentTurn(userText: string) {
  const primaryModel = modelManager.resolveModel("primary");
  const summaryModel = modelManager.resolveModel("compaction");
  const systemPrompt = buildStaticSystemPrompt();
  const effectiveInput = enrichPromptWithKb(userText);
  runStepCounter = 0;

  const tools = createAllAgentTools({
    portal,
    safety,
    butler,
    kb: kbStore,
    metaso: metasoClient,
    chongbuluoDir: CHONGBULUO_DIR,
    onStepLog: (label) => broadcastEvent("step", { label, ts: Date.now() }),
  });

  if (activeAgent) {
    throw new Error("当前已有指令正在执行中，请等待完成或先点击中止。");
  }

  const cacheCfg = cacheManager.getConfig();
  const agent = new Agent({
    initialState: {
      messages: sessionMessages,
      systemPrompt,
      model: primaryModel,
      thinkingLevel: "off",
      tools,
    },
    sessionId,
    beforeToolCall: async (ctx) => {
      runStepCounter++;
      if (runStepCounter > safety.getConfig().maxStepsPerRun) {
        return {
          block: true,
          terminate: true,
          reason: `单轮工具调用超过上限 (${safety.getConfig().maxStepsPerRun} 步)，已自动熔断防死循环。`,
        };
      }
      broadcastEvent("tool_start", { tool: ctx.toolCall.name, args: ctx.args });
      if (ctx.toolCall.name.startsWith("butler_")) {
        setTimeout(() => broadcastEvent("butler_updated", {}), 200);
      }
      if (ctx.toolCall.name.startsWith("kb_")) {
        setTimeout(() => broadcastEvent("kb_updated", {}), 200);
      }
      return undefined;
    },
    transformContext: async (messages) => {
      const result = await compactor.compactIfNeeded(
        messages,
        systemPrompt,
        summaryModel,
        modelManager.models,
        false,
        cacheCfg.batchHoldTurns,
      );
      if (result.compacted) {
        broadcastEvent("compacted", result.status);
      }
      return result.messages;
    },
    transport: "sse",
    streamFn: (model, context, options) =>
      modelManager.models.streamSimple(model, context, {
        ...options,
        cacheRetention: cacheManager.toPiCacheRetention(),
        sessionId,
      }),
  });

  activeAgent = agent;
  let assistantText = "";

  agent.subscribe((ev: any) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      const delta = String(ev.assistantMessageEvent.delta ?? "");
      assistantText += delta;
      broadcastEvent("delta", { delta });
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
      cacheManager.recordUsage(ev.message.usage);
      broadcastEvent("cache_updated", {
        stats: cacheManager.getStats(),
        config: cacheManager.getConfig(),
      });
    }
  });

  try {
    await agent.prompt(effectiveInput);
    sessionMessages = agent.state.messages;
    const status = compactor.estimateStatus(sessionMessages, systemPrompt, primaryModel.contextWindow);
    const cacheStats = cacheManager.getStats();
    broadcastEvent("done", { text: assistantText, contextUsage: status, cacheStats });
    void bridgeManager.forwardOutbound("agent_done", {
      prompt: userText,
      replyPreview: assistantText.slice(0, 300),
      cacheStats,
    });
    return { text: assistantText, contextUsage: status, cacheStats };
  } finally {
    activeAgent = null;
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, code: number, data: unknown, corsOrigin?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (corsOrigin) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}

function getCacheSnapshot() {
  let hint = null;
  try {
    const active = modelManager.resolveModel("primary");
    hint = cacheManager.describeModelHint(active);
  } catch {
    hint = null;
  }
  return {
    config: cacheManager.getConfig(),
    stats: cacheManager.getStats(),
    hint,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const method = req.method || "GET";
  const corsOrigin = bridgeManager.resolveCorsHeader(req.headers.origin);

  if (method === "OPTIONS") {
    res.writeHead(204, {
      ...(corsOrigin ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    res.end();
    return;
  }

  try {
    if (url.pathname.startsWith("/api/bridge/") && !bridgeManager.verifyBridgeAuth(req.headers.authorization)) {
      sendJson(res, 401, { error: "Bridge Bearer Token 校验失败" }, corsOrigin);
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      const html = fs.readFileSync(WEB_INDEX_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("event: connected\ndata: {}\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      const [portalHealth, modelStatus] = await Promise.all([portal.health(), modelManager.getStatus()]);
      let contextUsage = null;
      try {
        const m = modelManager.resolveModel("primary");
        contextUsage = compactor.estimateStatus(sessionMessages, buildStaticSystemPrompt(), m.contextWindow);
      } catch {
        // No model configured yet
      }
      sendJson(
        res,
        200,
        {
          portal: portalHealth,
          models: modelStatus,
          contextUsage,
          cache: getCacheSnapshot(),
          metaso: metasoClient.getConfigMasked(),
          downloads: metasoClient.listDownloads().slice(0, 12),
          kbCount: kbStore.listNotes().length,
          connectors: connectorHub.getCatalog(),
          bridge: bridgeManager.getConfigMasked(),
          safety: safety.getConfig(),
          pendingConfirmations: safety.listPending(),
          skills: skillLoader.loadAll().map((s) => ({ id: s.id, name: s.name, packageName: s.packageName })),
          butler: butler.getSnapshot(),
        },
        corsOrigin,
      );
      return;
    }

    if (method === "GET" && url.pathname === "/api/portal/apps") {
      const apps = await portal.listApps();
      sendJson(res, 200, { ok: true, apps }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/models/discover") {
      const body = await readJsonBody(req);
      const baseUrl = String(body.baseUrl || "").trim();
      const apiKey = String(body.apiKey || "").trim();
      const api = (body.api || "openai-completions") as ApiDialect;
      const name = String(body.name || new URL(baseUrl).hostname);
      const id = String(body.id || name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"));

      const discovered = await discoverRemoteModels(baseUrl, apiKey, api);
      await modelManager.upsertCustomProvider({
        id,
        name,
        baseUrl,
        apiKey,
        api,
        models: discovered.models,
      });
      if (discovered.models[0]) {
        await modelManager.setRouting({ primaryProvider: id, primaryModel: discovered.models[0].id });
      }
      sendJson(res, 200, { ok: true, providerId: id, ...discovered }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/models/preset") {
      const body = await readJsonBody(req);
      const presetId = String(body.presetId || "").trim();
      const apiKey = String(body.apiKey || "").trim();
      const preset = FREE_PROVIDER_PRESETS.find((p) => p.id === presetId);
      if (!preset) return sendJson(res, 404, { error: "未找到对应模型预设" }, corsOrigin);
      if (!apiKey) return sendJson(res, 400, { error: "请先填入该预设平台对应的 API Key" }, corsOrigin);

      let models = preset.defaultModels;
      let endpointUsed = `${preset.baseUrl} (builtin-preset)`;
      if (body.autoDiscover !== false) {
        try {
          const discovered = await discoverRemoteModels(preset.baseUrl, apiKey, preset.api);
          if (discovered.models.length > 0) {
            models = discovered.models;
            endpointUsed = discovered.endpointUsed;
          }
        } catch {
          // Some free endpoints do not expose /models; keep builtin defaultModels seamlessly.
        }
      }

      await modelManager.upsertCustomProvider({
        id: preset.id,
        name: preset.name,
        baseUrl: preset.baseUrl,
        apiKey,
        api: preset.api,
        models,
      });
      if (models[0]) {
        await modelManager.setRouting({ primaryProvider: preset.id, primaryModel: models[0].id });
      }
      sendJson(
        res,
        200,
        { ok: true, providerId: preset.id, models, endpointUsed },
        corsOrigin,
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/models/routing") {
      const body = await readJsonBody(req);
      await modelManager.setRouting(body);
      sendJson(
        res,
        200,
        { ok: true, routing: modelManager.getRouting(), cache: getCacheSnapshot() },
        corsOrigin,
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/cache") {
      const body = await readJsonBody(req);
      const updated = cacheManager.updateConfig(body);
      sendJson(res, 200, { ok: true, cache: { ...getCacheSnapshot(), config: updated } }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/oauth/chatgpt/start") {
      const body = await readJsonBody(req);
      modelManager.startChatGptOAuth(body.method === "device" ? "device" : "browser");
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/oauth/chatgpt/answer") {
      const body = await readJsonBody(req);
      const ok = modelManager.submitOAuthPrompt(String(body.value ?? ""));
      sendJson(res, 200, { ok }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message 不能为空" }, corsOrigin);
      const result = await runAgentTurn(message);
      sendJson(res, 200, result, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat/abort") {
      activeAgent?.abort();
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/compact") {
      const m = modelManager.resolveModel("compaction");
      const resCompact = await compactor.compactIfNeeded(
        sessionMessages,
        buildStaticSystemPrompt(),
        m,
        modelManager.models,
        true,
        cacheManager.getConfig().batchHoldTurns,
      );
      sessionMessages = resCompact.messages;
      sendJson(res, 200, resCompact, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/confirmations/resolve") {
      const body = await readJsonBody(req);
      const ok = safety.resolve(String(body.id || ""), Boolean(body.allow));
      sendJson(res, 200, { ok }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/safety") {
      const body = await readJsonBody(req);
      safety.updateConfig(body);
      sendJson(res, 200, { ok: true, safety: safety.getConfig() }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chongbuluo/search") {
      const body = await readJsonBody(req);
      const out = await fetchChongbuluoBackground(String(body.query || ""), CHONGBULUO_DIR);
      sendJson(res, 200, out, corsOrigin);
      return;
    }

    // Metaso AI search + downloadable artifacts
    if (method === "POST" && url.pathname === "/api/metaso/config") {
      const body = await readJsonBody(req);
      const masked = metasoClient.updateConfig(body);
      sendJson(res, 200, { ok: true, metaso: masked }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/metaso/search") {
      const body = await readJsonBody(req);
      const out = await metasoClient.searchAndExport(
        String(body.query || ""),
        body.scope as MetasoScope | undefined,
      );
      sendJson(res, out.ok ? 200 : 400, { ...out, downloads: metasoClient.listDownloads().slice(0, 12) }, corsOrigin);
      return;
    }

    if (method === "GET" && url.pathname === "/api/downloads") {
      sendJson(res, 200, { ok: true, downloads: metasoClient.listDownloads() }, corsOrigin);
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/downloads/")) {
      const rawName = url.pathname.slice("/api/downloads/".length);
      const fullPath = metasoClient.resolveDownloadPath(rawName);
      if (!fullPath) return sendJson(res, 404, { error: "文件不存在" }, corsOrigin);
      const filename = path.basename(fullPath);
      const content = fs.readFileSync(fullPath);
      res.writeHead(200, {
        "Content-Type": filename.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      res.end(content);
      return;
    }

    // Personal Knowledge Base (local Markdown + synced index)
    if (method === "GET" && url.pathname === "/api/kb/notes") {
      sendJson(res, 200, { ok: true, notes: kbStore.listNotes() }, corsOrigin);
      return;
    }

    if (method === "GET" && url.pathname.startsWith("/api/kb/notes/")) {
      const noteId = decodeURIComponent(url.pathname.slice("/api/kb/notes/".length));
      const note = kbStore.getNote(noteId);
      if (!note) return sendJson(res, 404, { error: "笔记不存在" }, corsOrigin);
      sendJson(res, 200, { ok: true, note }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/kb/notes") {
      const body = await readJsonBody(req);
      const note = kbStore.saveNote({
        id: body.id ? String(body.id) : undefined,
        title: String(body.title || "未命名笔记"),
        content: String(body.content || ""),
        tags: Array.isArray(body.tags)
          ? body.tags.map(String)
          : String(body.tags || "")
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
        source: String(body.source || "local"),
      });
      broadcastEvent("kb_updated", {});
      sendJson(res, 200, { ok: true, note }, corsOrigin);
      return;
    }

    if (method === "DELETE" && url.pathname.startsWith("/api/kb/notes/")) {
      const noteId = decodeURIComponent(url.pathname.slice("/api/kb/notes/".length));
      const deleted = kbStore.deleteNote(noteId);
      broadcastEvent("kb_updated", {});
      sendJson(res, 200, { ok: deleted }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/kb/search") {
      const body = await readJsonBody(req);
      const hits = kbStore.searchNotes(String(body.query || ""), 8);
      sendJson(res, 200, { ok: true, hits }, corsOrigin);
      return;
    }

    // Platform Connectors Hub
    if (method === "GET" && url.pathname === "/api/connectors") {
      sendJson(
        res,
        200,
        { ok: true, catalog: connectorHub.getCatalog(), config: connectorHub.getMaskedConfig() },
        corsOrigin,
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/connectors/update") {
      const body = await readJsonBody(req);
      const platform = String(body.platform || "") as keyof ConnectorsConfig;
      const out = connectorHub.updatePlatform(platform, body.patch ?? {});
      sendJson(res, 200, { ok: true, ...out }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/connectors/test") {
      const body = await readJsonBody(req);
      const platform = String(body.platform || "") as keyof ConnectorsConfig;
      const out = await connectorHub.testConnection(platform);
      sendJson(res, 200, out, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/connectors/sync") {
      const body = await readJsonBody(req);
      const platform = String(body.platform || "") as "obsidian" | "yuque" | "notion";
      if (!["obsidian", "yuque", "notion"].includes(platform)) {
        return sendJson(res, 400, { error: "仅支持 obsidian / yuque / notion 一键拉取到本地知识库" }, corsOrigin);
      }
      const out = await connectorHub.syncToLocalKb(platform);
      broadcastEvent("kb_updated", {});
      sendJson(res, 200, { ok: true, ...out }, corsOrigin);
      return;
    }

    // Network / Shared Ports / External Website Bridge
    if (method === "GET" && url.pathname === "/api/bridge/config") {
      sendJson(res, 200, { ok: true, bridge: bridgeManager.getConfigMasked() }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/bridge/config") {
      const body = await readJsonBody(req);
      const updated = bridgeManager.updateConfig(body);
      sendJson(
        res,
        200,
        {
          ok: true,
          bridge: updated,
          note: "CORS 与 Bridge Token 立即生效；修改监听 Host 或端口后将在下次重启 pi-server 时绑定。",
        },
        corsOrigin,
      );
      return;
    }

    if (method === "GET" && url.pathname === "/api/bridge/manifest") {
      const cfg = bridgeManager.getConfigMasked();
      sendJson(
        res,
        200,
        {
          service: "CodePlant MI14 Phone Agent Bridge",
          version: "0.2.0",
          listen: `${SERVER_HOST}:${SERVER_PORT}`,
          publicBaseUrl: cfg.publicBaseUrl || `http://${SERVER_HOST}:${SERVER_PORT}`,
          endpoints: [
            { method: "GET", path: "/api/bridge/manifest", desc: "获取服务清单与端口映射" },
            { method: "POST", path: "/api/bridge/invoke", desc: "跨站调用待办写入、知识库检索或执行 Agent 指令" },
          ],
          sharedPorts: cfg.sharedPorts,
        },
        corsOrigin,
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/bridge/invoke") {
      const body = await readJsonBody(req);
      const action = String(body.action || "chat");
      if (action === "todo.add") {
        const todo = butler.addTodo(body.payload ?? {});
        broadcastEvent("butler_updated", {});
        return sendJson(res, 200, { ok: true, todo }, corsOrigin);
      }
      if (action === "kb.search") {
        const hits = kbStore.searchNotes(String(body.payload?.query || ""), 5);
        return sendJson(res, 200, { ok: true, hits }, corsOrigin);
      }
      if (action === "chat") {
        const message = String(body.payload?.message || body.message || "").trim();
        if (!message) return sendJson(res, 400, { error: "payload.message 不能为空" }, corsOrigin);
        const result = await runAgentTurn(message);
        return sendJson(res, 200, { ok: true, result }, corsOrigin);
      }
      return sendJson(res, 400, { error: `未知 bridge action: ${action}` }, corsOrigin);
    }

    // Butler routes
    if (method === "POST" && url.pathname === "/api/butler/todos") {
      const body = await readJsonBody(req);
      if (body.action === "status") {
        const updated = butler.updateTodoStatus(String(body.id || ""), body.status);
        broadcastEvent("butler_updated", {});
        return sendJson(res, 200, { ok: Boolean(updated), todo: updated }, corsOrigin);
      }
      if (body.action === "delete") {
        const deleted = butler.deleteTodo(String(body.id || ""));
        broadcastEvent("butler_updated", {});
        return sendJson(res, 200, { ok: deleted }, corsOrigin);
      }
      const created = butler.addTodo(body);
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true, todo: created }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/plan/generate") {
      const body = await readJsonBody(req);
      const plan = butler.generateDailyPlan(Number(body.startHour ?? 9), Boolean(body.fromNow));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true, plan }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/plan/slot") {
      const body = await readJsonBody(req);
      const slot = butler.togglePlanSlotDone(String(body.slotId || ""), Boolean(body.done));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: Boolean(slot), slot }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/notify-test") {
      await portal.notify({
        id: `test-${Date.now()}`,
        title: "🔔 CodePlant 督促通道测试",
        body: "MI14 原生通知链路已连通！后续每日计划到点将通过此通道提醒你。",
        level: "reminder",
      });
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/preferences") {
      const body = await readJsonBody(req);
      butler.savePreferences(String(body.content ?? ""));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/review/weekly") {
      const body = await readJsonBody(req);
      const review = butler.generateWeeklyReview(Boolean(body.applyOptimization));
      sendJson(res, 200, { ok: true, review }, corsOrigin);
      return;
    }

    // Webhooks pushed by Android Portal APK
    if (method === "POST" && url.pathname === "/webhook/notification") {
      const body = await readJsonBody(req);
      const pkg = String(body.packageName || "");
      const title = String(body.title || "");
      const text = String(body.text || "");
      if (pkg === "com.tencent.mm") {
        const whitelisted = safety.isWeChatReplyAllowed(title);
        butler.recordWeChatEvent(
          title,
          text,
          whitelisted ? "命中回复白名单（可自动起草/回复）" : "仅监听记录（未命中白名单）",
        );
        broadcastEvent("wechat_notification", { title, text, whitelisted });
      }
      sendJson(res, 200, { ok: true }, corsOrigin);
      return;
    }

    if (method === "POST" && url.pathname === "/webhook/confirm") {
      const body = await readJsonBody(req);
      const ok = safety.resolve(String(body.confirmId || ""), Boolean(body.allow));
      broadcastEvent("confirm_resolved", { confirmId: body.confirmId, allow: body.allow });
      sendJson(res, 200, { ok }, corsOrigin);
      return;
    }

    sendJson(res, 404, { error: "Not Found" }, corsOrigin);
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message ?? String(err) }, corsOrigin);
  }
});

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[CodePlant pi-server] Listening on http://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[CodePlant pi-server] Portal target: ${PORTAL_BASE_URL}`);
});
