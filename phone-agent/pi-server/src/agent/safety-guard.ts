import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface WeChatPolicy {
  autoReplyEnabled: boolean;
  replyWhitelist: string[];
  videoWhitelist: string[];
  requireVideoConfirmationEvenInWhitelist: boolean;
}

export interface PendingConfirmation {
  id: string;
  actionType: "wechat_video_call" | "wechat_reply" | "sensitive_tap";
  title: string;
  detail: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface SafetyConfig {
  maxStepsPerRun: number;
  wechat: WeChatPolicy;
}

const DEFAULT_SAFETY: SafetyConfig = {
  maxStepsPerRun: 25,
  wechat: {
    autoReplyEnabled: true,
    replyWhitelist: ["文件传输助手"],
    videoWhitelist: [],
    requireVideoConfirmationEvenInWhitelist: true,
  },
};

export class SafetyGuard {
  private config: SafetyConfig = DEFAULT_SAFETY;
  private readonly configPath: string;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly waiters = new Map<string, (allow: boolean) => void>();

  constructor(
    dataDir: string,
    private readonly onNotifyConfirm?: (item: PendingConfirmation) => Promise<void>,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.configPath = path.join(dataDir, "safety-policy.json");
    if (fs.existsSync(this.configPath)) {
      try {
        this.config = { ...DEFAULT_SAFETY, ...JSON.parse(fs.readFileSync(this.configPath, "utf-8")) };
      } catch {
        this.config = DEFAULT_SAFETY;
      }
    } else {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
    }
  }

  getConfig(): SafetyConfig {
    return structuredClone(this.config);
  }

  updateConfig(patch: Partial<SafetyConfig>) {
    this.config = {
      ...this.config,
      ...patch,
      wechat: {
        ...this.config.wechat,
        ...(patch.wechat ?? {}),
      },
    };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  isWeChatReplyAllowed(contact: string): boolean {
    if (!this.config.wechat.autoReplyEnabled) return false;
    return this.config.wechat.replyWhitelist.some(
      (name) => name.trim() !== "" && contact.includes(name.trim()),
    );
  }

  canVideoCallWithoutConfirm(contact: string): boolean {
    if (this.config.wechat.requireVideoConfirmationEvenInWhitelist) return false;
    return this.config.wechat.videoWhitelist.some(
      (name) => name.trim() !== "" && contact.includes(name.trim()),
    );
  }

  listPending(): PendingConfirmation[] {
    return [...this.pending.values()].filter((x) => x.status === "pending");
  }

  resolve(id: string, allow: boolean): boolean {
    const item = this.pending.get(id);
    if (!item || item.status !== "pending") return false;
    item.status = allow ? "approved" : "rejected";
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.(allow);
    return true;
  }

  async requestConfirmation(
    actionType: PendingConfirmation["actionType"],
    title: string,
    detail: string,
    timeoutMs = 60_000,
  ): Promise<boolean> {
    const item: PendingConfirmation = {
      id: crypto.randomUUID(),
      actionType,
      title,
      detail,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.pending.set(item.id, item);

    if (this.onNotifyConfirm) {
      await this.onNotifyConfirm(item).catch(() => {});
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (item.status === "pending") {
          item.status = "expired";
          this.waiters.delete(item.id);
          resolve(false);
        }
      }, timeoutMs);

      this.waiters.set(item.id, (allow) => {
        clearTimeout(timer);
        resolve(allow);
      });
    });
  }
}
