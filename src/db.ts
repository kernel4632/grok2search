/**
 * db.ts —— 搜索记录落盘（bun:sqlite，无需外部依赖）
 *
 * 目标：搜索过的内容全部持久化，容器/服务重启不丢：
 *   logs(id, at, caller, query, account_id, pages, posts, first_result_ms, elapsed_ms, ok, error)
 *   results(log_id, text, json)   —— 完整搜索结果快照（网页/帖子/搜索词）
 *
 * 说明：
 *   - WAL 模式：读写并发不打架，异常退出也能恢复；
 *   - 结果 json 直接存字符串，读取时再 parse（面板点击日志时用）；
 *   - 历史不限量；面板无限滚动可以一直翻到最早的一条。
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogEntry } from "./grok.ts";

let db: Database | null = null;

/** 打开/创建数据库并建表（index.ts 启动时调用一次） */
export function initDb(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    caller TEXT NOT NULL DEFAULT '',
    query TEXT,
    account_id TEXT,
    pages INTEGER NOT NULL DEFAULT 0,
    posts INTEGER NOT NULL DEFAULT 0,
    first_result_ms INTEGER,
    elapsed_ms INTEGER,
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS results (
    log_id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    json TEXT NOT NULL
  )`);
  return db;
}

export function dbReady() {
  return db !== null;
}

/** 数据库里的行 -> LogEntry（snake_case -> camelCase） */
function toLog(row: any): LogEntry {
  return {
    id: row.id,
    at: row.at,
    caller: row.caller,
    query: row.query ?? undefined,
    accountId: row.account_id ?? undefined,
    pages: row.pages,
    posts: row.posts,
    firstResultMs: row.first_result_ms ?? undefined,
    elapsedMs: row.elapsed_ms ?? undefined,
    ok: !!row.ok,
    error: row.error ?? undefined,
  };
}

/** 写入一条日志（可选同时写入结果快照），返回自增 id */
export function dbInsert(entry: Omit<LogEntry, "id">, result?: { text: string; json: unknown }): number {
  const info = db!.run(
    `INSERT INTO logs (at, caller, query, account_id, pages, posts, first_result_ms, elapsed_ms, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.at, entry.caller, entry.query ?? null, entry.accountId ?? null, entry.pages ?? 0, entry.posts ?? 0, entry.firstResultMs ?? null, entry.elapsedMs ?? null, entry.ok ? 1 : 0, entry.error ?? null],
  );
  const id = Number(info.lastInsertRowid);
  if (result) db!.run("INSERT OR REPLACE INTO results (log_id, text, json) VALUES (?, ?, ?)", [id, result.text, JSON.stringify(result.json)]);
  return id;
}

/** 分页：id < before 的最近 limit 条（倒序，最新在前；before 省略则从最新开始） */
export function dbPage(before: number | undefined, limit: number): LogEntry[] {
  const rows = before
    ? db!.query("SELECT * FROM logs WHERE id < ? ORDER BY id DESC LIMIT ?").all(before, limit)
    : db!.query("SELECT * FROM logs ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map(toLog);
}

/** 取某条日志的结果快照 */
export function dbResult(id: number): { text: string; json: unknown } | undefined {
  const row = db!.query("SELECT text, json FROM results WHERE log_id = ?").get(id) as { text: string; json: string } | null;
  if (!row) return undefined;
  try {
    return { text: row.text, json: JSON.parse(row.json) };
  } catch {
    return { text: row.text, json: {} };
  }
}

/** 落盘统计（面板显示"已归档 N 条 · 占用 M"） */
export function dbStats() {
  if (!db) return { ready: false, logs: 0, results: 0, bytes: 0 };
  const count = (db.query("SELECT COUNT(*) AS n FROM logs").get() as any).n as number;
  const results = (db.query("SELECT COUNT(*) AS n FROM results").get() as any).n as number;
  const pages = (db.query("PRAGMA page_count").get() as any).page_count as number;
  const pageSize = (db.query("PRAGMA page_size").get() as any).page_size as number;
  return { ready: true, logs: count, results, bytes: pages * pageSize };
}
