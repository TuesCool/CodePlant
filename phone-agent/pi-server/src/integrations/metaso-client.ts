import fs from "node:fs";
import path from "node:path";

export type MetasoScope = "webpage" | "document" | "scholar";

export interface MetasoConfig {
  apiKey: string;
  baseUrl: string;
  defaultScope: MetasoScope;
}

export interface MetasoItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface MetasoSearchResult {
  ok: boolean;
  query: string;
  scope: MetasoScope;
  answer?: string;
  items: MetasoItem[];
  markdownFile?: string;
  jsonFile?: string;
  downloadUrl?: string;
  error?: string;
}

export interface DownloadFileEntry {
  name: string;
  sizeBytes: number;
  updatedAt: string;
  downloadUrl: string;
}

const DEFAULT_METASO_CONFIG: MetasoConfig = {
  apiKey: process.env.METASO_API_KEY || "",
  baseUrl: process.env.METASO_BASE_URL || "https://metaso.cn/api/v1/search",
  defaultScope: "webpage",
};

export class MetasoClient {
  private config: MetasoConfig = { ...DEFAULT_METASO_CONFIG };
  private readonly configPath: string;
  private readonly downloadsDir: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.configPath = path.join(dataDir, "metaso-config.json");
    this.downloadsDir = path.join(dataDir, "downloads");
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    if (fs.existsSync(this.configPath)) {
      try {
        this.config = { ...this.config, ...JSON.parse(fs.readFileSync(this.configPath, "utf-8")) };
      } catch {
        // ignore corrupt config
      }
    }
  }

  getConfigMasked() {
    return {
      configured: Boolean(this.config.apiKey.trim()),
      apiKeyMasked: this.config.apiKey
        ? `${this.config.apiKey.slice(0, 6)}...${this.config.apiKey.slice(-4)}`
        : "",
      baseUrl: this.config.baseUrl,
      defaultScope: this.config.defaultScope,
    };
  }

  updateConfig(patch: Partial<MetasoConfig>) {
    this.config = {
      ...this.config,
      ...patch,
      baseUrl: String(patch.baseUrl ?? this.config.baseUrl).trim() || DEFAULT_METASO_CONFIG.baseUrl,
      apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : this.config.apiKey,
      defaultScope: patch.defaultScope ?? this.config.defaultScope,
    };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    return this.getConfigMasked();
  }

  listDownloads(): DownloadFileEntry[] {
    if (!fs.existsSync(this.downloadsDir)) return [];
    return fs
      .readdirSync(this.downloadsDir)
      .filter((f) => /\.(md|json|txt)$/i.test(f))
      .map((name) => {
        const st = fs.statSync(path.join(this.downloadsDir, name));
        return {
          name,
          sizeBytes: st.size,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          downloadUrl: `/api/downloads/${encodeURIComponent(name)}`,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  resolveDownloadPath(rawName: string): string | null {
    const safeName = path.basename(decodeURIComponent(rawName));
    if (!safeName || safeName !== rawName && encodeURIComponent(safeName) !== rawName && safeName !== decodeURIComponent(rawName)) {
      return null;
    }
    const full = path.resolve(this.downloadsDir, safeName);
    if (!full.startsWith(path.resolve(this.downloadsDir))) return null;
    return fs.existsSync(full) ? full : null;
  }

  async searchAndExport(
    query: string,
    scope: MetasoScope = this.config.defaultScope,
    size = 10,
  ): Promise<MetasoSearchResult> {
    const q = query.trim();
    if (!q) {
      return { ok: false, query: q, scope, items: [], error: "请输入搜索关键词" };
    }
    if (!this.config.apiKey.trim()) {
      return {
        ok: false,
        query: q,
        scope,
        items: [],
        error: "尚未配置秘塔 AI API Key。请在 02 控屏·搜索 或 04 配置 页填入 METASO_API_KEY 后即可联网检索并导出下载。",
      };
    }

    try {
      const res = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.config.apiKey.trim()}`,
        },
        body: JSON.stringify({
          q,
          scope,
          includeSummary: true,
          size: Math.max(3, Math.min(20, size)),
        }),
        signal: AbortSignal.timeout(18_000),
      });

      const rawText = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          query: q,
          scope,
          items: [],
          error: `秘塔 API 请求失败 (HTTP ${res.status}): ${rawText.slice(0, 240)}`,
        };
      }

      const json = JSON.parse(rawText);
      const rawItems: any[] = json.webpages ?? json.documents ?? json.results ?? json.data?.webpages ?? [];
      const items: MetasoItem[] = rawItems.slice(0, size).map((it) => ({
        title: String(it.title ?? it.name ?? "无标题"),
        url: String(it.link ?? it.url ?? ""),
        snippet: String(it.snippet ?? it.summary ?? it.content ?? "").slice(0, 360),
        score: typeof it.score === "number" ? it.score : undefined,
      }));
      const answer = String(json.summary ?? json.answer ?? json.data?.summary ?? "").trim();

      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const slug = q.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 24) || "query";
      const mdName = `metaso_${stamp}_${slug}.md`;
      const jsonName = `metaso_${stamp}_${slug}.json`;

      const mdLines = [
        `# 秘塔 AI 检索报告：${q}`,
        "",
        `- 检索域: \`${scope}\``,
        `- 时间: ${new Date().toISOString()}`,
        `- 命中条数: ${items.length}`,
        "",
        answer ? `## AI 综合摘要\n\n${answer}\n` : "",
        "## 原始来源列表",
        "",
        ...items.map(
          (item, i) =>
            `### ${i + 1}. ${item.title}\n- 链接: ${item.url || "无"}\n- 摘要: ${item.snippet || "无"}\n`,
        ),
      ]
        .filter(Boolean)
        .join("\n");

      fs.writeFileSync(path.join(this.downloadsDir, mdName), mdLines, "utf-8");
      fs.writeFileSync(path.join(this.downloadsDir, jsonName), JSON.stringify(json, null, 2), "utf-8");

      return {
        ok: true,
        query: q,
        scope,
        answer: answer || undefined,
        items,
        markdownFile: mdName,
        jsonFile: jsonName,
        downloadUrl: `/api/downloads/${encodeURIComponent(mdName)}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        query: q,
        scope,
        items: [],
        error: `秘塔检索请求异常: ${err?.message ?? String(err)}`,
      };
    }
  }
}
