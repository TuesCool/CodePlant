import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { fetchChongbuluoBackground } from "../butler/chongbuluo-fetcher.ts";
import type { ButlerStore } from "../butler/butler-store.ts";
import type { PortalClient } from "./portal-client.ts";
import type { SafetyGuard } from "./safety-guard.ts";

export interface ToolDeps {
  portal: PortalClient;
  safety: SafetyGuard;
  butler: ButlerStore;
  chongbuluoDir: string;
  onStepLog?: (label: string) => void;
}

export function createAllAgentTools(deps: ToolDeps): AgentTool<any>[] {
  const log = (s: string) => deps.onStepLog?.(s);

  return [
    {
      name: "phone_get_screen",
      label: "读取屏幕控件树",
      description:
        "获取当前小米手机屏幕的精简编号控件树（默认无图片，极省 Token）。当页面无节点或需要确认视觉细节时再传 includeImage=true。",
      parameters: Type.Object({
        includeImage: Type.Optional(Type.Boolean({ description: "是否附带截图（默认 false）" })),
      }),
      execute: async (_id, args: { includeImage?: boolean }) => {
        log("读取当前屏幕感知...");
        const screen = await deps.portal.getScreen(Boolean(args.includeImage), true);
        const content: any[] = [
          {
            type: "text",
            text: `前台应用: ${screen.foregroundPackage} (${screen.width}x${screen.height})\n\nScreen now:\n${screen.formattedTree}`,
          },
        ];
        if (screen.imageBase64) {
          content.push({
            type: "image",
            data: screen.imageBase64,
            mimeType: screen.imageMimeType || "image/jpeg",
          });
        }
        return { content, details: {} };
      },
    },
    {
      name: "phone_tap",
      label: "点击屏幕坐标",
      description: "通过无障碍手势点击屏幕绝对像素坐标 (x, y)。若涉及微信拨打视频，会先经 SafetyGuard 确认。",
      parameters: Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        purpose: Type.Optional(Type.String({ description: "本次点击意图描述，用于安全审计" })),
      }),
      execute: async (_id, args: { x: number; y: number; purpose?: string }) => {
        const purpose = args.purpose ?? "";
        if (/视频通话|打视频|video\s*call/i.test(purpose)) {
          const allowed = await deps.safety.requestConfirmation(
            "wechat_video_call",
            "确认发起微信视频通话？",
            `Agent 请求点击发起视频 (${purpose})，坐标 (${args.x}, ${args.y})`,
          );
          if (!allowed) {
            return {
              content: [{ type: "text", text: "用户已拒绝或超时未确认发起视频通话，操作已中止。" }],
              details: {},
              isError: true,
            };
          }
        }
        log(`点击 (${args.x}, ${args.y}) ${purpose}`);
        const res = await deps.portal.performAction({ type: "tap", x: args.x, y: args.y });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_swipe",
      label: "滑动屏幕",
      description: "在手机屏幕上执行滑动（用于翻页、滚动列表）。",
      parameters: Type.Object({
        x1: Type.Number(),
        y1: Type.Number(),
        x2: Type.Number(),
        y2: Type.Number(),
        durationMs: Type.Optional(Type.Number()),
      }),
      execute: async (_id, args: { x1: number; y1: number; x2: number; y2: number; durationMs?: number }) => {
        log(`滑动 (${args.x1},${args.y1}) -> (${args.x2},${args.y2})`);
        const res = await deps.portal.performAction({
          type: "swipe",
          x: args.x1,
          y: args.y1,
          x2: args.x2,
          y2: args.y2,
          durationMs: args.durationMs ?? 320,
        });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_input_text",
      label: "输入文本（支持中文）",
      description: "向当前聚焦输入框写入文本，支持中文（无障碍 ACTION_SET_TEXT / 剪贴板粘贴）。",
      parameters: Type.Object({
        text: Type.String(),
      }),
      execute: async (_id, args: { text: string }) => {
        log(`输入文本 (${args.text.slice(0, 20)})`);
        const res = await deps.portal.performAction({ type: "input", text: args.text });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_press_key",
      label: "系统按键",
      description: "触发系统全局按键：back / home / recents / notifications。",
      parameters: Type.Object({
        key: Type.Union([
          Type.Literal("back"),
          Type.Literal("home"),
          Type.Literal("recents"),
          Type.Literal("notifications"),
        ]),
      }),
      execute: async (_id, args: { key: string }) => {
        log(`按键 ${args.key}`);
        const res = await deps.portal.performAction({ type: "key", key: args.key });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_open_app",
      label: "打开手机应用",
      description: "按包名打开目标应用（如微信 com.tencent.mm、浏览器 com.android.browser）。",
      parameters: Type.Object({
        packageName: Type.String(),
      }),
      execute: async (_id, args: { packageName: string }) => {
        log(`打开应用 ${args.packageName}`);
        const res = await deps.portal.performAction({ type: "open_app", packageName: args.packageName });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_get_notifications",
      label: "读取近期通知栏",
      description: "读取 Android 通知监听缓存的近期通知（例如微信未读消息）。",
      parameters: Type.Object({
        packageName: Type.Optional(Type.String({ description: "过滤包名，例如 com.tencent.mm" })),
      }),
      execute: async (_id, args: { packageName?: string }) => {
        const list = await deps.portal.getNotifications(args.packageName ?? "");
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
          details: {},
        };
      },
    },
    {
      name: "chongbuluo_search_background",
      label: "虫部落优先后台抓取",
      description:
        "优先在 Termux 后台直接抓取虫部落检索与相关信息并保存为 Markdown。仅当返回 mode=needs_phone_control 时再切换手机控屏。",
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async (_id, args: { query: string }) => {
        log(`后台抓取虫部落: ${args.query}`);
        const result = await fetchChongbuluoBackground(args.query, deps.chongbuluoDir);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {},
        };
      },
    },
    {
      name: "butler_add_todo",
      label: "添加个人待办",
      description: "根据用户对话需求创建结构化待办事项。",
      parameters: Type.Object({
        title: Type.String(),
        priority: Type.Optional(Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")])),
        estMinutes: Type.Optional(Type.Number()),
        notes: Type.Optional(Type.String()),
      }),
      execute: async (_id, args: any) => {
        const todo = deps.butler.addTodo(args);
        return { content: [{ type: "text", text: `已创建待办: ${JSON.stringify(todo)}` }], details: {} };
      },
    },
    {
      name: "butler_generate_daily_plan",
      label: "生成今日计划并开启原生督促",
      description: "根据现有待办按优先级排定今天的时间块计划，到达时间点由手机原生通知督促。",
      parameters: Type.Object({
        startHour: Type.Optional(Type.Number({ description: "起始小时，默认 9" })),
      }),
      execute: async (_id, args: { startHour?: number }) => {
        const plan = deps.butler.generateDailyPlan(args.startHour ?? 9);
        await deps.portal
          .notify({
            id: `plan-${plan.date}`,
            title: "📅 今日行动计划已就绪",
            body: `共安排 ${plan.slots.length} 个任务块，将按时发出督促提醒。`,
            level: "reminder",
          })
          .catch(() => {});
        return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }], details: {} };
      },
    },
    {
      name: "butler_weekly_review",
      label: "生成每周复盘并迭代规则",
      description: "统计待办完成率与卡点生成周复盘报告，可选自动将优化建议回写 preferences.md。",
      parameters: Type.Object({
        applyOptimization: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args: { applyOptimization?: boolean }) => {
        const rev = deps.butler.generateWeeklyReview(Boolean(args.applyOptimization));
        return { content: [{ type: "text", text: rev.markdownReport }], details: {} };
      },
    },
  ];
}
