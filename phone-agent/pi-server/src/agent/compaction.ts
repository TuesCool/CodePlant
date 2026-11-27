import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";

export interface CompactionStatus {
  estimatedTokens: number;
  contextWindow: number;
  percent: number;
  thresholdPercent: number;
  compactionCount: number;
  summaryPreview: string;
}

const SCREEN_MARKER = "Screen now:";

/**
 * Fast bilingual token estimator (CJK ~1.5 chars/token, Latin ~4 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
  }
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}

export function extractPlainText(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((part: any) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image") return "[image ~1200 tokens]";
      if (part?.type === "toolCall") return `${part.name}(${JSON.stringify(part.arguments ?? {})})`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Tier-1 lossless-for-planning pruning:
 * Keeps only the latest `keepTrees` screen trees and `keepImages` screenshots
 * before sending context to the model, avoiding immediate token blowup during multi-step taps.
 */
export function pruneOldPhonePerceptions(
  messages: AgentMessage[],
  keepTrees = 2,
  keepImages = 1,
): AgentMessage[] {
  const treeIndexes: number[] = [];
  const imageIndexes: number[] = [];

  messages.forEach((m: any, idx) => {
    const text = extractPlainText(m);
    if (m.role === "toolResult" && (text.includes(SCREEN_MARKER) || m.toolName === "phone_get_screen")) {
      treeIndexes.push(idx);
    }
    if (Array.isArray(m.content) && m.content.some((c: any) => c?.type === "image")) {
      imageIndexes.push(idx);
    }
  });

  const dropTreeSet = new Set(treeIndexes.slice(0, Math.max(0, treeIndexes.length - keepTrees)));
  const dropImageSet = new Set(imageIndexes.slice(0, Math.max(0, imageIndexes.length - keepImages)));
  if (dropTreeSet.size === 0 && dropImageSet.size === 0) return messages;

  return messages.map((m: any, idx) => {
    if (!dropTreeSet.has(idx) && !dropImageSet.has(idx)) return m;
    if (!Array.isArray(m.content)) {
      return dropTreeSet.has(idx)
        ? { ...m, content: "[旧屏幕控件树已折叠]" }
        : m;
    }
    const nextContent = m.content.map((part: any) => {
      if (dropImageSet.has(idx) && part?.type === "image") {
        return { type: "text", text: "[旧截图已裁剪以节省上下文]" };
      }
      if (dropTreeSet.has(idx) && part?.type === "text") {
        const text = String(part.text ?? "");
        const cut = text.indexOf(SCREEN_MARKER);
        const brief = cut >= 0 ? `${text.slice(0, cut)}\n[旧控件树已折叠]` : `[旧屏幕感知输出已折叠]`;
        return { type: "text", text: brief };
      }
      return part;
    });
    return { ...m, content: nextContent };
  });
}

/**
 * Tier-2 rolling summarization + JSONL archiving when estimated usage crosses `thresholdPercent`.
 */
export class RollingCompactor {
  private rollingSummary = "";
  private compactionCount = 0;
  private readonly archivePath: string;

  constructor(
    dataDir: string,
    private readonly thresholdPercent = 75,
    private readonly keepRecentMessages = 6,
  ) {
    const archiveDir = path.join(dataDir, "archives");
    fs.mkdirSync(archiveDir, { recursive: true });
    this.archivePath = path.join(archiveDir, "session-history.jsonl");
  }

  getSummary(): string {
    return this.rollingSummary;
  }

  estimateStatus(messages: AgentMessage[], systemPrompt: string, contextWindow: number): CompactionStatus {
    const pruned = pruneOldPhonePerceptions(messages);
    let total = estimateTokens(systemPrompt) + estimateTokens(this.rollingSummary);
    for (const m of pruned) {
      total += estimateTokens(extractPlainText(m)) + 8;
    }
    const safeWindow = Math.max(8_000, contextWindow || 128_000);
    const percent = Math.min(100, Math.round((total / safeWindow) * 100));
    return {
      estimatedTokens: total,
      contextWindow: safeWindow,
      percent,
      thresholdPercent: this.thresholdPercent,
      compactionCount: this.compactionCount,
      summaryPreview: this.rollingSummary.slice(0, 400),
    };
  }

  async compactIfNeeded(
    messages: AgentMessage[],
    systemPrompt: string,
    summaryModel: Model<any>,
    models?: Models,
    force = false,
    keepRecentOverride?: number,
  ): Promise<{ messages: AgentMessage[]; compacted: boolean; status: CompactionStatus }> {
    const keepRecent = Math.max(2, keepRecentOverride ?? this.keepRecentMessages);
    const status = this.estimateStatus(messages, systemPrompt, summaryModel.contextWindow);
    if (!force && (status.percent < this.thresholdPercent || messages.length <= keepRecent + 2)) {
      return { messages: pruneOldPhonePerceptions(messages), compacted: false, status };
    }

    const splitIdx = Math.max(0, messages.length - keepRecent);
    const head = pruneOldPhonePerceptions(messages.slice(0, splitIdx), 0, 0);
    const tail = pruneOldPhonePerceptions(messages.slice(splitIdx), 2, 1);

    if (head.length === 0) {
      return { messages: tail, compacted: false, status };
    }

    // Archive raw dropped messages to disk so nothing is permanently lost
    const lines = head.map((m) => JSON.stringify({ ts: new Date().toISOString(), msg: m })).join("\n") + "\n";
    fs.appendFileSync(this.archivePath, lines, "utf-8");

    const excerpt = head
      .map((m: any) => `[${m.role}] ${extractPlainText(m)}`)
      .join("\n---\n")
      .slice(0, 14_000);

    let nextSummary = "";
    try {
      if (models) {
        const stream = await models.streamSimple(summaryModel, {
          systemPrompt:
            "你是手机 Agent 的上下文滚动压缩器。请把历史滚动摘要与新增对话合并成精炼中文摘要，务必保留：1) 用户核心目标与约束；2) 已完成的手机操作或信息结论；3) 未完成事项与关键联系人/文件路径。控制在 500 字以内。",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `【既有滚动摘要】\n${this.rollingSummary || "无"}\n\n【待压缩对话】\n${excerpt}`,
                },
              ],
              timestamp: Date.now(),
            },
          ],
        });
        for await (const ev of stream) {
          if (ev.type === "text_delta" && ev.delta) {
            nextSummary += ev.delta;
          }
        }
        nextSummary = nextSummary.trim();
      }
    } catch {
      nextSummary = "";
    }
    if (!nextSummary) {
      nextSummary = `${this.rollingSummary ? this.rollingSummary + "\n" : ""}[自动兜底摘录] ${excerpt.slice(0, 800)}`;
    }

    this.rollingSummary = nextSummary;
    this.compactionCount++;

    const summaryMsg: any = {
      role: "user",
      content: [{ type: "text", text: `【上下文滚动压缩摘要 #${this.compactionCount}】\n${this.rollingSummary}` }],
      timestamp: Date.now(),
    };
    const nextMessages = [summaryMsg, ...tail];
    const nextStatus = this.estimateStatus(nextMessages, systemPrompt, summaryModel.contextWindow);
    return { messages: nextMessages, compacted: true, status: nextStatus };
  }
}
