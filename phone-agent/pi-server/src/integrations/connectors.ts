import fs from "node:fs";
import path from "node:path";
import type { KbStore } from "../knowledge/kb-store.ts";

export interface ConnectorsConfig {
  obsidian: {
    enabled: boolean;
    vaultPath: string;
    restApiUrl: string;
    restApiToken: string;
  };
  yuque: {
    enabled: boolean;
    token: string;
    baseUrl: string;
  };
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    webhookUrl: string;
  };
  notion: {
    enabled: boolean;
    token: string;
  };
  notebooklm: {
    enabled: boolean;
    mode: "mcp_bridge" | "phone_control";
    mcpEndpoint: string;
    notebookUrl: string;
  };
  ima: {
    enabled: boolean;
    mode: "mcp_bridge" | "phone_control";
    mcpEndpoint: string;
    kbId: string;
  };
  customBridge: {
    enabled: boolean;
    endpoint: string;
    token: string;
    description: string;
  };
}

const DEFAULT_CONNECTORS: ConnectorsConfig = {
  obsidian: {
    enabled: false,
    vaultPath: "/sdcard/Documents/Obsidian",
    restApiUrl: "http://127.0.0.1:27123",
    restApiToken: "",
  },
  yuque: {
    enabled: false,
    token: "",
    baseUrl: "https://www.yuque.com/api/v2",
  },
  feishu: {
    enabled: false,
    appId: "",
    appSecret: "",
    webhookUrl: "",
  },
  notion: {
    enabled: false,
    token: "",
  },
  notebooklm: {
    enabled: false,
    mode: "mcp_bridge",
    mcpEndpoint: "",
    notebookUrl: "",
  },
  ima: {
    enabled: false,
    mode: "mcp_bridge",
    mcpEndpoint: "",
    kbId: "",
  },
  customBridge: {
    enabled: false,
    endpoint: "",
    token: "",
    description: "",
  },
};

export interface ConnectorCatalogItem {
  id: keyof ConnectorsConfig;
  name: string;
  strategy: "native_api" | "local_fs_or_rest" | "mcp_or_ui_bridge";
  strategyLabel: string;
  statusNote: string;
  configured: boolean;
  enabled: boolean;
}

function maskSecret(val: string): string {
  if (!val) return "";
  if (val.length <= 8) return "***";
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

export class ConnectorHub {
  private config: ConnectorsConfig = structuredClone(DEFAULT_CONNECTORS);
  private readonly storePath: string;

  constructor(
    dataDir: string,
    private readonly kb: KbStore,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.storePath = path.join(dataDir, "connectors-config.json");
    if (fs.existsSync(this.storePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
        this.config = {
          obsidian: { ...DEFAULT_CONNECTORS.obsidian, ...(saved.obsidian ?? {}) },
          yuque: { ...DEFAULT_CONNECTORS.yuque, ...(saved.yuque ?? {}) },
          feishu: { ...DEFAULT_CONNECTORS.feishu, ...(saved.feishu ?? {}) },
          notion: { ...DEFAULT_CONNECTORS.notion, ...(saved.notion ?? {}) },
          notebooklm: { ...DEFAULT_CONNECTORS.notebooklm, ...(saved.notebooklm ?? {}) },
          ima: { ...DEFAULT_CONNECTORS.ima, ...(saved.ima ?? {}) },
          customBridge: { ...DEFAULT_CONNECTORS.customBridge, ...(saved.customBridge ?? {}) },
        };
      } catch {
        // ignore corrupt config
      }
    }
  }

  getMaskedConfig() {
    const c = this.config;
    return {
      obsidian: { ...c.obsidian, restApiToken: maskSecret(c.obsidian.restApiToken) },
      yuque: { ...c.yuque, token: maskSecret(c.yuque.token) },
      feishu: { ...c.feishu, appSecret: maskSecret(c.feishu.appSecret) },
      notion: { ...c.notion, token: maskSecret(c.notion.token) },
      notebooklm: { ...c.notebooklm },
      ima: { ...c.ima },
      customBridge: { ...c.customBridge, token: maskSecret(c.customBridge.token) },
    };
  }

  getCatalog(): ConnectorCatalogItem[] {
    const c = this.config;
    return [
      {
        id: "obsidian",
        name: "Obsidian",
        strategy: "local_fs_or_rest",
        strategyLabel: "本地 Vault 直读 + Local REST API",
        statusNote: "支持 Termux 直读手机本地 Vault Markdown，或通过 Obsidian Local REST API 插件双向同步。",
        configured: Boolean(c.obsidian.vaultPath || (c.obsidian.restApiUrl && c.obsidian.restApiToken)),
        enabled: c.obsidian.enabled,
      },
      {
        id: "yuque",
        name: "语雀 Yuque",
        strategy: "native_api",
        strategyLabel: "官方 REST API v2 (X-Auth-Token)",
        statusNote: "直连 yuque.com/api/v2 读取个人知识库目录并同步正文到 MI14 本地知识库。",
        configured: Boolean(c.yuque.token),
        enabled: c.yuque.enabled,
      },
      {
        id: "feishu",
        name: "飞书 Feishu",
        strategy: "native_api",
        strategyLabel: "OpenAPI (App ID + Secret) / 群机器人",
        statusNote: "通过 tenant_access_token 接入飞书文档、知识空间与消息推送（不依赖特定大模型）。",
        configured: Boolean((c.feishu.appId && c.feishu.appSecret) || c.feishu.webhookUrl),
        enabled: c.feishu.enabled,
      },
      {
        id: "notion",
        name: "Notion",
        strategy: "native_api",
        strategyLabel: "官方 REST API (2022-06-28)",
        statusNote: "使用 Notion Internal Integration Token 检索页面与数据库并导入本地 KB。",
        configured: Boolean(c.notion.token),
        enabled: c.notion.enabled,
      },
      {
        id: "notebooklm",
        name: "Gemini Notebook (NotebookLM)",
        strategy: "mcp_or_ui_bridge",
        strategyLabel: "MCP Bridge / 无障碍控屏协同",
        statusNote: "Google 暂无通用公开消费端 REST API；可通过外部 notebooklm-mcp 桥接或手机浏览器操作。",
        configured: Boolean(c.notebooklm.mcpEndpoint || c.notebooklm.notebookUrl),
        enabled: c.notebooklm.enabled,
      },
      {
        id: "ima",
        name: "腾讯 ima 知识库",
        strategy: "mcp_or_ui_bridge",
        strategyLabel: "MCP Bridge / 无障碍控屏协同",
        statusNote: "ima 暂无开放免鉴权 REST API；可通过开源 ima-kb-mcp 桥接服务或控屏查询。",
        configured: Boolean(c.ima.mcpEndpoint || c.ima.kbId),
        enabled: c.ima.enabled,
      },
      {
        id: "customBridge",
        name: "自定义网站 / MCP 桥接",
        strategy: "mcp_or_ui_bridge",
        strategyLabel: "HTTP Webhook / 远程服务接入",
        statusNote: "用于后续扩展个人网站、私有 NAS 或其他 MCP Server。",
        configured: Boolean(c.customBridge.endpoint),
        enabled: c.customBridge.enabled,
      },
    ];
  }

  updatePlatform<K extends keyof ConnectorsConfig>(platform: K, patch: Partial<ConnectorsConfig[K]>) {
    const cleanPatch: Record<string, any> = {};
    for (const [k, v] of Object.entries(patch as Record<string, any>)) {
      if (typeof v === "string" && (v.includes("***") || v.includes("..."))) continue;
      cleanPatch[k] = v;
    }
    this.config[platform] = {
      ...this.config[platform],
      ...cleanPatch,
    } as ConnectorsConfig[K];
    fs.writeFileSync(this.storePath, JSON.stringify(this.config, null, 2), "utf-8");
    return {
      catalog: this.getCatalog(),
      config: this.getMaskedConfig(),
    };
  }

  async testConnection(platform: keyof ConnectorsConfig): Promise<{ ok: boolean; message: string; details?: any }> {
    if (platform === "obsidian") {
      const { vaultPath, restApiUrl, restApiToken } = this.config.obsidian;
      if (restApiToken && restApiUrl) {
        try {
          const r = await fetch(`${restApiUrl.replace(/\/$/, "")}/vault/`, {
            headers: { Authorization: `Bearer ${restApiToken}` },
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) {
            const j: any = await r.json();
            return { ok: true, message: `Obsidian REST API 已连通，根目录含 ${j.files?.length ?? 0} 项。` };
          }
          return { ok: false, message: `Obsidian REST 返回 HTTP ${r.status}` };
        } catch (e: any) {
          return { ok: false, message: `Obsidian REST 连接失败: ${e?.message}` };
        }
      }
      if (vaultPath && fs.existsSync(vaultPath)) {
        const mdCount = fs.readdirSync(vaultPath).filter((f) => f.endsWith(".md")).length;
        return { ok: true, message: `本地 Obsidian Vault 路径存在，根目录发现 ${mdCount} 篇 .md 笔记。` };
      }
      return { ok: false, message: `未找到 Vault 路径 (${vaultPath}) 且未配置 REST API。` };
    }

    if (platform === "yuque") {
      if (!this.config.yuque.token) return { ok: false, message: "请先填入语雀 Personal Access Token。" };
      try {
        const r = await fetch(`${this.config.yuque.baseUrl.replace(/\/$/, "")}/user`, {
          headers: { "X-Auth-Token": this.config.yuque.token, "User-Agent": "CodePlant-MI14" },
          signal: AbortSignal.timeout(8000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, message: `语雀鉴权失败 (HTTP ${r.status}): ${j.message || ""}` };
        return { ok: true, message: `已连通语雀账号：${j.data?.name || j.data?.login || "OK"}` };
      } catch (e: any) {
        return { ok: false, message: `语雀请求失败: ${e?.message}` };
      }
    }

    if (platform === "feishu") {
      if (this.config.feishu.appId && this.config.feishu.appSecret) {
        try {
          const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              app_id: this.config.feishu.appId,
              app_secret: this.config.feishu.appSecret,
            }),
            signal: AbortSignal.timeout(8000),
          });
          const j: any = await r.json().catch(() => ({}));
          if (j.code !== 0) return { ok: false, message: `飞书 OpenAPI 错误 (${j.code}): ${j.msg || r.status}` };
          return { ok: true, message: `飞书 tenant_access_token 获取成功，有效期 ${j.expire ?? 7200}s。` };
        } catch (e: any) {
          return { ok: false, message: `飞书请求失败: ${e?.message}` };
        }
      }
      if (this.config.feishu.webhookUrl) {
        return { ok: true, message: "已配置飞书自定义群机器人 Webhook（可用于主动通知推送）。" };
      }
      return { ok: false, message: "请先填写飞书 App ID + App Secret 或群机器人 Webhook。" };
    }

    if (platform === "notion") {
      if (!this.config.notion.token) return { ok: false, message: "请先填入 Notion Integration Token。" };
      try {
        const r = await fetch("https://api.notion.com/v1/users/me", {
          headers: {
            Authorization: `Bearer ${this.config.notion.token}`,
            "Notion-Version": "2022-06-28",
          },
          signal: AbortSignal.timeout(8000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, message: `Notion 鉴权失败 (HTTP ${r.status}): ${j.message || ""}` };
        return { ok: true, message: `Notion 连通成功：Bot「${j.name || "Integration"}」` };
      } catch (e: any) {
        return { ok: false, message: `Notion 请求失败: ${e?.message}` };
      }
    }

    if (platform === "notebooklm") {
      if (this.config.notebooklm.mcpEndpoint) {
        return { ok: true, message: `已记录 NotebookLM MCP Bridge 地址：${this.config.notebooklm.mcpEndpoint}` };
      }
      return {
        ok: false,
        message: "NotebookLM 暂无官方公开消费端 API，建议填写本地/远程 notebooklm-mcp 桥接地址或使用控屏操作。",
      };
    }

    if (platform === "ima") {
      if (this.config.ima.mcpEndpoint) {
        return { ok: true, message: `已记录腾讯 ima MCP Bridge 地址：${this.config.ima.mcpEndpoint}` };
      }
      return {
        ok: false,
        message: "腾讯 ima 暂无开放 REST OpenAPI，建议配合 ima-kb-mcp 桥接或启用控屏自动化检索。",
      };
    }

    if (this.config.customBridge.endpoint) {
      try {
        const r = await fetch(this.config.customBridge.endpoint, {
          headers: this.config.customBridge.token
            ? { Authorization: `Bearer ${this.config.customBridge.token}` }
            : undefined,
          signal: AbortSignal.timeout(6000),
        });
        return { ok: r.ok, message: `自定义桥接响应 HTTP ${r.status}` };
      } catch (e: any) {
        return { ok: false, message: `自定义桥接不可达: ${e?.message}` };
      }
    }
    return { ok: false, message: "请先填写自定义桥接端点 URL。" };
  }

  async syncToLocalKb(platform: "obsidian" | "yuque" | "notion"): Promise<{ imported: number; message: string }> {
    if (platform === "obsidian") {
      const vp = this.config.obsidian.vaultPath;
      if (!vp || !fs.existsSync(vp)) {
        return { imported: 0, message: `Obsidian Vault 路径不可用: ${vp}` };
      }
      const files = fs.readdirSync(vp).filter((f) => f.endsWith(".md")).slice(0, 40);
      let imported = 0;
      for (const file of files) {
        const body = fs.readFileSync(path.join(vp, file), "utf-8");
        this.kb.saveNote({
          id: `obs-${path.basename(file, ".md")}`,
          title: path.basename(file, ".md"),
          tags: ["Obsidian"],
          source: "obsidian",
          content: body,
        });
        imported++;
      }
      return { imported, message: `已从 Obsidian Vault 导入 ${imported} 篇 Markdown 笔记到本地 KB。` };
    }

    if (platform === "yuque") {
      if (!this.config.yuque.token) return { imported: 0, message: "未配置语雀 Token" };
      const base = this.config.yuque.baseUrl.replace(/\/$/, "");
      const headers = { "X-Auth-Token": this.config.yuque.token, "User-Agent": "CodePlant-MI14" };
      const uRes = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(8000) });
      const uJson: any = await uRes.json();
      const login = uJson.data?.login;
      if (!login) return { imported: 0, message: "获取语雀用户信息失败" };
      const reposRes = await fetch(`${base}/users/${login}/repos`, { headers, signal: AbortSignal.timeout(8000) });
      const reposJson: any = await reposRes.json();
      const repos: any[] = (reposJson.data ?? []).slice(0, 3);
      let imported = 0;
      for (const repo of repos) {
        const docsRes = await fetch(`${base}/repos/${repo.namespace}/docs`, { headers, signal: AbortSignal.timeout(8000) });
        const docsJson: any = await docsRes.json();
        for (const doc of (docsJson.data ?? []).slice(0, 8)) {
          this.kb.saveNote({
            id: `yuque-${repo.id}-${doc.slug}`,
            title: String(doc.title || doc.slug),
            tags: ["语雀", String(repo.name || "知识库")],
            source: "yuque",
            content: `${doc.description || ""}\n\n原文链接: https://www.yuque.com/${repo.namespace}/${doc.slug}`,
          });
          imported++;
        }
      }
      return { imported, message: `已从语雀同步 ${imported} 条文档索引到本地 KB。` };
    }

    if (!this.config.notion.token) return { imported: 0, message: "未配置 Notion Token" };
    const nRes = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.notion.token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 12 }),
      signal: AbortSignal.timeout(8000),
    });
    const nJson: any = await nRes.json();
    if (!nRes.ok) return { imported: 0, message: `Notion 检索失败: ${nJson.message || nRes.status}` };
    let imported = 0;
    for (const item of nJson.results ?? []) {
      const titleProp = Object.values(item.properties ?? {}).find((p: any) => p?.type === "title") as any;
      const title = titleProp?.title?.map((t: any) => t.plain_text).join("") || item.id;
      this.kb.saveNote({
        id: `notion-${String(item.id).replace(/-/g, "").slice(0, 12)}`,
        title,
        tags: ["Notion", String(item.object || "page")],
        source: "notion",
        content: `Notion 节点 ID: \`${item.id}\`\n\nURL: ${item.url || "无"}`,
      });
      imported++;
    }
    return { imported, message: `已从 Notion 同步 ${imported} 个页面索引到本地 KB。` };
  }
}
