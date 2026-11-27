import fs from "node:fs";
import path from "node:path";

export interface KbNoteMeta {
  id: string;
  title: string;
  tags: string[];
  source: string;
  updatedAt: string;
  preview: string;
  charCount: number;
}

export interface KbNote extends KbNoteMeta {
  content: string;
  filePath: string;
}

export interface KbSearchHit extends KbNoteMeta {
  score: number;
  snippet: string;
}

function slugify(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || `note-${Date.now()}`;
}

export class KbStore {
  private readonly kbDir: string;

  constructor(dataDir: string) {
    this.kbDir = path.join(dataDir, "kb");
    fs.mkdirSync(this.kbDir, { recursive: true });
    this.ensureStarterNote();
  }

  private ensureStarterNote() {
    const files = fs.readdirSync(this.kbDir).filter((f) => f.endsWith(".md"));
    if (files.length > 0) return;
    this.saveNote({
      id: "welcome-kb",
      title: "CodePlant 个人知识库使用说明",
      tags: ["指南", "知识库", "桥接"],
      source: "local",
      content: [
        "# CodePlant 个人知识库",
        "",
        "这里存放你在 MI14 本地沉淀的 Markdown 笔记、网页/秘塔 AI 检索导出资料，以及从 **Obsidian / 语雀 / Notion / 飞书** 同步下来的知识条目。",
        "",
        "- Agent 对话时会自动检索匹配度最高的本地知识库摘要并注入上下文。",
        "- 你也可以直接对 Agent 说：`把刚才搜索的资料存进知识库` 或 `在知识库里查一下 xxx`。",
        "- 已支持原生 API 对接平台：Obsidian（本地 Vault 或 Local REST API）、语雀（v2 Token）、Notion（Integration Token）、飞书（App ID/Secret）。",
        "- 扩展桥接平台：Google Gemini Notebook (NotebookLM) 与腾讯 ima 通过 MCP Bridge / 控屏方式协同。",
      ].join("\n"),
    });
  }

  private parseFile(filePath: string): KbNote {
    const raw = fs.readFileSync(filePath, "utf-8");
    const fileId = path.basename(filePath, ".md");
    let title = fileId;
    let tags: string[] = [];
    let source = "local";
    let updatedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString();
    let body = raw;

    if (raw.startsWith("---\n")) {
      const end = raw.indexOf("\n---\n", 4);
      if (end > 0) {
        const front = raw.slice(4, end).split("\n");
        body = raw.slice(end + 5);
        for (const line of front) {
          const idx = line.indexOf(":");
          if (idx <= 0) continue;
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k === "title" && v) title = v;
          else if (k === "source" && v) source = v;
          else if (k === "updatedAt" && v) updatedAt = v;
          else if (k === "tags" && v) {
            tags = v
              .replace(/^\[|\]$/g, "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          }
        }
      }
    } else {
      const firstH1 = raw.match(/^#\s+(.+)$/m);
      if (firstH1?.[1]) title = firstH1[1].trim();
    }

    const plain = body.replace(/\s+/g, " ").trim();
    return {
      id: fileId,
      title,
      tags,
      source,
      updatedAt,
      preview: plain.slice(0, 140),
      charCount: body.length,
      content: body.trim(),
      filePath,
    };
  }

  listNotes(): KbNoteMeta[] {
    if (!fs.existsSync(this.kbDir)) return [];
    return fs
      .readdirSync(this.kbDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => this.parseFile(path.join(this.kbDir, f)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ content: _c, filePath: _p, ...meta }) => meta);
  }

  getNote(id: string): KbNote | null {
    const safeId = path.basename(id, ".md").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "");
    if (!safeId) return null;
    const fp = path.join(this.kbDir, `${safeId}.md`);
    if (!fs.existsSync(fp)) return null;
    return this.parseFile(fp);
  }

  saveNote(input: {
    id?: string;
    title: string;
    content: string;
    tags?: string[];
    source?: string;
  }): KbNote {
    const title = input.title.trim() || "未命名笔记";
    const id = input.id ? slugify(input.id) : slugify(title);
    const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);
    const source = (input.source || "local").trim();
    const updatedAt = new Date().toISOString();

    const frontmatter = [
      "---",
      `title: ${title.replace(/\r?\n/g, " ")}`,
      `source: ${source}`,
      `tags: [${tags.join(", ")}]`,
      `updatedAt: ${updatedAt}`,
      "---",
      "",
    ].join("\n");

    const fp = path.join(this.kbDir, `${id}.md`);
    fs.writeFileSync(fp, `${frontmatter}${input.content.trim()}\n`, "utf-8");
    return this.parseFile(fp);
  }

  deleteNote(id: string): boolean {
    const safeId = path.basename(id, ".md").replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "");
    if (!safeId) return false;
    const fp = path.join(this.kbDir, `${safeId}.md`);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  searchNotes(query: string, limit = 5): KbSearchHit[] {
    const q = query.trim().toLowerCase();
    const tokens = q.split(/[\s,，。；;]+/).filter((t) => t.length >= 2);
    const files = fs.readdirSync(this.kbDir).filter((f) => f.endsWith(".md"));

    const hits: KbSearchHit[] = [];
    for (const f of files) {
      const note = this.parseFile(path.join(this.kbDir, f));
      const haystackTitle = note.title.toLowerCase();
      const haystackTags = note.tags.join(" ").toLowerCase();
      const haystackBody = note.content.toLowerCase();

      let score = 0;
      if (!q) {
        score = 1;
      } else {
        if (haystackTitle.includes(q)) score += 10;
        if (haystackBody.includes(q)) score += 6;
        for (const tk of tokens) {
          if (haystackTitle.includes(tk)) score += 4;
          if (haystackTags.includes(tk)) score += 3;
          if (haystackBody.includes(tk)) score += 1.5;
        }
      }
      if (score <= 0) continue;

      let snippet = note.preview;
      if (q) {
        const pos = haystackBody.indexOf(tokens[0] || q);
        if (pos >= 0) {
          const start = Math.max(0, pos - 40);
          snippet = note.content.slice(start, start + 180).replace(/\s+/g, " ");
        }
      }

      const { content: _c, filePath: _p, ...meta } = note;
      hits.push({ ...meta, score, snippet });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  buildPromptContext(userQuery: string, limit = 3): string {
    const hits = this.searchNotes(userQuery, limit);
    if (hits.length === 0) return "";
    return hits
      .map((h, i) => `${i + 1}. 《${h.title}》 [来源:${h.source}]：${h.snippet}`)
      .join("\n");
  }
}
