import fs from "node:fs";
import path from "node:path";

export interface SharedPortRule {
  name: string;
  localPort: number;
  protocol: "http" | "ws" | "tcp";
  publicUrl: string;
  enabled: boolean;
  note: string;
}

export interface NetworkBridgeConfig {
  listenHost: "127.0.0.1" | "0.0.0.0";
  listenPort: number;
  publicBaseUrl: string;
  corsOrigins: string[];
  bridgeBearerToken: string;
  outboundWebhookUrl: string;
  sharedPorts: SharedPortRule[];
}

const DEFAULT_BRIDGE_CONFIG: NetworkBridgeConfig = {
  listenHost: (process.env.SERVER_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"),
  listenPort: Number(process.env.SERVER_PORT || 8787),
  publicBaseUrl: "",
  corsOrigins: ["*"],
  bridgeBearerToken: process.env.BRIDGE_BEARER_TOKEN || "",
  outboundWebhookUrl: "",
  sharedPorts: [
    {
      name: "CodePlant Web 控制台 / Bridge API",
      localPort: Number(process.env.SERVER_PORT || 8787),
      protocol: "http",
      publicUrl: "",
      enabled: true,
      note: "供本机浏览器、局域网设备或个人网站通过 /api/bridge/* 接入",
    },
    {
      name: "Android Portal 无障碍服务",
      localPort: 18788,
      protocol: "http",
      publicUrl: "",
      enabled: true,
      note: "仅限手机本机回环通讯，不建议直接公网暴露",
    },
  ],
};

export class NetworkBridgeManager {
  private config: NetworkBridgeConfig = structuredClone(DEFAULT_BRIDGE_CONFIG);
  private readonly storePath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.storePath = path.join(dataDir, "network-bridge.json");
    if (fs.existsSync(this.storePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
        this.config = {
          ...DEFAULT_BRIDGE_CONFIG,
          ...saved,
          corsOrigins: Array.isArray(saved.corsOrigins) ? saved.corsOrigins : DEFAULT_BRIDGE_CONFIG.corsOrigins,
          sharedPorts: Array.isArray(saved.sharedPorts) ? saved.sharedPorts : DEFAULT_BRIDGE_CONFIG.sharedPorts,
        };
      } catch {
        // ignore corrupt file
      }
    }
  }

  getConfigMasked() {
    return {
      ...this.config,
      bridgeBearerToken: this.config.bridgeBearerToken
        ? `${this.config.bridgeBearerToken.slice(0, 4)}***${this.config.bridgeBearerToken.slice(-2)}`
        : "",
      hasBridgeToken: Boolean(this.config.bridgeBearerToken),
    };
  }

  getRawConfig(): NetworkBridgeConfig {
    return structuredClone(this.config);
  }

  updateConfig(patch: Partial<NetworkBridgeConfig>) {
    const nextToken =
      typeof patch.bridgeBearerToken === "string" && patch.bridgeBearerToken.includes("***")
        ? this.config.bridgeBearerToken
        : patch.bridgeBearerToken !== undefined
          ? patch.bridgeBearerToken.trim()
          : this.config.bridgeBearerToken;

    this.config = {
      ...this.config,
      ...patch,
      listenHost: patch.listenHost === "0.0.0.0" ? "0.0.0.0" : this.config.listenHost === "0.0.0.0" && patch.listenHost === undefined ? "0.0.0.0" : patch.listenHost ?? "127.0.0.1",
      listenPort: Math.max(1024, Math.min(65535, Number(patch.listenPort ?? this.config.listenPort))),
      bridgeBearerToken: nextToken,
      corsOrigins: Array.isArray(patch.corsOrigins) ? patch.corsOrigins : this.config.corsOrigins,
      sharedPorts: Array.isArray(patch.sharedPorts) ? patch.sharedPorts : this.config.sharedPorts,
    };
    fs.writeFileSync(this.storePath, JSON.stringify(this.config, null, 2), "utf-8");
    return this.getConfigMasked();
  }

  resolveCorsHeader(requestOrigin?: string): string | null {
    if (this.config.corsOrigins.includes("*")) return "*";
    if (requestOrigin && this.config.corsOrigins.includes(requestOrigin)) return requestOrigin;
    return null;
  }

  verifyBridgeAuth(authHeader?: string): boolean {
    const token = this.config.bridgeBearerToken.trim();
    if (!token) return true;
    return authHeader === `Bearer ${token}`;
  }

  async forwardOutbound(event: string, payload: unknown): Promise<void> {
    const url = this.config.outboundWebhookUrl.trim();
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ts: new Date().toISOString(), payload }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}
