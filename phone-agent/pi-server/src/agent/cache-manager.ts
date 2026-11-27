import fs from "node:fs";
import path from "node:path";
import type { CacheRetention, Model } from "@earendil-works/pi-ai";

export type CacheTier = "low" | "medium" | "high";

export interface PromptCacheConfig {
  tier: CacheTier;
  minPrefixTokens: number;
  stablePrefixAnchor: boolean;
  batchHoldTurns: number;
}

export interface CacheTelemetryStats {
  requests: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  lastHitRatePercent: number;
  overallHitRatePercent: number;
}

export interface ModelCacheRecommendation {
  supported: boolean;
  recommendedTier: CacheTier;
  recommendedMinTokens: number;
  note: string;
}

const TIER_DEFAULTS: Record<CacheTier, Omit<PromptCacheConfig, "tier">> = {
  low: { minPrefixTokens: 1024, stablePrefixAnchor: true, batchHoldTurns: 4 },
  medium: { minPrefixTokens: 2048, stablePrefixAnchor: true, batchHoldTurns: 8 },
  high: { minPrefixTokens: 4096, stablePrefixAnchor: true, batchHoldTurns: 14 },
};

export function getModelCacheRecommendation(modelId: string, providerId: string): ModelCacheRecommendation {
  const id = modelId.toLowerCase();
  const prov = providerId.toLowerCase();

  if (id.includes("claude") || prov.includes("anthropic")) {
    return {
      supported: true,
      recommendedTier: "high",
      recommendedMinTokens: 2048,
      note: "Claude 原生支持显式断点缓存（300s/3600s），建议 ≥1024~2048 tokens 固定前缀，命中后读取成本约 0.1x。",
    };
  }
  if (id.includes("deepseek") || prov.includes("deepseek")) {
    return {
      supported: true,
      recommendedTier: "high",
      recommendedMinTokens: 1024,
      note: "DeepSeek 支持服务端自动前缀缓存（按 64-token 块匹配），推荐高命中锁定前缀，cacheRead 低至约 1/50。",
    };
  }
  if (id.includes("gpt") || id.includes("codex") || id.includes("o3") || id.includes("o4") || prov.includes("openai")) {
    return {
      supported: true,
      recommendedTier: "medium",
      recommendedMinTokens: 1024,
      note: "OpenAI 系列在前缀 ≥1024 tokens 时自动触发 Prompt Cache，推荐中档命中（保留 8 轮稳定前缀）。",
    };
  }
  if (id.includes("gemini") || prov.includes("google")) {
    return {
      supported: true,
      recommendedTier: "medium",
      recommendedMinTokens: 2048,
      note: "Gemini 支持隐式前缀缓存（≥2048 tokens 起效更稳定），推荐中档并保持系统指令与知识库摘要前置。",
    };
  }
  if (id.includes("qwen") || id.includes("glm")) {
    return {
      supported: true,
      recommendedTier: "medium",
      recommendedMinTokens: 1024,
      note: "百炼 Qwen / 智谱 GLM 商业线支持前缀缓存；部分免费 Flash 渠道不返还 cached_tokens 统计，属于正常现象。",
    };
  }
  return {
    supported: false,
    recommendedTier: "low",
    recommendedMinTokens: 1024,
    note: "未知第三方中转/开源端点，建议先设为低/中命中并观察下方实测 cacheRead 数值。",
  };
}

export class PromptCacheManager {
  private config: PromptCacheConfig = {
    tier: "medium",
    ...TIER_DEFAULTS.medium,
  };
  private stats: CacheTelemetryStats = {
    requests: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    lastHitRatePercent: 0,
    overallHitRatePercent: 0,
  };
  private readonly storePath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.storePath = path.join(dataDir, "cache-config.json");
    if (fs.existsSync(this.storePath)) {
      try {
        this.config = { ...this.config, ...JSON.parse(fs.readFileSync(this.storePath, "utf-8")) };
      } catch {
        // ignore corrupt file
      }
    }
  }

  getConfig(): PromptCacheConfig {
    return { ...this.config };
  }

  getStats(): CacheTelemetryStats {
    return { ...this.stats };
  }

  updateConfig(patch: Partial<PromptCacheConfig>): PromptCacheConfig {
    if (patch.tier && patch.tier !== this.config.tier && patch.minPrefixTokens === undefined) {
      this.config = { tier: patch.tier, ...TIER_DEFAULTS[patch.tier], ...patch };
    } else {
      this.config = {
        ...this.config,
        ...patch,
        minPrefixTokens: Math.max(256, Math.min(32768, Number(patch.minPrefixTokens ?? this.config.minPrefixTokens))),
        batchHoldTurns: Math.max(2, Math.min(30, Number(patch.batchHoldTurns ?? this.config.batchHoldTurns))),
      };
    }
    fs.writeFileSync(this.storePath, JSON.stringify(this.config, null, 2), "utf-8");
    return this.getConfig();
  }

  toPiCacheRetention(): CacheRetention {
    if (this.config.tier === "low") return "none";
    if (this.config.tier === "high") return "long";
    return "short";
  }

  /**
   * Records real token usage emitted by pi-ai assistant messages (`usage.input`, `usage.cacheRead`, `usage.cacheWrite`).
   */
  recordUsage(usage?: { input?: number; cacheRead?: number; cacheWrite?: number }) {
    if (!usage) return;
    const input = Number(usage.input ?? 0);
    const read = Number(usage.cacheRead ?? 0);
    const write = Number(usage.cacheWrite ?? 0);
    if (input + read + write <= 0) return;

    this.stats.requests++;
    this.stats.totalInputTokens += input;
    this.stats.totalCacheReadTokens += read;
    this.stats.totalCacheWriteTokens += write;

    const turnDenom = input + read;
    this.stats.lastHitRatePercent = turnDenom > 0 ? Math.round((read / turnDenom) * 100) : 0;
    const totalDenom = this.stats.totalInputTokens + this.stats.totalCacheReadTokens;
    this.stats.overallHitRatePercent =
      totalDenom > 0 ? Math.round((this.stats.totalCacheReadTokens / totalDenom) * 100) : 0;
  }

  describeModelHint(model?: Model<any>) {
    if (!model) return null;
    return getModelCacheRecommendation(model.id, model.provider);
  }
}
