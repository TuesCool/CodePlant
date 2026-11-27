import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { RollingCompactor } from "./agent/compaction.ts";
import { createAllAgentTools } from "./agent/phone-tools.ts";
import { PortalClient } from "./agent/portal-client.ts";
import { SafetyGuard } from "./agent/safety-guard.ts";
import { ButlerStore } from "./butler/butler-store.ts";
import { fetchChongbuluoBackground } from "./butler/chongbuluo-fetcher.ts";
import { discoverRemoteModels, ModelManager, type ApiDialect } from "./config/model-discovery.ts";
import { AppSkillLoader } from "./skills/app-skill-loader.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || "./data");
const SKILLS_DIR = path.resolve(ROOT_DIR, "./skills/apps");
const CHONGBULUO_DIR = path.join(DATA_DIR, "chongbuluo");
const WEB_INDEX_PATH = path.resolve(__dirname, "./web/public/index.html");

const SERVER_HOST = process.env.SERVER_HOST || "127.0.0.1";
const SERVER_PORT = Number(process.env.SERVER_PORT || 8787);
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || "http://127.0.0.1:18788";
const PORTAL_TOKEN = process.env.PORTAL_TOKEN || "codeplant-dev-token";
const COMPACTION_THRESHOLD = Number(process.env.COMPACTION_THRESHOLD_PERCENT || 75);
const COMPACTION_KEEP_RECENT = Number(process.env.COMPACTION_KEEP_RECENT_MESSAGES || 6);

const modelManager = new ModelManager(DATA_DIR);
await modelManager.init();

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
let runStepCounter = 0;

function buildSystemPrompt(): string {
  const prefs = butler.readPreferences();
  const skills = skillLoader.buildPromptSection();
  return [
    "你是运行在用户小米 14（HyperOS，无 Root）本地 Termux 上的私人手机管家与自动化 Agent。",
    "工作原则：",
    "1. 默认用 phone_get_screen 读取精简编号控件树来决策点击，节省 Token；仅当控件树缺失或需要视觉确认时再设 includeImage=true。",
    "2. 虫部落检索优先调用 chongbuluo_search_background 在后台抓取并整理 Markdown；仅当后台受限时才用手机控屏。",
    "3. 微信操作严格遵守风控：非白名单禁止自动发送回复（只生成草稿）；拨打微信视频通话必须告知目的并在被拒时立即停止。",
    "4. 收到需求拆解为待办时，调用 butler_add_todo / butler_generate_daily_plan / butler_weekly_review 落盘并开启原生通知督促。",
    prefs ? `\n## 个人偏好与周复盘迭代规则\n${prefs}` : "",
    skills,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runAgentTurn(userText: string) {
  const primaryModel = modelManager.resolveModel("primary");
  const summaryModel = modelManager.resolveModel("compaction");
  const systemPrompt = buildSystemPrompt();
  runStepCounter = 0;

  const tools = createAllAgentTools({
    portal,
    safety,
    butler,
    chongbuluoDir: CHONGBULUO_DIR,
    onStepLog: (label) => broadcastEvent("step", { label, ts: Date.now() }),
  });

  if (activeAgent) {
    throw new Error("当前已有指令正在执行中，请等待完成或先点击中止。");
  }

  const agent = new Agent({
    initialState: {
      messages: sessionMessages,
      systemPrompt,
      model: primaryModel,
      thinkingLevel: "off",
      tools,
    },
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
      return undefined;
    },
    transformContext: async (messages) => {
      const result = await compactor.compactIfNeeded(
        messages,
        systemPrompt,
        summaryModel,
        modelManager.models,
      );
      if (result.compacted) {
        broadcastEvent("compacted", result.status);
      }
      return result.messages;
    },
    transport: "sse",
    streamFn: modelManager.models.streamSimple.bind(modelManager.models),
  });

  activeAgent = agent;
  let assistantText = "";

  agent.subscribe((ev: any) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      const delta = String(ev.assistantMessageEvent.delta ?? "");
      assistantText += delta;
      broadcastEvent("delta", { delta });
    }
  });

  try {
    await agent.prompt(userText);
    sessionMessages = agent.state.messages;
    const status = compactor.estimateStatus(sessionMessages, systemPrompt, primaryModel.contextWindow);
    broadcastEvent("done", { text: assistantText, contextUsage: status });
    return { text: assistantText, contextUsage: status };
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

function sendJson(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const method = req.method || "GET";

  try {
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
        contextUsage = compactor.estimateStatus(sessionMessages, buildSystemPrompt(), m.contextWindow);
      } catch {
        // No model configured yet
      }
      sendJson(res, 200, {
        portal: portalHealth,
        models: modelStatus,
        contextUsage,
        safety: safety.getConfig(),
        pendingConfirmations: safety.listPending(),
        skills: skillLoader.loadAll().map((s) => ({ id: s.id, name: s.name, packageName: s.packageName })),
        butler: butler.getSnapshot(),
      });
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
      sendJson(res, 200, { ok: true, providerId: id, ...discovered });
      return;
    }

    if (method === "POST" && url.pathname === "/api/models/routing") {
      const body = await readJsonBody(req);
      await modelManager.setRouting(body);
      sendJson(res, 200, { ok: true, routing: modelManager.getRouting() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/oauth/chatgpt/start") {
      const body = await readJsonBody(req);
      modelManager.startChatGptOAuth(body.method === "device" ? "device" : "browser");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/oauth/chatgpt/answer") {
      const body = await readJsonBody(req);
      const ok = modelManager.submitOAuthPrompt(String(body.value ?? ""));
      sendJson(res, 200, { ok });
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message 不能为空" });
      const result = await runAgentTurn(message);
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/chat/abort") {
      activeAgent?.abort();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/compact") {
      const m = modelManager.resolveModel("compaction");
      const resCompact = await compactor.compactIfNeeded(
        sessionMessages,
        buildSystemPrompt(),
        m,
        modelManager.models,
        true,
      );
      sessionMessages = resCompact.messages;
      sendJson(res, 200, resCompact);
      return;
    }

    if (method === "POST" && url.pathname === "/api/confirmations/resolve") {
      const body = await readJsonBody(req);
      const ok = safety.resolve(String(body.id || ""), Boolean(body.allow));
      sendJson(res, 200, { ok });
      return;
    }

    if (method === "POST" && url.pathname === "/api/safety") {
      const body = await readJsonBody(req);
      safety.updateConfig(body);
      sendJson(res, 200, { ok: true, safety: safety.getConfig() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/chongbuluo/search") {
      const body = await readJsonBody(req);
      const out = await fetchChongbuluoBackground(String(body.query || ""), CHONGBULUO_DIR);
      sendJson(res, 200, out);
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/todos") {
      const body = await readJsonBody(req);
      if (body.action === "status") {
        const updated = butler.updateTodoStatus(String(body.id || ""), body.status);
        broadcastEvent("butler_updated", {});
        return sendJson(res, 200, { ok: Boolean(updated), todo: updated });
      }
      if (body.action === "delete") {
        const deleted = butler.deleteTodo(String(body.id || ""));
        broadcastEvent("butler_updated", {});
        return sendJson(res, 200, { ok: deleted });
      }
      const created = butler.addTodo(body);
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true, todo: created });
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/plan/generate") {
      const body = await readJsonBody(req);
      const plan = butler.generateDailyPlan(Number(body.startHour ?? 9), Boolean(body.fromNow));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true, plan });
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/plan/slot") {
      const body = await readJsonBody(req);
      const slot = butler.togglePlanSlotDone(String(body.slotId || ""), Boolean(body.done));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: Boolean(slot), slot });
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/notify-test") {
      await portal.notify({
        id: `test-${Date.now()}`,
        title: "🔔 CodePlant 督促通道测试",
        body: "MI14 原生通知链路已连通！后续每日计划到点将通过此通道提醒你。",
        level: "reminder",
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/preferences") {
      const body = await readJsonBody(req);
      butler.savePreferences(String(body.content ?? ""));
      broadcastEvent("butler_updated", {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/butler/review/weekly") {
      const body = await readJsonBody(req);
      const review = butler.generateWeeklyReview(Boolean(body.applyOptimization));
      sendJson(res, 200, { ok: true, review });
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
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/webhook/confirm") {
      const body = await readJsonBody(req);
      const ok = safety.resolve(String(body.confirmId || ""), Boolean(body.allow));
      broadcastEvent("confirm_resolved", { confirmId: body.confirmId, allow: body.allow });
      sendJson(res, 200, { ok });
      return;
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (err: any) {
    sendJson(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`[CodePlant pi-server] Listening on http://${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`[CodePlant pi-server] Portal target: ${PORTAL_BASE_URL}`);
});
