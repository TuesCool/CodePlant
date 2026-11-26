export interface PortalHealth {
  ok: boolean;
  accessibilityConnected: boolean;
  shizukuReady: boolean;
  notificationListenerConnected: boolean;
  foregroundPackage: string;
  screenWidth: number;
  screenHeight: number;
  error?: string;
}

export interface ScreenElement {
  index: number;
  text: string;
  desc: string;
  resourceId: string;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  bounds: [number, number, number, number];
  center: [number, number];
}

export interface ScreenPerception {
  foregroundPackage: string;
  width: number;
  height: number;
  elements: ScreenElement[];
  formattedTree: string;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface PortalNotificationItem {
  packageName: string;
  title: string;
  text: string;
  postTimeMs: number;
}

export class PortalClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    const resp = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Portal ${path} HTTP ${resp.status}: ${text.slice(0, 240)}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async health(): Promise<PortalHealth> {
    try {
      const res = await this.request<Omit<PortalHealth, "ok">>("/health", { method: "GET" }, 3_500);
      return { ok: true, ...res };
    } catch (err: any) {
      return {
        ok: false,
        accessibilityConnected: false,
        shizukuReady: false,
        notificationListenerConnected: false,
        foregroundPackage: "",
        screenWidth: 0,
        screenHeight: 0,
        error: err?.message ?? String(err),
      };
    }
  }

  async getScreen(includeImage = false, annotate = true): Promise<ScreenPerception> {
    return this.request<ScreenPerception>(
      `/screen?includeImage=${includeImage ? 1 : 0}&annotate=${annotate ? 1 : 0}`,
      { method: "GET" },
      18_000,
    );
  }

  async performAction(payload: {
    type: "tap" | "long_press" | "swipe" | "input" | "key" | "open_app";
    x?: number;
    y?: number;
    x2?: number;
    y2?: number;
    durationMs?: number;
    text?: string;
    key?: string;
    packageName?: string;
  }): Promise<{ ok: boolean; message: string }> {
    return this.request("/action", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async notify(payload: {
    id: string;
    title: string;
    body: string;
    level: "reminder" | "confirm";
    confirmId?: string;
  }): Promise<{ ok: boolean }> {
    return this.request("/notify", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getNotifications(packageName = ""): Promise<PortalNotificationItem[]> {
    const q = packageName ? `?packageName=${encodeURIComponent(packageName)}` : "";
    const res = await this.request<{ items: PortalNotificationItem[] }>(`/notifications${q}`, {
      method: "GET",
    });
    return res.items ?? [];
  }
}
