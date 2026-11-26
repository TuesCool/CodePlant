import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface TodoItem {
  id: string;
  title: string;
  priority: "P0" | "P1" | "P2";
  estMinutes: number;
  status: "todo" | "doing" | "done" | "deferred";
  dueDate?: string;
  createdAt: string;
  completedAt?: string;
  notes?: string;
}

export interface DailyPlanSlot {
  id: string;
  todoId?: string;
  timeRange: string; // e.g. "09:30-10:15"
  remindAt: string;  // e.g. "09:30"
  title: string;
  reminded: boolean;
  done: boolean;
}

export interface DailyPlan {
  date: string; // YYYY-MM-DD
  slots: DailyPlanSlot[];
  generatedAt: string;
}

export interface WeeklyReview {
  weekLabel: string;
  generatedAt: string;
  completedCount: number;
  pendingCount: number;
  completionRate: number;
  markdownReport: string;
  suggestedPreferenceUpdates: string[];
}

interface ButlerStateFile {
  todos: TodoItem[];
  plans: Record<string, DailyPlan>;
  reviews: WeeklyReview[];
  recentWeChatEvents: Array<{ contact: string; text: string; ts: number; actionTaken: string }>;
}

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class ButlerStore {
  private state: ButlerStateFile = {
    todos: [],
    plans: {},
    reviews: [],
    recentWeChatEvents: [],
  };
  private readonly statePath: string;
  private readonly preferencesPath: string;
  private reminderTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly notifyPhone: (title: string, body: string) => Promise<void>,
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.statePath = path.join(dataDir, "butler-state.json");
    this.preferencesPath = path.join(dataDir, "preferences.md");
    if (fs.existsSync(this.statePath)) {
      try {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.statePath, "utf-8")) };
      } catch {
        // Keep defaults
      }
    } else {
      this.save();
    }
  }

  private save() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  getSnapshot() {
    const today = todayStr();
    return {
      today,
      todos: this.state.todos,
      todayPlan: this.state.plans[today] ?? null,
      latestReview: this.state.reviews[this.state.reviews.length - 1] ?? null,
      preferences: this.readPreferences(),
      recentWeChatEvents: this.state.recentWeChatEvents.slice(-10),
    };
  }

  readPreferences(): string {
    if (!fs.existsSync(this.preferencesPath)) return "";
    return fs.readFileSync(this.preferencesPath, "utf-8");
  }

  appendPreferenceOptimization(ruleText: string) {
    const line = `\n- [${todayStr()} 周复盘迭代] ${ruleText.trim()}`;
    fs.appendFileSync(this.preferencesPath, line, "utf-8");
  }

  addTodo(input: {
    title: string;
    priority?: "P0" | "P1" | "P2";
    estMinutes?: number;
    dueDate?: string;
    notes?: string;
  }): TodoItem {
    const item: TodoItem = {
      id: crypto.randomUUID().slice(0, 8),
      title: input.title.trim(),
      priority: input.priority ?? "P1",
      estMinutes: Math.max(10, Math.min(240, input.estMinutes ?? 30)),
      status: "todo",
      dueDate: input.dueDate,
      createdAt: new Date().toISOString(),
      notes: input.notes,
    };
    this.state.todos.unshift(item);
    this.save();
    return item;
  }

  updateTodoStatus(id: string, status: TodoItem["status"]): TodoItem | null {
    const target = this.state.todos.find((t) => t.id === id);
    if (!target) return null;
    target.status = status;
    if (status === "done") target.completedAt = new Date().toISOString();
    this.save();
    return target;
  }

  /**
   * Generates today's time-blocked schedule from open todos ordered by priority (P0 > P1 > P2).
   */
  generateDailyPlan(startHour = 9): DailyPlan {
    const date = todayStr();
    const order = { P0: 0, P1: 1, P2: 2 };
    const open = this.state.todos
      .filter((t) => t.status === "todo" || t.status === "doing")
      .sort((a, b) => order[a.priority] - order[b.priority])
      .slice(0, 6);

    let cursorMinutes = startHour * 60;
    const fmt = (mins: number) =>
      `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

    const slots: DailyPlanSlot[] = open.map((t) => {
      const start = cursorMinutes;
      const end = cursorMinutes + t.estMinutes;
      cursorMinutes = end + 15; // 15m buffer
      return {
        id: crypto.randomUUID().slice(0, 8),
        todoId: t.id,
        timeRange: `${fmt(start)}-${fmt(end)}`,
        remindAt: fmt(start),
        title: `[${t.priority}] ${t.title}`,
        reminded: false,
        done: false,
      };
    });

    const plan: DailyPlan = {
      date,
      slots,
      generatedAt: new Date().toISOString(),
    };
    this.state.plans[date] = plan;
    this.save();
    return plan;
  }

  generateWeeklyReview(applyAutoOptimization = false): WeeklyReview {
    const total = this.state.todos.length;
    const done = this.state.todos.filter((t) => t.status === "done");
    const pending = this.state.todos.filter((t) => t.status !== "done");
    const rate = total === 0 ? 100 : Math.round((done.length / total) * 100);

    const suggestions: string[] = [];
    if (rate < 60 && pending.length > 0) {
      suggestions.push("本周任务完成率偏低，下周每日排期上限建议控制在 3 个核心任务内，优先切小颗粒度。");
    } else {
      suggestions.push("本周推进节奏稳定，可继续保持 P0 早间专注时段安排。");
    }
    if (pending.some((t) => t.priority === "P0")) {
      suggestions.push("仍有未完成 P0 高优任务，建议对 P0 事项开启二次提前 10 分钟原生督促提醒。");
    }

    const report = [
      `# 每周复盘报告（${todayStr()}）`,
      `- 总待办：${total} ｜ 已完成：${done.length} ｜ 未完成：${pending.length} ｜ 完成率：${rate}%`,
      "",
      "## 已完成清单",
      ...(done.length ? done.map((t) => `- [x] [${t.priority}] ${t.title}`) : ["- 暂无"]),
      "",
      "## 遗留与卡点",
      ...(pending.length ? pending.map((t) => `- [ ] [${t.priority}] ${t.title}`) : ["- 全部清零"]),
      "",
      "## 下周迭代优化建议",
      ...suggestions.map((s) => `- ${s}`),
    ].join("\n");

    const review: WeeklyReview = {
      weekLabel: todayStr(),
      generatedAt: new Date().toISOString(),
      completedCount: done.length,
      pendingCount: pending.length,
      completionRate: rate,
      markdownReport: report,
      suggestedPreferenceUpdates: suggestions,
    };

    this.state.reviews.push(review);
    if (applyAutoOptimization) {
      for (const s of suggestions) {
        this.appendPreferenceOptimization(s);
      }
    }
    this.save();
    return review;
  }

  recordWeChatEvent(contact: string, text: string, actionTaken: string) {
    this.state.recentWeChatEvents.push({
      contact,
      text,
      ts: Date.now(),
      actionTaken,
    });
    if (this.state.recentWeChatEvents.length > 50) {
      this.state.recentWeChatEvents = this.state.recentWeChatEvents.slice(-50);
    }
    this.save();
  }

  /**
   * Starts a 30-second heartbeat checking whether any slot in today's plan reached its `remindAt` time.
   */
  startReminderLoop() {
    if (this.reminderTimer) return;
    this.reminderTimer = setInterval(() => {
      void this.tickReminders();
    }, 30_000);
  }

  stopReminderLoop() {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  async tickReminders() {
    const plan = this.state.plans[todayStr()];
    if (!plan) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    let changed = false;

    for (const slot of plan.slots) {
      if (!slot.reminded && !slot.done && hhmm >= slot.remindAt) {
        slot.reminded = true;
        changed = true;
        await this.notifyPhone(
          `⏰ 计划督促 (${slot.timeRange})`,
          `该开始执行：${slot.title}`,
        ).catch(() => {});
      }
    }
    if (changed) this.save();
  }
}
