import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { fetchChongbuluoBackground } from "../butler/chongbuluo-fetcher.ts";
import type { ButlerStore } from "../butler/butler-store.ts";
import type { MetasoClient, MetasoScope } from "../integrations/metaso-client.ts";
import type { KbStore } from "../knowledge/kb-store.ts";
import type { PortalClient } from "./portal-client.ts";
import type { SafetyGuard } from "./safety-guard.ts";

export interface ToolDeps {
  portal: PortalClient;
  safety: SafetyGuard;
  butler: ButlerStore;
  kb: KbStore;
  metaso: MetasoClient;
  chongbuluoDir: string;
  onStepLog?: (label: string) => void;
}

export function createAllAgentTools(deps: ToolDeps): AgentTool<any>[] {
  const log = (s: string) => deps.onStepLog?.(s);

  return [
    {
      name: "phone_list_apps",
      label: "查询已安装应用与包名",
      description:
        "列出手机上可启动的应用名称和包名（支持关键词过滤，如 音乐/网易云/QQ音乐/微信/备忘录）。打开陌生 App 前先调用它获取准确包名！",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "按应用名或包名模糊过滤" })),
      }),
      execute: async (_id, args: { keyword?: string }) => {
        log(`查询手机应用列表 (${args.keyword || "全部"})`);
        const apps = await deps.portal.listApps();
        const kw = (args.keyword || "").trim().toLowerCase();
        const filtered = kw
          ? apps.filter(
              (a) => a.label.toLowerCase().includes(kw) || a.packageName.toLowerCase().includes(kw),
            )
          : apps.slice(0, 60);
        return {
          content: [
            {
              type: "text",
              text:
                filtered.length > 0
                  ? filtered.map((a) => `- ${a.label} => ${a.packageName}`).join("\n")
                  : `未找到包含 "${args.keyword}" 的应用（共扫描到 ${apps.length} 个应用）。`,
            },
          ],
          details: {},
        };
      },
    },
    {
      name: "phone_get_screen",
      label: "读取屏幕控件树",
      description:
        "获取当前小米手机屏幕的精简编号控件树（例如 [12] 输入框、(x,y)）。默认不截屏省 Token；遇到游戏/自定义画布再传 includeImage=true。",
      parameters: Type.Object({
        includeImage: Type.Optional(Type.Boolean({ description: "是否附带截图（默认 false）" })),
      }),
      execute: async (_id, args: { includeImage?: boolean }) => {
        log("读取当前屏幕控件树...");
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
      name: "phone_tap_element",
      label: "按控件编号点击",
      description:
        "优先使用！直接点击 phone_get_screen 返回的 [index] 编号控件，比盲猜坐标更稳定。涉及微信拨打视频会经 SafetyGuard 确认。",
      parameters: Type.Object({
        index: Type.Number({ description: "控件树里的中括号编号，例如 [12] 传 12" }),
        purpose: Type.Optional(Type.String({ description: "本次点击意图描述" })),
      }),
      execute: async (_id, args: { index: number; purpose?: string }) => {
        const purpose = args.purpose ?? "";
        if (/视频通话|打视频|video\s*call/i.test(purpose)) {
          const allowed = await deps.safety.requestConfirmation(
            "wechat_video_call",
            "确认发起微信视频通话？",
            `Agent 请求点击节点 [${args.index}] 发起视频 (${purpose})`,
          );
          if (!allowed) {
            return {
              content: [{ type: "text", text: "用户已拒绝或超时未确认发起视频通话，操作已中止。" }],
              details: {},
              isError: true,
            };
          }
        }
        log(`点击控件 [${args.index}] ${purpose}`);
        const res = await deps.portal.performAction({ type: "tap_element", index: args.index });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_tap",
      label: "点击屏幕坐标",
      description: "通过无障碍手势点击屏幕绝对像素坐标 (x, y)。若已有编号建议优先用 phone_tap_element。",
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
        log(`点击坐标 (${args.x}, ${args.y}) ${purpose}`);
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
      label: "定位并输入文本（支持中文）",
      description:
        "向输入框写入中文或英文。强烈建议传入控件树的 index（或 x, y 坐标），无障碍会先点击聚焦该输入框再写入并自动剪贴板粘贴兜底。",
      parameters: Type.Object({
        text: Type.String(),
        index: Type.Optional(Type.Number({ description: "目标输入框在控件树中的编号" })),
        x: Type.Optional(Type.Number({ description: "可选：输入框中心点 X 坐标" })),
        y: Type.Optional(Type.Number({ description: "可选：输入框中心点 Y 坐标" })),
      }),
      execute: async (_id, args: { text: string; index?: number; x?: number; y?: number }) => {
        log(`输入文本 (${args.text.slice(0, 20)})`);
        const res = await deps.portal.performAction({
          type: "input",
          text: args.text,
          index: args.index,
          x: args.x,
          y: args.y,
        });
        return { content: [{ type: "text", text: res.message }], details: {} };
      },
    },
    {
      name: "phone_wait",
      label: "等待界面加载",
      description: "在打开应用、切换页面或点击发送后短暂等待（300~5000ms），再读取屏幕。",
      parameters: Type.Object({
        ms: Type.Optional(Type.Number({ description: "等待毫秒数，默认 1000" })),
      }),
      execute: async (_id, args: { ms?: number }) => {
        const ms = Math.max(300, Math.min(5000, Number(args.ms ?? 1000)));
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: "text", text: `已等待 ${ms}ms` }], details: {} };
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
      description: "按应用名（如 微信、网易云音乐、QQ音乐）或包名（com.tencent.mm）打开手机应用。",
      parameters: Type.Object({
        appName: Type.Optional(Type.String({ description: "应用中文名或英文名，如 微信 / 网易云音乐" })),
        packageName: Type.Optional(Type.String({ description: "精确包名，如 com.tencent.mm" })),
      }),
      execute: async (_id, args: { appName?: string; packageName?: string }) => {
        const label = args.appName || args.packageName || "";
        log(`打开应用 ${label}`);
        const res = await deps.portal.performAction({
          type: "open_app",
          appName: args.appName,
          packageName: args.packageName,
        });
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
      name: "metaso_search_export",
      label: "秘塔 AI 检索并导出文件",
      description: "调用秘塔 AI 搜索并将 AI 综合摘要与原始来源整理为可下载的 Markdown/JSON 文件。",
      parameters: Type.Object({
        query: Type.String(),
        scope: Type.Optional(
          Type.Union([Type.Literal("webpage"), Type.Literal("document"), Type.Literal("scholar")]),
        ),
      }),
      execute: async (_id, args: { query: string; scope?: MetasoScope }) => {
        log(`秘塔 AI 检索并导出: ${args.query}`);
        const res = await deps.metaso.searchAndExport(args.query, args.scope);
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          details: {},
          isError: !res.ok,
        };
      },
    },
    {
      name: "kb_search",
      label: "检索个人知识库",
      description: "检索本地个人 Markdown 知识库（含从 Obsidian/语雀/Notion 同步的笔记）。",
      parameters: Type.Object({
        query: Type.String(),
      }),
      execute: async (_id, args: { query: string }) => {
        log(`检索个人知识库: ${args.query}`);
        const hits = deps.kb.searchNotes(args.query, 6);
        return {
          content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
          details: {},
        };
      },
    },
    {
      name: "kb_save_note",
      label: "写入个人知识库",
      description: "将重要笔记、会议总结、秘塔检索摘要保存到本地个人知识库 Markdown 中。",
      parameters: Type.Object({
        title: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_id, args: { title: string; content: string; tags?: string[] }) => {
        log(`保存到个人知识库: ${args.title}`);
        const note = deps.kb.saveNote({
          title: args.title,
          content: args.content,
          tags: args.tags,
          source: "agent",
        });
        return {
          content: [{ type: "text", text: `已保存知识库笔记《${note.title}》(id: ${note.id})` }],
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
