/**
 * grok.ts —— 上游三合一：号池 + Cloudflare 清关 + WebSocket 搜索采集
 *
 * 全部逆向结论都集中在本文件（协议、帧类型、模型代号），其余文件只做 HTTP 与展示。
 * 设计原则：单路会话、失败换号重试；因为不等正文总结，卡顿概率极低，无需并发竞速。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { streamItem, toJSON, toText } from "./format.ts";

// ============================================================================
// 类型
// ============================================================================

export interface Account {
  id: string;
  name?: string;
  uid: string;
  sso: string;
}

/** 网页结果（snippet 是上游给的正文节选，是本项目的核心价值） */
export interface Page {
  url: string;
  title: string;
  snippet: string;
  query: string;
}

/** X 帖子结果 */
export interface Post {
  url: string;
  handle: string;
  name: string;
  text: string;
  createdAt: string;
  views?: number;
  likes?: number;
  query: string;
}

/** 一次搜索的结果集 */
export interface SearchData {
  queries: string[];
  pages: Page[];
  posts: Post[];
  /** 首个搜索结果到达的时间（毫秒，面板"首字"指标） */
  firstResultMs?: number;
  elapsedMs?: number;
}

/** 请求日志（内存环形缓冲 + 结果快照，供面板展示与点击查看） */
export interface LogEntry {
  /** 自增 id：面板分页与结果查询都用它 */
  id: number;
  at: string;
  caller: string;
  query?: string;
  accountId?: string;
  pages?: number;
  posts?: number;
  /** 首个搜索结果耗时（毫秒） */
  firstResultMs?: number;
  elapsedMs?: number;
  ok: boolean;
  error?: string;
}

/** 会话配置（由 index.ts 传入，避免文件间循环依赖） */
export interface SearchConfig {
  instruction: string;
  quietMs: number;
  maxMs: number;
  attempts: number;
  maxPages: number;
  maxPosts: number;
  sessionModel: string;
  baseUrl: string;
  clearanceTtlMs: number;
  /** 首个搜索进展超时：哑号（不搜索/卡住）快速让位的时限 */
  firstProgressMs: number;
  /** 正文节选裁剪长度（存储结果快照用） */
  snippetMaxChars: number;
}

// ============================================================================
// 极简日志 + 结果快照（面板数据源）
// ============================================================================

/** 日志环形缓冲（最新在数组末尾；面板按 id 倒序分页） */
export const recentLogs: LogEntry[] = [];
/** 自增日志 id */
let logSeq = 0;
/** 结果快照：logId -> { text, json }；只保留最近 N 条，避免内存膨胀 */
const resultStore = new Map<number, { text: string; json: unknown }>();
const RESULT_KEEP = 300;

/** 打一行 JSON 日志（控制台） */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** 写入一条搜索日志（同时保存结果快照，供面板点击查看） */
export function recordSearch(entry: Omit<LogEntry, "id" | "at">, result?: { text: string; json: unknown }): LogEntry {
  const full: LogEntry = { id: ++logSeq, at: new Date().toISOString(), ...entry };
  recentLogs.push(full);
  if (recentLogs.length > 2000) recentLogs.splice(0, recentLogs.length - 2000);
  if (result) {
    resultStore.set(full.id, result);
    // 超出保留量时删掉最旧的快照
    while (resultStore.size > RESULT_KEEP) {
      const oldest = resultStore.keys().next().value;
      if (oldest === undefined) break;
      resultStore.delete(oldest);
    }
  }
  return full;
}

/** 日志分页：返回 id < before 的最近 limit 条（倒序，最新在前） */
export function getLogs(before?: number, limit = 50): LogEntry[] {
  const filtered = before ? recentLogs.filter((item) => item.id < before) : recentLogs;
  return filtered.slice(-Math.max(1, Math.min(limit, 500))).reverse();
}

/** 取某条日志的结果快照（点击日志/查看详情用） */
export function getSearchResult(id: number): { text: string; json: unknown } | undefined {
  return resultStore.get(id);
}

// ============================================================================
// 号池：轮询取号、单号并发 1、失败冷却、增删落盘
// ============================================================================

export class Pool {
  private accounts: (Account & { busy: boolean; cooldownUntil: number; ok: number; fail: number; lastError?: string })[] = [];
  private cursor = 0;

  constructor(
    private file: string,
    private cooldownMs = 60_000,
  ) {}

  /** 载入号池（uid 去重、字段校验；空文件允许启动，可后台再添加） */
  load() {
    if (!this.file || !existsSync(this.file)) return;
    const list = JSON.parse(readFileSync(this.file, "utf8"));
    const seen = new Set<string>();
    const before = new Map(this.accounts.map((a) => [a.uid, a]));
    this.accounts = (Array.isArray(list) ? list : []).flatMap((a: any) => {
      if (!a?.uid || !a?.sso || seen.has(a.uid) || !/^[0-9a-f-]{36}$/i.test(a.uid)) return [];
      seen.add(a.uid);
      const old = before.get(a.uid);
      return [{ id: a.id ?? `web-${a.uid.slice(0, 8)}`, name: a.name, uid: a.uid, sso: a.sso, busy: false, cooldownUntil: 0, ok: old?.ok ?? 0, fail: old?.fail ?? 0 }];
    });
    this.cursor = 0;
  }

  /** 写回文件（先 tmp 再 rename；bind mount 场景退化为就地写） */
  save() {
    const plain = this.accounts.map(({ id, name, uid, sso }) => ({ id, name, uid, sso }));
    const json = JSON.stringify(plain, null, 2);
    try {
      writeFileSync(`${this.file}.tmp`, json, { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      writeFileSync(this.file, json, { mode: 0o600 });
      try { unlinkSync(`${this.file}.tmp`); } catch {}
    }
  }

  stats() {
    const now = Date.now();
    const idle = this.accounts.filter((a) => !a.busy && a.cooldownUntil <= now).length;
    return { total: this.accounts.length, idle, busy: this.accounts.filter((a) => a.busy).length, cooldown: this.accounts.filter((a) => !a.busy && a.cooldownUntil > now).length };
  }

  /** 面板用列表（sso 打码，绝不外泄凭据） */
  list() {
    return this.accounts.map(({ sso, ...rest }) => ({ ...rest, ssoMasked: `${sso.slice(0, 8)}…(${sso.length})` }));
  }

  /** 取一个空闲账号（跳过忙/冷却；轮询保证均匀） */
  acquire() {
    const now = Date.now();
    for (let i = 0; i < this.accounts.length; i++) {
      const account = this.accounts[(this.cursor + i) % this.accounts.length]!;
      if (account.busy || account.cooldownUntil > now) continue;
      account.busy = true;
      this.cursor = (this.cursor + i + 1) % this.accounts.length;
      return account;
    }
    return null;
  }

  /** 归还账号：失败进冷却，成功+1 */
  release(account: Account, ok: boolean, error?: string) {
    const target = this.accounts.find((a) => a.uid === account.uid);
    if (!target) return;
    target.busy = false;
    if (ok) target.ok += 1;
    else {
      target.fail += 1;
      target.lastError = error?.slice(0, 200);
      target.cooldownUntil = Date.now() + this.cooldownMs;
    }
  }

  async add(input: { uid: string; sso: string; name?: string; id?: string }) {
    if (!/^[0-9a-f-]{36}$/i.test(input.uid)) throw new Error("uid 必须是 grok.com 用户 uuid");
    if (!input.sso || input.sso.length < 20) throw new Error("sso 内容过短");
    const existing = this.accounts.find((a) => a.uid === input.uid);
    if (existing) {
      existing.sso = input.sso;
      if (input.name) existing.name = input.name;
      this.save();
      return existing;
    }
    const account = { id: input.id || `web-${this.accounts.length + 1}-${input.uid.slice(0, 8)}`, name: input.name, uid: input.uid, sso: input.sso, busy: false, cooldownUntil: 0, ok: 0, fail: 0 };
    this.accounts.push(account);
    try { this.save(); } catch (error) { this.accounts.pop(); throw error; }
    return account;
  }

  async remove(idOrUid: string) {
    const index = this.accounts.findIndex((a) => a.id === idOrUid || a.uid === idOrUid);
    if (index < 0) return false;
    if (this.accounts[index]!.busy) throw new Error("账号正在使用中");
    const [removed] = this.accounts.splice(index, 1);
    try { this.save(); } catch (error) { this.accounts.splice(index, 0, removed!); throw error; }
    return true;
  }
}

// ============================================================================
// Cloudflare 清关（FlareSolverr 单飞缓存）
// ============================================================================

export class Clearance {
  private cache?: { cookie: string; ua: string; expiresAt: number };
  private inflight?: Promise<{ cookie: string; ua: string }>;

  constructor(
    private url: string,
    private ttlMs: number,
  ) {}

  status() {
    return { cached: !!this.cache && this.cache.expiresAt > Date.now(), expiresAt: this.cache?.expiresAt };
  }

  async get(force = false) {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  /** POST FlareSolverr {cmd:request.get} -> cookies + userAgent（UA 与 Cookie 绑定，必须成套使用） */
  async refresh() {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: "https://grok.com", maxTimeout: 60_000 }),
      signal: AbortSignal.timeout(75_000),
    });
    const body: any = await response.json();
    if (body.status !== "ok" || !body.solution) throw new Error(`清关失败：${body.message ?? body.status}`);
    const cookie = (body.solution.cookies ?? []).map((c: any) => `${c.name}=${c.value}`).join("; ");
    this.cache = { cookie, ua: body.solution.userAgent, expiresAt: Date.now() + this.ttlMs };
    log("info", "clearance_refreshed", { cookies: body.solution.cookies?.length ?? 0 });
    return { cookie, ua: body.solution.userAgent };
  }
}

/** 用 SSO 凭据向 grok.com 查询账号身份，自动解析 uid（面板批量导入用） */
export async function resolveUid(sso: string, clearance: Clearance): Promise<string> {
  const material = await clearance.get();
  const response = await fetch("https://grok.com/api/auth/session", {
    headers: {
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Cookie: [`sso=${sso}`, `sso-rw=${sso}`, material.cookie].join("; "),
      Pragma: "no-cache",
      Referer: "https://grok.com/",
      "User-Agent": material.ua,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error("SSO 已失效（401）");
  if (!response.ok) throw new Error(`身份接口返回 ${response.status}`);
  const body: any = await response.json().catch(() => null);
  const uid = body?.session?.userId ?? body?.user?.id ?? body?.user?.userId ?? body?.userId ?? body?.id ?? body?.sub;
  if (typeof uid !== "string" || !/^[0-9a-f-]{36}$/i.test(uid)) throw new Error("无法从 SSO 解析 uid（凭据无效？）");
  return uid;
}

// ============================================================================
// 帧解析（纯函数：真实帧夹具单测覆盖，协议改动会在这里报警）
// ============================================================================

export interface FrameState { answerStarted: boolean }
export type FrameEvent =
  | { type: "query"; kind: "web" | "x"; callId: string; query: string }
  | { type: "pages"; callId: string; pages: Omit<Page, "query">[] }
  | { type: "posts"; callId: string; posts: Omit<Post, "query">[] }
  | { type: "answer" }
  | { type: "error"; message: string };

/** 把上游 event 翻译成搜索语义事件（不关心的帧返回 null） */
export function parseFrame(event: any, state: FrameState): FrameEvent | null {
  // 搜索卡片：拿到搜索词（tool_result 帧不带搜索词，要用 callId 关联）
  if (event?.type === "response.chunk" && event.chunk?.tool_usage_card) {
    const card = event.chunk.tool_usage_card;
    const callId = String(card.tool_usage_card_id ?? card.id ?? "");
    const kind = card.web_search ? "web" : card.x_search ? "x" : "";
    const query = String((card.web_search ?? card.x_search)?.args?.query ?? "");
    return kind ? { type: "query", kind: kind as "web" | "x", callId, query } : null;
  }
  // 搜索结果：网页（url/title/snippet）与 X 帖子（全文/作者/时间/互动数）
  if (event?.type === "response.chunk" && event.chunk?.tool_result) {
    const result = event.chunk.tool_result;
    const callId = String(result.tool_call_id ?? result.tool_usage_card_id ?? "");
    const webpages = result.web_search?.webpages;
    if (Array.isArray(webpages) && webpages.length) {
      return { type: "pages", callId, pages: webpages.filter((p: any) => p?.url).map((p: any) => ({ url: String(p.url), title: String(p.title ?? ""), snippet: String(p.snippet ?? "") })) };
    }
    const posts = result.x_post?.posts;
    if (Array.isArray(posts) && posts.length) {
      return {
        type: "posts",
        callId,
        posts: posts
          .filter((p: any) => p?.post_id && p?.userhandle)
          .map((p: any) => ({
            url: `https://x.com/${encodeURIComponent(p.userhandle)}/status/${p.post_id}`,
            handle: String(p.userhandle),
            name: String(p.name ?? p.userhandle),
            text: String(p.text ?? ""),
            createdAt: String(p.create_time ?? ""),
            views: typeof p.view_count === "number" ? p.view_count : undefined,
            likes: typeof p.favorite_count === "number" ? p.favorite_count : undefined,
          })),
      };
    }
    return null;
  }
  // 正文出现 = 搜索阶段结束（不等总结，立刻收工）
  if (event?.type === "response.chunk" && event.chunk?.text?.text) {
    const channel = String(event.chunk.text.channel ?? "").toUpperCase();
    if (!channel.includes("ANALYSIS") && !channel.includes("REASONING") && !state.answerStarted) {
      state.answerStarted = true;
      return { type: "answer" };
    }
    return null;
  }
  if ((event?.type === "response.output_text.delta" || event?.type === "response.output_text.done") && !state.answerStarted) {
    if (event.delta || event.text) { state.answerStarted = true; return { type: "answer" }; }
    return null;
  }
  // 上游业务错误
  if (event?.type === "response.grok.output" && event.output?.stream_error) {
    return { type: "error", message: String(event.output.stream_error.message ?? event.output.stream_error.kind ?? "上游错误") };
  }
  if (event?.type === "error") return { type: "error", message: String(event.error?.message ?? "上游错误") };
  return null;
}

// ============================================================================
// 单路会话：握手 -> 发问 -> 收帧 -> 按终止条件收工
// ============================================================================

export class SessionError extends Error {}

/** 采集一路会话的搜索结果；失败抛 SessionError（由 Searcher 决定是否换号重试）。
 *  emit：可选增量回调——每收集到一条新结果立即回调（供流式接口边搜边发）。 */
export function collectSession(account: Account, query: string, config: SearchConfig, clearance: Clearance, callId: () => string, signal: AbortSignal, emit?: (kind: "page" | "post", item: Page | Post) => void): Promise<SearchData> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const data: SearchData = { queries: [], pages: [], posts: [] };
    const queryByCall = new Map<string, string>();
    const seenPage = new Set<string>();
    const seenPost = new Set<string>();
    const frameState: FrameState = { answerStarted: false };

    let ws: WebSocket | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    let firstProgressTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let done = false;
    let settled = false;

    /** 收工/失败统一出口（清资源、补耗时与上限、只结算一次） */
    const finish = (ok: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      clearTimeout(firstProgressTimer);
      clearInterval(heartbeat);
      try { ws?.close(); } catch {}
      if (ok) {
        data.elapsedMs = Date.now() - startedAt;
        data.pages = data.pages.slice(0, config.maxPages);
        data.posts = data.posts.slice(0, config.maxPosts);
        resolve(data);
      } else {
        reject(error ?? new SessionError("未获得搜索结果"));
      }
    };

    // 哑号快速失败：限时内没有任何搜索进展（连搜索词都没有）就直接换号
    firstProgressTimer = setTimeout(() => finish(false, new SessionError("上游长时间没有搜索进展")), config.firstProgressMs);

    // 硬超时：有结果就带着结果返回，没结果算失败（换号重试）
    maxTimer = setTimeout(() => finish(data.pages.length + data.posts.length > 0, new SessionError("会话超时且无结果")), config.maxMs);

    // 取消信号（进程退出/上游异常时清理）
    const onAbort = () => finish(false, new SessionError("会话被取消"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    // ---- 建连 ----
    clearance
      .get()
      .then((material) => {
        const base = new URL(config.baseUrl);
        base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
        base.pathname = "/ws/mgw/";
        base.search = new URLSearchParams({ uid: account.uid }).toString();

        ws = new WebSocket(base.toString(), {
          headers: {
            Origin: new URL(config.baseUrl).origin,
            "User-Agent": material.ua, // 必须与清关时一致
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Cookie: [`sso=${account.sso}`, `sso-rw=${account.sso}`, material.cookie, `x-userid=${account.uid}`].filter(Boolean).join("; "),
          },
        } as never);

        let sessionId = "";
        let created = false;
        let attached = false;
        let turnSent = false;

        /** 搜索活动重置静默计时；有结果后静默 quietMs 即收工 */
        const bump = () => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => {
            if (data.pages.length + data.posts.length > 0) finish(true);
          }, config.quietMs);
        };

        const sendTurn = () => {
          if (!created || !attached || turnSent) return;
          turnSent = true;
          ws!.send(JSON.stringify({ session_id: sessionId, event: { type: "conversation.item.create", event_id: callId(), item: { type: "message", role: "user", x_grok: { client_message_id: callId(), input_chunks: [{ text: { text: `[system]\n${config.instruction}\n\n[user]\n${query}` } }] } } } }));
          ws!.send(JSON.stringify({ session_id: sessionId, event: { type: "response.create", event_id: callId() } }));
        };

        ws.addEventListener("open", () => {
          // 会话模型名是内部代号（fast/auto/expert/heavy），不是 grok-chat-fast！
          ws!.send(JSON.stringify({ event: { type: "session.create", event_id: callId(), session: { model: config.sessionModel, x_grok: { protocol_capabilities: ["conversation_attached", "custom_methods_v1"], use_chunk: true, enable_side_by_side: true, force_side_by_side: false, enable_image_generation: true, image_generation_count: 2, disable_text_follow_ups: false, disable_artifact: true, force_concise: false, keep_context: false, is_temporary: true, disable_memory: true } } } }));
          heartbeat = setInterval(() => { try { ws?.send(JSON.stringify({ event: { type: "ping", event_id: callId() } })); } catch {} }, 20_000);
        });

        ws.addEventListener("error", () => finish(false, new SessionError("WebSocket 连接失败")));
        ws.addEventListener("close", () => { if (!done) finish(false, new SessionError("上游连接提前关闭")); });

        ws.addEventListener("message", (message) => {
          if (typeof message.data !== "string") return;
          let envelope: any;
          try { envelope = JSON.parse(message.data); } catch { return; }
          const event = envelope?.event;
          if (!event?.type) return;

          // 握手状态机
          if (event.type === "session.created") { created = true; sessionId = sessionId || envelope.session_id || event.session?.id || ""; return sendTurn(); }
          if (event.type === "conversation.attached") { attached = true; sessionId = sessionId || event.conversation?.id || envelope.session_id || ""; return sendTurn(); }
          if (event.type === "response.done") { done = true; return finish(data.pages.length + data.posts.length > 0, new SessionError("上游结束且无结果")); }
          if (event.type === "session.ended") { if (!done) finish(false, new SessionError("上游会话提前结束")); return; }

          // 搜索语义事件
          const parsed = parseFrame(event, frameState);
          if (!parsed) return;
          if (parsed.type === "error") return finish(false, new SessionError(parsed.message));
          if (parsed.type === "answer") { if (data.pages.length + data.posts.length > 0) finish(true); return; }
          if (parsed.type === "query") {
            if (parsed.query.trim()) { queryByCall.set(parsed.callId, parsed.query.trim()); if (!data.queries.includes(parsed.query.trim())) data.queries.push(parsed.query.trim()); }
            clearTimeout(firstProgressTimer); // 已有搜索进展，撤销哑号计时
            return bump();
          }
          const q = queryByCall.get(parsed.callId) ?? data.queries.at(-1) ?? "";
          if (parsed.type === "pages") for (const page of parsed.pages) { if (seenPage.has(page.url)) continue; seenPage.add(page.url); const item = { ...page, query: q }; data.pages.push(item); emit?.("page", item); }
          if (parsed.type === "posts") for (const post of parsed.posts) { if (seenPost.has(post.url)) continue; seenPost.add(post.url); const item = { ...post, query: q }; data.posts.push(item); emit?.("post", item); }
          // 记录首个搜索结果的到达时间（面板"首字"指标，衡量搜索链路快慢）
          if (data.firstResultMs === undefined) data.firstResultMs = Date.now() - startedAt;
          clearTimeout(firstProgressTimer);
          bump();
        });
      })
      .catch((error) => finish(false, new SessionError(String(error?.message ?? error))));
  });
}

// ============================================================================
// 搜索入口：单路 + 失败换号重试
// ============================================================================

export class NoAccountError extends Error {}

export class Searcher {
  constructor(
    private pool: Pool,
    private clearance: Clearance,
    private config: SearchConfig,
  ) {}

  /** 搜索一次：按 attempts 换号重试（不等总结，正常 3~18 秒返回）
   *  onDelta：可选增量回调——流式接口用它实现"边搜边发"（每收集到一条结果立即回调）。 */
  async search(query: string, caller: string, onDelta?: (chunk: string) => void): Promise<SearchData> {
    const startedAt = Date.now();
    let lastError: Error | undefined;
    // 流式跨尝试去重：某一路失败换号后，已经下发过的结果不重复发
    const streamed = new Set<string>();
    let streamIndex = 0;
    const emit = onDelta
      ? (kind: "page" | "post", item: Page | Post) => {
          if (streamed.has(item.url)) return;
          streamed.add(item.url);
          onDelta(streamItem(kind, item, ++streamIndex, this.config.snippetMaxChars));
        }
      : undefined;
    for (let attempt = 0; attempt < this.config.attempts; attempt++) {
      const account = this.pool.acquire();
      if (!account) throw new NoAccountError("号池无可用账号");
      try {
        const data = await collectSession(account, query, this.config, this.clearance, () => crypto.randomUUID(), new AbortController().signal, emit);
        this.pool.release(account, true);
        // 存日志 + 结果快照（面板里点这条日志就能看到完整搜索结果）
        const entry = recordSearch(
          { caller, query, accountId: account.id, pages: data.pages.length, posts: data.posts.length, firstResultMs: data.firstResultMs, elapsedMs: data.elapsedMs ?? Date.now() - startedAt, ok: true },
          { text: toText(data, query, this.config.snippetMaxChars), json: toJSON(data) },
        );
        log("info", "search", { logId: entry.id, caller, query, accountId: account.id, pages: data.pages.length, posts: data.posts.length, firstResultMs: data.firstResultMs, elapsedMs: entry.elapsedMs, ok: true });
        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.pool.release(account, false, lastError.message);
        // 每次换号都记一行（控制台可见），方便定位坏号与失败原因
        log("warn", "search_attempt_failed", { caller, query, accountId: account.id, attempt: attempt + 1, error: lastError.message });
      }
    }
    const entry = recordSearch({ caller, query, elapsedMs: Date.now() - startedAt, ok: false, error: lastError?.message });
    log("warn", "search", { logId: entry.id, caller, query, elapsedMs: entry.elapsedMs, ok: false, error: lastError?.message });
    throw lastError ?? new Error("搜索失败");
  }
}
