/**
 * index.ts —— HTTP 入口（Elysia）：公开搜索 API + 面板 API + 前端托管
 *
 * 认证：
 *   /v1/*      Bearer <clientKeys>（公网调用，密钥在 config.json 配置）
 *   /admin/*   浏览器 Basic 认证（自带登录弹窗，不做登录页）
 *   / 与 /assets/* 同 Basic 认证（保护监控面板本身）
 *   /healthz   公开（容器健康检查）
 *
 * 前端自动刷新：GET /admin/stream 用 SSE 每 2 秒推一次状态快照；
 * 页面用 Vue 响应式更新数据，只改数据不动页面状态，不会闪烁。
 */

import { dirname, resolve } from "node:path";
import { Elysia, sse, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";

import { Clearance, NoAccountError, Pool, Searcher, getLogs, getSearchResult, log, resolveUid, type SearchConfig, type SearchData } from "./grok.ts";
import { dbStats, initDb } from "./db.ts";
import { QuotaRefresher, QuotaStore } from "./quota.ts";
import { toJSON, toText, buildAnswer, searchCallItems, streamHead, streamItem, streamTail } from "./format.ts";

// ============================================================================
// 配置：读 config.json 并补默认值（容器里由 compose 挂载）
// ============================================================================
const configPath = process.env.GROK2SEARCH_CONFIG ?? "./config.json";
const userConfig = JSON.parse(await Bun.file(configPath).text().catch(() => "{}"));
const config = {
  port: userConfig.port ?? 8080,
  panel: { user: userConfig.panel?.user ?? "admin", pass: userConfig.panel?.pass ?? "" },
  clientKeys: (userConfig.clientKeys ?? []) as string[],
  accountsFile: resolve(dirname(resolve(configPath)), userConfig.accountsFile ?? "accounts.json"),
  flareSolverrUrl: userConfig.flareSolverrUrl ?? "http://flaresolverr:8191/v1",
  upstream: { baseUrl: userConfig.upstream?.baseUrl ?? "https://grok.com", sessionModel: userConfig.upstream?.sessionModel ?? "fast" },
  cooldownMs: userConfig.cooldownMs ?? 60_000,
  clearanceTtlMs: userConfig.clearanceTtlMs ?? 600_000,
  dataDir: resolve(dirname(resolve(configPath)), userConfig.dataDir ?? "data"),
  quota: {
    intervalMs: userConfig.quota?.intervalMs ?? 6 * 3_600_000,
    initialDelayMs: userConfig.quota?.initialDelayMs ?? 20_000,
    concurrency: userConfig.quota?.concurrency ?? 3,
  },
};
const PUBLIC_MODEL = "grok-search";
/** 纯搜索模型：只吐搜索结果（不打总结） */
const SEARCH_MODEL = "search";
/** grok-search 的内置引导词：告诉模型它的职责是搜索并引用来源 */
const SEARCH_INSTRUCTION = "你是一个专注于联网搜索的助手。请先使用 web 搜索（必要时也用 X/Twitter 搜索）获取最新、最准确的信息，再基于搜索到的结果回答用户的问题，并在回答中用 [N](url) 的方式引用你的信息来源。若搜索结果不足，请明确说明信息有限。";

const snippetMax = userConfig.search?.snippetMaxChars ?? 500;
const searchConfig: SearchConfig = {
  instruction: userConfig.search?.instruction ?? "You MUST use web search (and X/Twitter search when relevant) to gather the latest, most accurate and up-to-date information before answering. Always search first, then answer based on the search results, and cite your sources in your response.",
  quietMs: userConfig.search?.quietMs ?? 5_000,
  maxMs: userConfig.search?.maxMs ?? 25_000,
  // 换号重试：不成功不罢休（号池耗尽 / 次数上限 / 预算用尽才失败）
  maxAttempts: userConfig.search?.maxAttempts ?? 12,
  retryBudgetMs: userConfig.search?.retryBudgetMs ?? 150_000,
  firstProgressMs: userConfig.search?.firstProgressMs ?? 10_000,
  snippetMaxChars: snippetMax,
  maxPages: userConfig.search?.maxPages ?? 40,
  maxPosts: userConfig.search?.maxPosts ?? 20,
  answerMaxMs: userConfig.search?.answerMaxMs ?? 120_000,
  chatInstruction: userConfig.search?.chatInstruction ?? SEARCH_INSTRUCTION,
  sessionModel: config.upstream.sessionModel,
  baseUrl: config.upstream.baseUrl,
  clearanceTtlMs: config.clearanceTtlMs,
};

// ============================================================================
// 装配：落盘数据库 / 号池 / 配额 / 清关 / 搜索器
// ============================================================================
// 搜索记录落盘（data/search.db）：初始化失败只降级为内存模式，不影响搜索
try {
  initDb(resolve(config.dataDir, "search.db"));
  log("info", "storage_ready", { file: resolve(config.dataDir, "search.db"), ...dbStats() });
} catch (error: any) {
  log("error", "storage_init_failed", { error: String(error?.message ?? error), hint: "搜索继续可用，但记录不会落盘" });
}
const quotaStore = new QuotaStore(resolve(config.dataDir, "quota.json"));
const pool = new Pool(config.accountsFile, config.cooldownMs, quotaStore);
pool.load();
const clearance = new Clearance(config.flareSolverrUrl, config.clearanceTtlMs);
// 配额刷新器：启动后全量刷一次 + 周期刷新；每次搜索结束后顺带刷新当次用到的号
const quota = new QuotaRefresher(quotaStore, clearance, () => pool.credentials(), { baseUrl: config.upstream.baseUrl, ...config.quota });
quota.start();
const searcher = new Searcher(pool, clearance, searchConfig, (account) => quota.touch(account));
if (config.clientKeys.length === 0) log("warn", "client_keys_empty", { hint: "config.json 的 clientKeys 为空，/v1/* 将全部返回 401" });
if (!config.panel.pass) log("warn", "panel_password_empty", { hint: "config.json 的 panel.pass 为空，面板将无法登录" });
log("info", "started", { port: config.port, accounts: pool.stats().total, quietMs: searchConfig.quietMs, maxAttempts: searchConfig.maxAttempts, retryBudgetMs: searchConfig.retryBudgetMs, quotaRefreshMs: config.quota.intervalMs });

const WEB_DIR = resolve(import.meta.dir, "../web");
const snapshot = () => ({
  status: { uptimeSec: Math.floor(process.uptime()), accounts: pool.stats(), clearance: clearance.status(), quota: quota.status(), storage: dbStats(), search: { quietMs: searchConfig.quietMs, maxMs: searchConfig.maxMs, maxAttempts: searchConfig.maxAttempts, retryBudgetMs: searchConfig.retryBudgetMs }, model: PUBLIC_MODEL },
  accounts: pool.list(),
  // SSE 只推最新 20 条；历史用 /admin/logs 分页拉取（面板滚动加载）
  logs: getLogs(undefined, 20),
});

// ============================================================================
// 认证工具
// ============================================================================
const bearer = (headers: Record<string, string | undefined>) => /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? ""))?.[1]?.trim() ?? "";
const basicOk = (headers: Record<string, string | undefined>) => {
  const match = /^Basic\s+(.+)$/i.exec(String(headers.authorization ?? ""));
  if (!match || !config.panel.pass) return false;
  const [user, pass] = atob(match[1]!).split(":");
  return user === config.panel.user && pass === config.panel.pass;
};
const err = (code: string, message: string, type = "invalid_request_error") => ({ error: { code, message, type, param: null } });
/** 401 + WWW-Authenticate：交给浏览器弹原生登录框 */
const challenge = (set: any) => { set.status = 401; set.headers["www-authenticate"] = 'Basic realm="grok2search"'; return err("unauthorized", "需要登录"); };
const guardClient = (ctx: any) => (config.clientKeys.includes(bearer(ctx.headers)) ? undefined : (ctx.set.status = 401, err("invalid_api_key", "API Key 无效")));
const guardPanel = (ctx: any) => (basicOk(ctx.headers) ? undefined : challenge(ctx.set));

// ============================================================================
// 入参提取与 SSE 分片
// ============================================================================
/** 从 OpenAI/Responses 两种请求体里取最后一个用户问题 */
function extractQuery(body: any, kind: "chat" | "responses"): string {
  const text = (content: any): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("\n") : "");
  if (kind === "chat") {
    const messages: any[] = body?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) if ((messages[i].role ?? "").toLowerCase() === "user" && text(messages[i].content).trim()) return text(messages[i].content).trim();
    return messages.map((m) => text(m.content)).join("\n").trim();
  }
  if (typeof body?.input === "string") return body.input.trim();
  if (Array.isArray(body?.input)) for (let i = body.input.length - 1; i >= 0; i--) if (body.input[i]?.role === "user" && text(body.input[i].content).trim()) return text(body.input[i].content).trim();
  return String(body?.instructions ?? "").trim();
}
/** 按行边界把长文本切块，模拟流式输出 */
function slice(text: string, size = 240): string[] {
  const chunks: string[] = [];
  for (let cursor = 0; cursor < text.length; ) {
    let end = Math.min(text.length, cursor + size);
    const newline = text.lastIndexOf("\n", end);
    if (newline > cursor + size / 2) end = newline + 1;
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}
/** 根据请求体提取用户问题（见下方 extractQuery）后，这里放一些小工具 */
const chatChunk = (id: string, delta: Record<string, unknown>, finish: string | null = null, model = PUBLIC_MODEL) => ({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] });

/** 顶层 citations：全部来源链接（网页在前，帖子在后），与 grok2api 一致 */
const sourceUrls = (data: { pages: Array<{ url: string }>; posts: Array<{ url: string }> }) => [...data.pages.map((p) => p.url), ...data.posts.map((p) => p.url)];
/** server_side_tool_usage：web/x 搜索调用次数 */
const toolUsage = (web: number, x: number) => ({ SERVER_SIDE_TOOL_WEB_SEARCH: web, SERVER_SIDE_TOOL_X_SEARCH: x });

/**
 * 极简异步通道：搜索线程 push 增量片段，SSE 生成器 await 消费。
 * 这是"真流式"的关键——搜索结果一到就推给客户端，而不是等全部搜完再切片。
 */
function createChannel<T>() {
  const queue: T[] = [];
  let waiter: ((value: T | null) => void) | null = null;
  let closed = false;
  return {
    push(value: T) {
      if (waiter) { const resolve = waiter; waiter = null; resolve(value); }
      else queue.push(value);
    },
    close() {
      closed = true;
      if (waiter) { const resolve = waiter; waiter = null; resolve(null); }
    },
    async next(): Promise<T | null> {
      if (queue.length > 0) return queue.shift()!;
      if (closed) return null;
      return await new Promise((resolve) => (waiter = resolve));
    },
  };
}

// ============================================================================
// Elysia 应用
// ============================================================================
const app = new Elysia()
  .use(cors())
  .use(swagger({ path: "/docs", documentation: { info: { title: "grok2search", version: "2.0.0", description: "Grok 搜索网关：只取搜索结果，不做正文总结" } } }))

  // ---------- 存活检查 ----------
  .get("/healthz", () => ({ ok: true, model: PUBLIC_MODEL, accounts: pool.stats() }))

  // ---------- 公开搜索 API（Bearer） ----------
  .group("/v1", (group) =>
    group
      .guard({ beforeHandle: guardClient })
      .get("/models", () => ({ object: "list", data: [{ id: PUBLIC_MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "grok2search" }, { id: SEARCH_MODEL, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "grok2search" }] }))
      // 原生结构化搜索
      .post("/search", async ({ body, headers, set }: any) => {
        const query = String(body?.query ?? "").trim();
        if (!query) { set.status = 400; return err("invalid_request", "query 不能为空"); }
        try { return { object: "search_result", model: PUBLIC_MODEL, query, ...toJSON(await searcher.search(query, bearer(headers))) }; }
        catch (error: any) { set.status = error instanceof NoAccountError ? 503 : 502; return err(error instanceof NoAccountError ? "no_account" : "upstream_failed", error.message, "server_error"); }
      }, { body: t.Object({ query: t.String() }, { additionalProperties: true }) })
      // OpenAI Chat Completions 兼容
      //   model=search       只吐搜索结果（原行为）
      //   model=grok-search  搜索流式进 reasoning_content，正文吐模型总结
      .post("/chat/completions", async ({ body, headers, set }: any) => {
        const query = extractQuery(body, "chat");
        if (!query) { set.status = 400; return err("invalid_request", "messages 为空"); }
        const model = String(body?.model ?? "") === SEARCH_MODEL ? SEARCH_MODEL : PUBLIC_MODEL;
        const isSummary = model === PUBLIC_MODEL;
        const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
        const wantsJson = body?.search_format === "json";

        // ================= search 模型：只吐搜索结果 =================
        if (!isSummary) {
          if (!body?.stream || wantsJson) {
            let data; try { data = await searcher.search(query, bearer(headers)); } catch (error: any) { set.status = error instanceof NoAccountError ? 503 : 502; return err(error instanceof NoAccountError ? "no_account" : "upstream_failed", error.message, "server_error"); }
            const json = toJSON(data);
            const answer = buildAnswer(data, query, snippetMax);
            const text = wantsJson ? JSON.stringify(json, null, 2) : answer.text;
            const { web, x } = searchCallItems(data);
            if (!body?.stream) return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, citations: sourceUrls(data), server_side_tool_usage: toolUsage(web.length, x.length), choices: [{ index: 0, message: { role: "assistant", content: text, annotations: wantsJson ? [] : answer.citations.map((c) => ({ type: "url_citation", url_citation: { url: c.url, title: c.title, start_index: c.start_index, end_index: c.end_index } })) }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, search: json };
            set.headers["content-type"] = "text/event-stream; charset=utf-8";
            return (async function* () { yield sse({ data: chatChunk(id, { role: "assistant", content: "" }, null, model) }); for (const piece of slice(text, 480)) yield sse({ data: chatChunk(id, { content: piece }, null, model) }); yield sse({ data: chatChunk(id, {}, "stop", model) }); yield sse("[DONE]"); })();
          }
          const channel = createChannel<string>();
          searcher.search(query, bearer(headers), (chunk) => channel.push(chunk)).then((data) => { channel.push(streamTail(data.pages.length, data.posts.length, data.elapsedMs ?? 0)); channel.close(); }).catch((error: any) => { channel.push(`\n[搜索失败：${error?.message ?? error}]\n`); channel.close(); });
          set.headers["content-type"] = "text/event-stream; charset=utf-8";
          return (async function* () {
            yield sse({ data: chatChunk(id, { role: "assistant", content: streamHead(query) }, null, model) });
            while (true) { const piece = await channel.next(); if (piece === null) break; yield sse({ data: chatChunk(id, { content: piece }, null, model) }); }
            yield sse({ data: chatChunk(id, {}, "stop", model) });
            yield sse("[DONE]");
          })();
        }

        // ================= grok-search 模型：搜索进思考 + 正文吐总结 =================
        const mentionsOf = (data: SearchData) => buildAnswer(data, query, snippetMax).citations.map((c) => ({ type: "url_citation", url_citation: { url: c.url, title: c.title, start_index: c.start_index, end_index: c.end_index } }));
        if (!body?.stream) {
          let data; try { data = await searcher.chat(query, bearer(headers)); } catch (error: any) { set.status = error instanceof NoAccountError ? 503 : 502; return err(error instanceof NoAccountError ? "no_account" : "upstream_failed", error.message, "server_error"); }
          const json = toJSON(data);
          const searchText = buildAnswer(data, query, snippetMax).text;
          const answerText = (data.answer ?? "").trim() || searchText;
          const { web, x } = searchCallItems(data);
          return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, citations: sourceUrls(data), server_side_tool_usage: toolUsage(web.length, x.length), choices: [{ index: 0, message: { role: "assistant", content: answerText, reasoning_content: searchText, annotations: mentionsOf(data) }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, search: json };
        }
        const channel = createChannel<{ kind: "reasoning" | "text" | "tail"; text: string }>();
        searcher.chat(query, bearer(headers), { onSearch: (chunk) => channel.push({ kind: "reasoning", text: chunk }), onText: (t) => channel.push({ kind: "text", text: t }) })
          .then((data) => { if (!(data.answer ?? "").trim()) channel.push({ kind: "tail", text: streamTail(data.pages.length, data.posts.length, data.elapsedMs ?? 0) }); channel.close(); })
          .catch((error: any) => { channel.push({ kind: "tail", text: `\n[搜索失败：${error?.message ?? error}]\n` }); channel.close(); });
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        return (async function* () {
          yield sse({ data: chatChunk(id, { role: "assistant", content: "", reasoning_content: streamHead(query) }, null, model) });
          while (true) {
            const msg = await channel.next();
            if (msg === null) break;
            if (msg.kind === "reasoning") yield sse({ data: chatChunk(id, { reasoning_content: msg.text }, null, model) });
            else yield sse({ data: chatChunk(id, { content: msg.text }, null, model) });
          }
          yield sse({ data: chatChunk(id, {}, "stop", model) });
          yield sse("[DONE]");
        })();
      }, { body: t.Object({ messages: t.Optional(t.Array(t.Any())), stream: t.Optional(t.Boolean()), search_format: t.Optional(t.String()) }, { additionalProperties: true }) })
      // Responses API 兼容（model=search 只吐搜索结构；model=grok-search 等模型总结并把搜索结果进 web_search_call 项）
      .post("/responses", async ({ body, headers, set }: any) => {
        const query = extractQuery(body, "responses");
        if (!query) { set.status = 400; return err("invalid_request", "input 为空"); }
        const model = String(body?.model ?? "") === SEARCH_MODEL ? SEARCH_MODEL : PUBLIC_MODEL;
        const isSummary = model === PUBLIC_MODEL;
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
        const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
        const created = Math.floor(Date.now() / 1000);
        const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        const wantsJson = body?.search_format === "json";

        const searchOutput = (data: any, text: string, annotations: any[]) => {
          const { web, x } = searchCallItems(data);
          return {
            web, x,
            output: [...web.filter((it: any) => it.action.sources.length > 0), ...x.filter((it: any) => it.action.sources.length > 0), { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] }],
          };
        };

        // ================= search 模型 =================
        if (!isSummary) {
          if (!body?.stream || wantsJson) {
            let data; try { data = await searcher.search(query, bearer(headers)); } catch (error: any) { set.status = error instanceof NoAccountError ? 503 : 502; return err(error instanceof NoAccountError ? "no_account" : "upstream_failed", error.message, "server_error"); }
            const json = toJSON(data);
            const answer = buildAnswer(data, query, snippetMax);
            const text = wantsJson ? JSON.stringify(json, null, 2) : answer.text;
            const citations = sourceUrls(data);
            const annotations = wantsJson ? [] : answer.citations.map((c, i) => ({ type: "url_citation", url: c.url, title: String(i + 1), start_index: c.start_index, end_index: c.end_index }));
            const { web, x, output } = searchOutput(data, text, annotations);
            if (!body?.stream) return { id: responseId, object: "response", created_at: created, status: "completed", model, output, citations, server_side_tool_usage: toolUsage(web.length, x.length), usage: { ...usage, num_sources_used: citations.length, num_server_side_tools_used: web.length + x.length }, search: json };
            set.headers["content-type"] = "text/event-stream; charset=utf-8";
            return (async function* () {
              const send = (type: string, payload: Record<string, unknown>) => sse({ event: type, data: { type, ...payload } });
              yield send("response.created", { response: { id: responseId, object: "response", created_at: created, status: "in_progress", model } });
              yield send("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
              yield send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
              for (const piece of slice(text, 480)) yield send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: piece });
              yield send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
              yield send("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text } });
              yield send("response.output_item.done", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] } });
              yield send("response.completed", { response: { id: responseId, object: "response", created_at: created, status: "completed", model, output: [], usage }, citations, server_side_tool_usage: toolUsage(web.length, x.length) });
            })();
          }
          const channel = createChannel<string>();
          let resolveData!: (data: any) => void;
          const dataPromise = new Promise<any>((resolve) => (resolveData = resolve));
          searcher.search(query, bearer(headers), (chunk) => channel.push(chunk)).then((data) => { channel.push(streamTail(data.pages.length, data.posts.length, data.elapsedMs ?? 0)); resolveData(data); channel.close(); }).catch((error: any) => { channel.push(`\n[搜索失败：${error?.message ?? error}]\n`); resolveData(null); channel.close(); });
          set.headers["content-type"] = "text/event-stream; charset=utf-8";
          return (async function* () {
            const send = (type: string, payload: Record<string, unknown>) => sse({ event: type, data: { type, ...payload } });
            const head = streamHead(query);
            let full = head;
            yield send("response.created", { response: { id: responseId, object: "response", created_at: created, status: "in_progress", model } });
            yield send("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
            yield send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
            yield send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: head });
            while (true) { const piece = await channel.next(); if (piece === null) break; full += piece; yield send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: piece }); }
            yield send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text: full });
            yield send("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: full } });
            yield send("response.output_item.done", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: full, annotations: [] }] } });
            const data = await dataPromise;
            let citations: string[] = [];
            let serverTools = toolUsage(0, 0);
            if (data) {
              const { web, x } = searchCallItems(data);
              citations = sourceUrls(data);
              serverTools = toolUsage(web.length, x.length);
              let outputIndex = 1;
              for (const item of [...web, ...x].filter((it) => it.action.sources.length > 0)) { yield send("response.output_item.added", { output_index: outputIndex, item }); yield send("response.output_item.done", { output_index: outputIndex, item }); outputIndex += 1; }
            }
            yield send("response.completed", { response: { id: responseId, object: "response", created_at: created, status: "completed", model, output: [], usage }, citations, server_side_tool_usage: serverTools });
          })();
        }

        // ================= grok-search 模型 =================
        if (!body?.stream) {
          let data; try { data = await searcher.chat(query, bearer(headers)); } catch (error: any) { set.status = error instanceof NoAccountError ? 503 : 502; return err(error instanceof NoAccountError ? "no_account" : "upstream_failed", error.message, "server_error"); }
          const json = toJSON(data);
          const searchText = buildAnswer(data, query, snippetMax).text;
          const text = (data.answer ?? "").trim() || searchText;
          const citations = sourceUrls(data);
          const annotations = buildAnswer(data, query, snippetMax).citations.map((c, i) => ({ type: "url_citation", url: c.url, title: String(i + 1), start_index: c.start_index, end_index: c.end_index }));
          const { web, x, output } = searchOutput(data, text, annotations);
          return { id: responseId, object: "response", created_at: created, status: "completed", model, output, citations, server_side_tool_usage: toolUsage(web.length, x.length), usage: { ...usage, num_sources_used: citations.length, num_server_side_tools_used: web.length + x.length }, search: json };
        }
        const channel = createChannel<string>();
        let resolveData!: (data: any) => void;
        const dataPromise = new Promise<any>((resolve) => (resolveData = resolve));
        searcher.chat(query, bearer(headers), { onSearch: (chunk) => channel.push(chunk), onText: (t) => channel.push(t) })
          .then((data) => { resolveData(data); channel.close(); })
          .catch((error: any) => { resolveData(null); channel.close(); });
        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        return (async function* () {
          const send = (type: string, payload: Record<string, unknown>) => sse({ event: type, data: { type, ...payload } });
          let full = "";
          yield send("response.created", { response: { id: responseId, object: "response", created_at: created, status: "in_progress", model } });
          yield send("response.output_item.added", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] } });
          yield send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "" } });
          while (true) { const piece = await channel.next(); if (piece === null) break; full += piece; yield send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: piece }); }
          const data = await dataPromise;
          if (data && !full.trim()) { full = buildAnswer(data, query, snippetMax).text; }
          yield send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text: full });
          yield send("response.content_part.done", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: full } });
          yield send("response.output_item.done", { output_index: 0, item: { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: full, annotations: [] }] } });
          let citations: string[] = [];
          let serverTools = toolUsage(0, 0);
          if (data) {
            const { web, x } = searchCallItems(data);
            citations = sourceUrls(data);
            serverTools = toolUsage(web.length, x.length);
            let outputIndex = 1;
            for (const item of [...web, ...x].filter((it) => it.action.sources.length > 0)) { yield send("response.output_item.added", { output_index: outputIndex, item }); yield send("response.output_item.done", { output_index: outputIndex, item }); outputIndex += 1; }
          }
          yield send("response.completed", { response: { id: responseId, object: "response", created_at: created, status: "completed", model, output: [], usage }, citations, server_side_tool_usage: serverTools });
        })();
      }, { body: t.Object({ input: t.Optional(t.Any()), instructions: t.Optional(t.String()), stream: t.Optional(t.Boolean()), search_format: t.Optional(t.String()) }, { additionalProperties: true }) }),
  )

  // ---------- 面板 API（Basic 认证 + 浏览器原生登录框） ----------
  .group("/admin", (group) =>
    group
      .guard({ beforeHandle: guardPanel })
      .get("/state", () => snapshot())
      // SSE：每 2 秒推一次状态快照，前端只更新数据不刷新页面
      .get("/stream", async function* () {
        while (true) {
          yield sse({ data: snapshot() });
          await new Promise((r) => setTimeout(r, 2_000));
        }
      })
      .post("/accounts", async ({ body, set }: any) => {
        try { const account = await pool.add(body); return { ok: true, account: { id: account.id, uid: account.uid, name: account.name } }; }
        catch (error: any) { set.status = 400; return err("account_add_failed", error.message); }
      }, { body: t.Object({ uid: t.String(), sso: t.String(), name: t.Optional(t.String()), id: t.Optional(t.String()) }, { additionalProperties: true }) })
      // 批量导入：每行一个 sso（可带 "sso=" 前缀），自动调 /api/auth/session 解析 uid
      .post("/accounts/import", async ({ body, set }: any) => {
        const lines = [...new Set(String(body?.sso ?? "").split("\n").map((line: string) => line.trim().replace(/^sso=/i, "").split(";")[0]!.trim()).filter(Boolean))];
        if (lines.length === 0) { set.status = 400; return err("invalid_request", "没有解析到 SSO（每行一个）"); }
        let added = 0;
        const errors: Array<{ sso: string; error: string }> = [];
        // 小并发（4 路）解析 uid，避免大号池导入太慢
        const queue = [...lines];
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length > 0) {
            const sso = queue.shift()!;
            try { await pool.add({ uid: await resolveUid(sso, clearance), sso }); added += 1; }
            catch (error: any) { errors.push({ sso: `${sso.slice(0, 12)}…`, error: String(error?.message ?? error) }); }
          }
        }));
        return { ok: true, total: lines.length, added, failed: errors.length, errors: errors.slice(0, 10) };
      }, { body: t.Object({ sso: t.String() }, { additionalProperties: true }) })
      .delete("/accounts/:id", async ({ params, set }: any) => {
        try { return (await pool.remove(params.id)) ? { ok: true } : (set.status = 404, err("not_found", "账号不存在")); }
        catch (error: any) { set.status = 409; return err("account_busy", error.message); }
      })
      .post("/accounts/reload", () => ({ ok: true, total: (pool.load(), pool.stats().total) }))
      .post("/clearance/refresh", async () => ({ ok: true, ...(await clearance.refresh()) }))
      // 手动触发全量配额刷新（后台跑，进度看 /admin/stream 的 status.quota）
      .post("/quota/refresh", () => { void quota.refreshAll(); return { ok: true, total: pool.stats().total }; })
      // 日志分页：?before=<id>&limit=50（面板滚动加载历史）
      .get("/logs", ({ query }: any) => ({ logs: getLogs(query?.before ? Number(query.before) : undefined, Number(query?.limit ?? 50) || 50) }))
      // 单条日志的结果快照（点击日志查看搜索结果内容）
      .get("/results/:id", ({ params, set }: any) => {
        const result = getSearchResult(Number(params.id));
        if (!result) { set.status = 404; return err("not_found", "结果快照不存在或已过期"); }
        return { id: Number(params.id), ...result };
      })
      .post("/search", async ({ body, set }: any) => {
        const query = String(body?.query ?? "").trim();
        if (!query) { set.status = 400; return err("invalid_request", "query 不能为空"); }
        try { const data = await searcher.search(query, "panel"); return { ok: true, text: toText(data, query, snippetMax), ...toJSON(data) }; }
        catch (error: any) { set.status = 502; return err("search_failed", error.message, "server_error"); }
      }, { body: t.Object({ query: t.String() }, { additionalProperties: true }) }),
  )

  // ---------- 面板前端（Basic 认证；必须放在参数路由之后） ----------
  .get("/", ({ headers, set }) => (basicOk(headers) ? new Response(Bun.file(`${WEB_DIR}/index.html`)) : challenge(set)))
  .get("/assets/:file", ({ headers, params, set }) => {
    if (!basicOk(headers)) return challenge(set);
    const file = Bun.file(`${WEB_DIR}/${params.file}`);
    return file.size ? new Response(file) : (set.status = 404, "not found");
  })

  // ---------- 统一错误 ----------
  .onError(({ code, error, set }: any) => {
    if (code === "VALIDATION") { set.status = 400; return err("invalid_request", String(error?.message ?? "参数错误")); }
    log("error", "unhandled_error", { code, message: String(error?.message ?? error) });
    set.status = typeof set.status === "number" && set.status >= 400 ? set.status : 500;
    return err("internal_error", "服务内部错误", "server_error");
  })
  .listen({ port: config.port, hostname: "0.0.0.0" });

log("info", "listening", { port: config.port });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { log("info", "shutdown", { signal }); process.exit(0); });
