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

/** 一条引用（OpenAI url_citation 所需的字段：链接、标题、正文里的字符偏移） */
export interface AnswerCitation {
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

/**
 * 把搜索结果整理成正文 + 引用标注（与 grok2api web 模型同款）：
 *   - 每条来源后面跟 [[N]](url) 内联引用；
 *   - citations 记录每个引用的 url / 标题 / start_index / end_index（码点偏移，
 *     供 Responses 的平铺 url_citation 或 Chat 的嵌套 url_citation 直接使用）。
 */
export function buildAnswer(data: SearchData, query: string, snippetMax: number): { text: string; citations: AnswerCitation[] } {
  const parts: string[] = [];
  const citations: AnswerCitation[] = [];
  let offset = 0; // 码点偏移（CJK 也按 1 记，和 OpenAI 一致）
  let n = 0;

  const add = (s: string) => {
    parts.push(s);
    offset += [...s].length;
  };
  const cite = (url: string, title: string) => {
    n += 1;
    const marker = `[[${n}]](${url})`;
    parts.push(marker);
    citations.push({ url, title, start_index: offset, end_index: offset + [...marker].length });
    offset += [...marker].length;
  };

  add(`「${query}」搜索结果（网页 ${data.pages.length} 条，X 帖子 ${data.posts.length} 条）`);

  if (data.pages.length > 0) {
    add("\n\n——— 网页 ———");
    data.pages.forEach((page, index) => {
      const title = page.title || page.url;
      add(`\n\n${index + 1}. ${title}`);
      const snippet = clean(page.snippet, snippetMax);
      if (snippet) add(`\n   ${snippet}`);
      add("\n   🔗 ");
      cite(page.url, title);
    });
  }

  if (data.posts.length > 0) {
    add("\n\n——— X 讨论 ———");
    data.posts.forEach((post, index) => {
      const meta = [post.createdAt && `${post.createdAt}`, post.views != null && `${post.views} 浏览`, post.likes != null && `${post.likes} 赞`].filter(Boolean).join(" · ");
      add(`\n\n${index + 1}. @${post.handle}（${post.name}）${meta ? ` · ${meta}` : ""}`);
      add(`\n   ${clean(post.text, snippetMax)}`);
      add("\n   🔗 ");
      cite(post.url, `@${post.handle}: ${clean(post.text, 80)}`);
    });
  }

  if (data.pages.length === 0 && data.posts.length === 0) add("\n\n未获取到搜索结果。");
  return { text: parts.join(""), citations };
}

/** 文本输出（含 [[N]](url) 引用），供快照 / JSON 之前的旧调用方继续使用 */
export function toText(data: SearchData, query: string, snippetMax: number): string {
  return buildAnswer(data, query, snippetMax).text;
}

/** 按来源把条目分组（同一搜索词聚到一次 web/x 搜索调用里），保持出现顺序 */
function groupSources<T extends { url: string; query?: string }>(
  items: T[],
  source: (item: T) => { title: string; url: string },
): Array<{ query?: string; sources: Array<{ title: string; type: "url"; url: string }> }> {
  const map = new Map<string, { query?: string; sources: Array<{ title: string; type: "url"; url: string }> }>();
  const order: string[] = [];
  for (const item of items) {
    const key = item.query || "";
    if (!map.has(key)) {
      map.set(key, { query: item.query || undefined, sources: [] });
      order.push(key);
    }
    map.get(key)!.sources.push({ ...source(item), type: "url" });
  }
  return order.map((key) => map.get(key)!);
}

/**
 * Responses 协议的搜索调用项（grok2api web 模型同款）：
 *   web = web_search_call（action.type="search"），x = x_search_call（无 type）。
 */
export function searchCallItems(data: SearchData) {
  const web = groupSources(data.pages, (p) => ({ title: p.title || p.url, url: p.url })).map((g) => ({
    id: `ws_${crypto.randomUUID()}`,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", ...(g.query ? { query: g.query } : {}), sources: g.sources },
  }));
  const x = groupSources(data.posts, (p) => ({ title: `@${p.handle}: ${clean(p.text, 80)}`, url: p.url })).map((g) => ({
    id: `xs_${crypto.randomUUID()}`,
    type: "x_search_call",
    status: "completed",
    action: { ...(g.query ? { query: g.query } : {}), sources: g.sources },
  }));
  return { web, x };
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
