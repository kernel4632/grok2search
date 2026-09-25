/**
 * core.test.ts —— 核心纯逻辑单测（真实帧夹具 + 格式化）
 *
 * 夹具 test/fixtures/frames.json 来自一次真实搜索会话（2026-09-25，北京新闻），
 * 包含 tool_usage_card / tool_result / 正文 / 结束帧。协议一旦改动这里最先报警。
 */

import { describe, expect, test } from "bun:test";
import { parseFrame, type FrameState, type SearchData } from "../src/grok.ts";
import { toJSON, toText } from "../src/format.ts";
import fixture from "./fixtures/frames.json";

describe("parseFrame（真实帧夹具）", () => {
  const run = () => {
    const state: FrameState = { answerStarted: false };
    const queries: string[] = [];
    const pages: any[] = [];
    const posts: any[] = [];
    let answers = 0;
    for (const event of fixture as any[]) {
      const parsed = parseFrame(event, state);
      if (!parsed) continue;
      if (parsed.type === "query") queries.push(parsed.query);
      if (parsed.type === "pages") pages.push(...parsed.pages);
      if (parsed.type === "posts") posts.push(...parsed.posts);
      if (parsed.type === "answer") answers++;
    }
    return { queries, pages, posts, answers };
  };

  test("解析搜索词与结果（网页/帖子）", () => {
    const { queries, pages, posts, answers } = run();
    expect(queries.length).toBeGreaterThanOrEqual(8);
    expect(queries.some((q) => q.includes("北京"))).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(20);
    expect(pages.some((p) => p.snippet.length > 50)).toBe(true); // snippet 是本项目核心价值
    expect(posts.length).toBeGreaterThanOrEqual(5);
    expect(posts.every((p) => p.url.startsWith("https://x.com/"))).toBe(true);
    expect(answers).toBe(1); // 正文帧只触发一次答案事件
  });

  test("无关帧与错误帧行为正确", () => {
    const state: FrameState = { answerStarted: false };
    expect(parseFrame({ type: "conversation.queue.updated" }, state)).toBeNull();
    expect(parseFrame({ type: "response.grok.output", output: { stream_error: { message: "模型不可用" } } }, state)).toEqual({ type: "error", message: "模型不可用" });
  });
});

describe("format", () => {
  const data: SearchData = {
    queries: ["北京 新闻"],
    pages: [{ url: "https://example.com/a", title: "示例标题", snippet: "  这是一段\n\n带空白的摘要  ", query: "北京 新闻" }],
    posts: [{ url: "https://x.com/u/status/1", handle: "u", name: "用户", text: "帖子内容", createdAt: "2026-09-25", views: 10, likes: 2, query: "北京 新闻" }],
    elapsedMs: 1234,
  };

  test("toText 输出可读正文并清洗空白", () => {
    const text = toText(data, "北京 新闻", 100);
    expect(text).toContain("「北京 新闻」搜索结果");
    expect(text).toContain("示例标题");
    expect(text).toContain("这是一段 带空白的摘要");
    expect(text).toContain("@u（用户）");
  });

  test("toJSON 结构化字段完整且不含内部信息", () => {
    const json = toJSON(data) as any;
    expect(json.pages[0].url).toBe("https://example.com/a");
    expect(json.posts[0].views).toBe(10);
    expect(json.elapsedMs).toBe(1234);
    expect(json.accountId).toBeUndefined();
  });
});
