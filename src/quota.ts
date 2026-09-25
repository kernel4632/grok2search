/**
 * quota.ts —— 账号配额：直查上游 + 落盘缓存 + 定时/顺带刷新
 *
 * 上游接口（Web 端同源 fetch，已实测可用）：
 *   POST {baseUrl}/rest/rate-limits   body: {"modelName":"fast"}（或 "auto"）
 *   请求要带 SSO 与 CF 清关 Cookie；响应：
 *   { "windowSizeSeconds":86400, "remainingQueries":14, "totalQueries":30 }
 *
 * 面板展示每个号的剩余额度；号池选号时优先跳过 fast 已耗尽的号。
 * 数据流：
 *   - 启动 20 秒后全量刷一次（小并发 + 轻微限速），之后按 intervalMs 周期刷新；
 *   - 每次搜索结束后顺带刷新该号（40 秒内查过就跳过），失败静默；
 *   - 面板「刷新配额」按钮可手动触发全量刷新，进度通过 SSE 状态推送。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log, type Account, type Clearance } from "./grok.ts";

// ============================================================================
// 类型
// ============================================================================

/** 单个模型的额度窗口 */
export interface QuotaWindow {
  remaining: number;
  total: number;
  windowSeconds: number;
  /** 窗口重置时间（毫秒时间戳；上游只给窗口长度，这里按同步时刻顺延估算） */
  resetAt: number;
  syncedAt: number;
}

/** 一个账号的额度状态（fast/auto 各一个窗口；error 记录失效/被封等） */
export interface QuotaState {
  fast?: QuotaWindow;
  auto?: QuotaWindow;
  error?: string;
  updatedAt: number;
}

export type QuotaMode = "fast" | "auto";
const MODES: QuotaMode[] = ["fast", "auto"];

// ============================================================================
// 落盘缓存：uid -> QuotaState（data/quota.json）
// ============================================================================

export class QuotaStore {
  private map: Record<string, QuotaState> = {};

  constructor(private file: string) {
    this.load();
  }

  load() {
    try {
      this.map = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    } catch {
      this.map = {};
    }
  }

  get(uid: string): QuotaState | undefined {
    return this.map[uid];
  }

  all() {
    return this.map;
  }

  /** 写入一个模式的结果；value 为错误时只记 error（保留旧的窗口数据） */
  set(uid: string, mode: QuotaMode, value: QuotaWindow | { error: string }) {
    const state = this.map[uid] ?? (this.map[uid] = { updatedAt: 0 });
    if ("error" in value) state.error = value.error;
    else {
      state[mode] = value;
      delete state.error;
    }
    state.updatedAt = Date.now();
  }

  /** 先写临时文件再改名，避免半截 JSON */
  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (error: any) {
      log("warn", "quota_save_failed", { error: String(error?.message ?? error) });
    }
  }
}

// ============================================================================
// 上游查询
// ============================================================================

/** 查一个账号一个模型的额度（带超时；401/403 记为账号失效） */
export async function fetchQuotaWindow(
  account: Pick<Account, "uid" | "sso">,
  material: { cookie: string; ua: string },
  mode: QuotaMode,
  baseUrl: string,
): Promise<QuotaWindow> {
  const response = await fetch(`${baseUrl}/rest/rate-limits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "User-Agent": material.ua,
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      "x-xai-request-id": crypto.randomUUID(),
      Cookie: [`sso=${account.sso}`, `sso-rw=${account.sso}`, material.cookie, `x-userid=${account.uid}`].join("; "),
    },
    body: JSON.stringify({ modelName: mode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error(`SSO 失效或被封（HTTP ${response.status}）`);
  if (!response.ok) throw new Error(`额度接口 HTTP ${response.status}`);
  const value = (await response.json().catch(() => ({}))) as { windowSizeSeconds?: number; remainingQueries?: number; totalQueries?: number };
  if (!value.totalQueries || value.totalQueries <= 0) throw new Error("额度响应缺少 totalQueries");
  const now = Date.now();
  const windowSeconds = value.windowSizeSeconds && value.windowSizeSeconds > 0 ? value.windowSizeSeconds : 7200;
  return {
    remaining: Math.max(0, value.remainingQueries ?? 0),
    total: value.totalQueries,
    windowSeconds,
    resetAt: now + windowSeconds * 1000,
    syncedAt: now,
  };
}

// ============================================================================
// 刷新器：全量周期刷新 + 单号顺带刷新
// ============================================================================

export class QuotaRefresher {
  private running = false;
  private lastRunAt = 0;
  private progress = { done: 0, total: 0, ok: 0, fail: 0 };

  constructor(
    private store: QuotaStore,
    private clearance: Clearance,
    private accounts: () => Array<Pick<Account, "uid" | "sso">>,
    private opts: { baseUrl: string; intervalMs: number; initialDelayMs: number; concurrency: number },
  ) {}

  status() {
    return { running: this.running, lastRunAt: this.lastRunAt || undefined, progress: this.progress, intervalMs: this.opts.intervalMs };
  }

  /** 启动周期刷新（intervalMs<=0 表示关闭自动刷新，只保留手动/顺带刷新） */
  start() {
    if (this.opts.intervalMs <= 0) return;
    setTimeout(() => void this.refreshAll(), this.opts.initialDelayMs);
    const timer = setInterval(() => void this.refreshAll(), this.opts.intervalMs);
    timer.unref?.();
  }

  /** 搜索结束后顺带刷新该号（短时间查过就跳过；失败静默，不影响搜索） */
  touch(account: Account) {
    const recent = this.store.get(account.uid);
    if (recent && Date.now() - recent.updatedAt < 40_000) return;
    void this.refreshOne(account).catch(() => {});
  }

  /** 刷新单个账号的 fast+auto（两个模式互不影响；全失败才抛错） */
  async refreshOne(account: Pick<Account, "uid" | "sso">) {
    const material = await this.clearance.get();
    let error: string | undefined;
    for (const mode of MODES) {
      try {
        this.store.set(account.uid, mode, await fetchQuotaWindow(account, material, mode, this.opts.baseUrl));
      } catch (err: any) {
        error = String(err?.message ?? err);
        this.store.set(account.uid, mode, { error });
      }
    }
    if (error) throw new Error(error);
  }

  /** 全量刷新：小并发 + 轻微限速，避免打爆上游；每 25 个号落盘一次 */
  async refreshAll() {
    if (this.running) return;
    this.running = true;
    const list = this.accounts();
    this.progress = { done: 0, total: list.length, ok: 0, fail: 0 };
    log("info", "quota_refresh_start", { total: list.length, concurrency: this.opts.concurrency });
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.max(1, this.opts.concurrency) }, async () => {
        while (cursor < list.length) {
          const account = list[cursor++]!;
          try {
            await this.refreshOne(account);
            this.progress.ok += 1;
          } catch {
            this.progress.fail += 1;
          }
          this.progress.done += 1;
          if (this.progress.done % 25 === 0) this.store.save();
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      }),
    );
    this.store.save();
    this.running = false;
    this.lastRunAt = Date.now();
    log("info", "quota_refresh_done", { ...this.progress, elapsedMs: this.lastRunAt });
  }
}
