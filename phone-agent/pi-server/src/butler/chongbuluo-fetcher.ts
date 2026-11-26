import fs from "node:fs";
import path from "node:path";

export interface ChongbuluoSearchResult {
  query: string;
  mode: "background_fetch" | "needs_phone_control";
  sources: Array<{ name: string; url: string; title: string; snippet: string }>;
  markdownSummary: string;
  savedPath?: string;
  fallbackReason?: string;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtmlToText(m[1]).slice(0, 120) : "";
}

/**
 * 虫部落优先后台抓取器：
 * 1. 先并发后台请求虫部落门户与轻量公开检索入口，无需点亮屏幕；
 * 2. 若遇到 JS 动态渲染、验证码或需要登录的站内检索结果，则明确标记 `needs_phone_control`，
 *    交由 Agent 调用手机控屏（浏览器 / 虫部落）继续完成。
 */
export async function fetchChongbuluoBackground(
  query: string,
  outputDir: string,
): Promise<ChongbuluoSearchResult> {
  const cleanQuery = query.trim();
  const encoded = encodeURIComponent(cleanQuery);

  const targets = [
    { name: "虫部落快搜导航", url: "https://search.chongbuluo.com/" },
    { name: "虫部落社区检索", url: `https://www.chongbuluo.com/search.php?mod=forum&srchtxt=${encoded}` },
    { name: "Bing 站内索引兜底", url: `https://cn.bing.com/search?q=site:chongbuluo.com+${encoded}` },
  ];

  const sources: ChongbuluoSearchResult["sources"] = [];
  let blockedOrJsHeavy = 0;

  await Promise.all(
    targets.map(async (target) => {
      try {
        const resp = await fetch(target.url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Linux; Android 14; Xiaomi 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const html = await resp.text();
        const title = extractTitle(html);
        const text = stripHtmlToText(html);

        const looksBlocked =
          !resp.ok ||
          text.length < 180 ||
          /请先登录|验证码|Just a moment|cf-browser-verification/i.test(text);

        if (looksBlocked) {
          blockedOrJsHeavy++;
        }

        sources.push({
          name: target.name,
          url: target.url,
          title: title || target.name,
          snippet: text.slice(0, 1_200),
        });
      } catch (err: any) {
        blockedOrJsHeavy++;
        sources.push({
          name: target.name,
          url: target.url,
          title: `${target.name}（请求异常）`,
          snippet: err?.message ?? String(err),
        });
      }
    }),
  );

  const needsPhone = blockedOrJsHeavy >= targets.length;
  const markdownLines = [
    `# 虫部落搜索整理：${cleanQuery}`,
    `- 采集时间：${new Date().toLocaleString("zh-CN")}`,
    `- 模式：${needsPhone ? "后台抓取受限（建议切换手机控屏）" : "后台抓取完成"}`,
    "",
    ...sources.map(
      (s) => `## ${s.name}\n- 链接：${s.url}\n- 标题：${s.title}\n- 摘要片段：\n> ${s.snippet.slice(0, 500)}\n`,
    ),
  ];
  const markdownSummary = markdownLines.join("\n");

  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = cleanQuery.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 32) || "query";
  const savedPath = path.join(outputDir, `${Date.now()}_${safeName}.md`);
  fs.writeFileSync(savedPath, markdownSummary, "utf-8");

  return {
    query: cleanQuery,
    mode: needsPhone ? "needs_phone_control" : "background_fetch",
    sources,
    markdownSummary,
    savedPath,
    fallbackReason: needsPhone
      ? "虫部落检索入口返回登录拦截/动态渲染或网络超时，请改用 phone_open_app + 浏览器控屏操作。"
      : undefined,
  };
}
