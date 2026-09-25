/**
 * format.ts —— 结果整理与输出
 *
 * 两种出口：
 *   toText()  —— 把搜索结果整理成"类似 LLM 回复的正文"（下游直接当回答用）
 *   toJSON()  —— 结构化数据（/v1/search 与响应里的 search 扩展字段）
 *
 * 整理规则：正文节选做清洗（去 Markdown 标记、压缩空白）并按上限截断；
 * 去重已在采集阶段按 URL 完成，这里不再处理。
 */

import type { SearchData } from "./grok.ts";

/** 清洗正文节选：把换行/多余空白压成单空格（读起来更像一段正文）、去掉装饰性标记、截断 */
function clean(text: string, max: number): string {
  const value = (text ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")        // 换行也压成空格：搜索结果本身是排版文本，压平后更像回答正文
    .replace(/^#{1,6}\s*/g, "")  // 去掉 Markdown 标题标记
    .replace(/^[-*•]\s*/g, "")   // 去掉列表符号
    .trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 把搜索结果整理成可读正文：
 *   开头给统计与用户问题，随后按来源逐条列出「标题 + 摘要 + 链接」，
 *   X 讨论单独成段。整体形态接近一个整理好的回答，而不是原始 JSON。
 */
export function toText(data: SearchData, query: string, snippetMax: number): string {
  const lines: string[] = [`「${query}」搜索结果（网页 ${data.pages.length} 条，X 帖子 ${data.posts.length} 条）`];

  if (data.pages.length > 0) {
    lines.push("", "——— 网页 ———");
    data.pages.forEach((page, index) => {
      lines.push("", `${index + 1}. ${page.title || page.url}`);
      const snippet = clean(page.snippet, snippetMax);
      if (snippet) lines.push(`   ${snippet}`);
      lines.push(`   🔗 ${page.url}`);
    });
  }

  if (data.posts.length > 0) {
    lines.push("", "——— X 讨论 ———");
    data.posts.forEach((post, index) => {
      const meta = [post.createdAt && `${post.createdAt}`, post.views != null && `${post.views} 浏览`, post.likes != null && `${post.likes} 赞`].filter(Boolean).join(" · ");
      lines.push("", `${index + 1}. @${post.handle}（${post.name}）${meta ? ` · ${meta}` : ""}`);
      lines.push(`   ${clean(post.text, snippetMax)}`);
      lines.push(`   🔗 ${post.url}`);
    });
  }

  if (data.pages.length + data.posts.length === 0) lines.push("", "未获取到搜索结果。");
  return lines.join("\n");
}

/** 结构化输出：字段名稳定，便于程序消费；不含账号等内部信息 */
export function toJSON(data: SearchData) {
  return {
    queries: data.queries,
    pages: data.pages.map((p) => ({ title: p.title, url: p.url, snippet: p.snippet, query: p.query })),
    posts: data.posts.map((p) => ({ handle: p.handle, name: p.name, text: p.text, createdAt: p.createdAt, views: p.views ?? null, likes: p.likes ?? null, url: p.url, query: p.query })),
    elapsedMs: data.elapsedMs ?? null,
  };
}

// ============================================================================
// 流式输出：搜索过程中边到边发
// ============================================================================

/** 流式头部（响应开始立即下发，客户端马上能看到"正在搜"） */
export function streamHead(query: string): string {
  return `「${query}」实时搜索结果\n\n`;
}

/**
 * 流式单条：每到达一条新结果就格式化一段增量文本。
 * 与最终 toText 的差别：不做分节标题（网页/帖子可能交错到达），用类型前缀区分。
 */
export function streamItem(kind: "page" | "post", item: { url: string; title?: string; snippet?: string; handle?: string; name?: string; text?: string; createdAt?: string; views?: number; likes?: number }, index: number, snippetMax: number): string {
  if (kind === "page") {
    const title = (item.title ?? "").trim() || item.url;
    const snippet = clean(item.snippet ?? "", snippetMax);
    return [`${index}. 网页 · [${title}](${item.url})`, snippet ? `   ${snippet}` : "", ""].filter(Boolean).join("\n") + "\n";
  }
  const meta = [item.createdAt, item.views != null ? `${item.views} 浏览` : "", item.likes != null ? `${item.likes} 赞` : ""].filter(Boolean).join(" · ");
  const text = clean(item.text ?? "", snippetMax);
  return [`${index}. 帖子 · @${item.handle}${item.name && item.name !== item.handle ? `（${item.name}）` : ""}${meta ? ` · ${meta}` : ""}`, `   ${text}`, `   🔗 ${item.url}`, ""].join("\n") + "\n";
}

/** 流式收尾（搜索结束时的统计行） */
export function streamTail(pages: number, posts: number, elapsedMs: number): string {
  return `——— 完成：共 ${pages} 网页 / ${posts} 帖子，用时 ${elapsedMs} ms\n`;
}
