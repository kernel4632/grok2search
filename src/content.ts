/**
 * content.ts —— 正文补全：把搜索结果里的 URL 抓回来，提取整页正文
 *
 * 为什么需要它：
 *   上游 WebSocket 只把每条结果的「节选」发给浏览器，而且硬性截断在 500 字符
 *   （实测 67 条全部正好 500）；完整正文只走 Grok 服务端，客户端帧里根本没有。
 *   所以想拿到知乎/新闻站那种全文，只能我们自己二次抓取。
 *
 * 抓取流程（每条 URL）：
 *   1. 直连 fetch（浏览器 UA + 语言头），超时可控；
 *   2. 判定反爬：403/503/Cloudflare 挑战页/提取后正文过短 → 可选 FlareSolverr 真浏览器渲染兜底；
 *   3. HTML → 正文：linkedom + @mozilla/readability（去导航/广告/脚本），失败退回去标签兜底。
 *
 * 失败不影响主结果（该条不补正文），全程有总预算（budgetMs），不会拖死一次搜索。
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export interface ContentConfig {
  enabled: boolean;
  /** 最多补全前 N 条网页（后面的保持 500 字节选） */
  maxPages: number;
  /** 单页正文保留上限（字符） */
  maxChars: number;
  /** 单次 HTTP 超时（毫秒） */
  timeoutMs: number;
  /** 并发抓取数 */
  parallel: number;
  /** 被反爬拦截时是否允许 FlareSolverr 渲染兜底 */
  render: boolean;
  /** 直连提取正文短于此值视为被拦（走渲染兜底） */
  minChars: number;
  /** 正文补全的总时间预算（毫秒）：超时后未开始的抓取直接放弃 */
  budgetMs: number;
  flaresolverrUrl: string;
}

export interface ContentResult {
  text: string;
  via: "direct" | "renderer";
}

/** 内网/回环地址不做抓取（防 SSRF：搜索结果理论上都来自公网，仍做兜底校验） */
function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** 压缩空行、去掉零宽字符、按上限截断（保留段落换行，便于阅读） */
function normalize(text: string, max: number) {
  const value = text
    .replace(/\u200b|\ufeff/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 反爬拦截判定（Cloudflare 挑战页 / 裸 403 / 验证码页） */
function looksBlocked(status: number, html: string) {
  if (status === 403 || status === 429 || status === 503) return true;
  const head = html.slice(0, 4000).toLowerCase();
  return head.includes("cf-chl") || head.includes("just a moment") || head.includes("challenge-platform") || head.includes("enable javascript and cookies to continue");
}

/** HTML → 正文：readability 优先，失败退回"去标签 + 去导航/脚本"兜底 */
export function extractReadable(html: string, max: number): string {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as never, { charThreshold: 100 }).parse();
    const text = (article?.textContent ?? "").trim();
    if (text.length >= 120) return normalize(text, max);
  } catch {
    // readability 对畸形页面可能抛错，走兜底
  }
  const stripped = html
    .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
  return normalize(stripped, max);
}

/** FlareSolverr 渲染抓取（真浏览器；解决 Cloudflare/指纹类反爬） */
async function fetchViaRenderer(url: string, config: ContentConfig): Promise<string | undefined> {
  const response = await fetch(config.flaresolverrUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: Math.max(20_000, config.timeoutMs + 15_000) }),
    signal: AbortSignal.timeout(Math.max(30_000, config.timeoutMs + 20_000)),
  });
  if (!response.ok) return undefined;
  const body = (await response.json().catch(() => ({}))) as { status?: string; solution?: { status?: number; response?: string } };
  const html = body.solution?.response;
  if (body.status !== "ok" || !html || (body.solution?.status ?? 0) >= 400) return undefined;
  return html;
}

/** 抓一页正文：直连 → 必要时渲染兜底；都失败返回 undefined */
export async function fetchContent(url: string, userAgent: string, config: ContentConfig): Promise<ContentResult | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (isPrivateHost(parsed.hostname)) return undefined;

  // 1) 直连：大多数站点直接就能拿全文
  let directHtml: string | undefined;
  let blocked = false;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    directHtml = await response.text();
    blocked = looksBlocked(response.status, directHtml);
    if (!blocked) {
      const text = extractReadable(directHtml, config.maxChars);
      if (text.length >= config.minChars) return { text, via: "direct" };
    }
  } catch {
    blocked = true; // 网络层失败也交给渲染兜底试一次
  }

  // 2) 渲染兜底：直连被拦或正文太短时，用 FlareSolverr 真浏览器再试
  if (config.render) {
    try {
      const html = await fetchViaRenderer(url, config);
      if (html) {
        const text = extractReadable(html, config.maxChars);
        if (text.length >= 120) return { text, via: "renderer" };
      }
    } catch {
      // 渲染也失败：放弃这一条
    }
  }

  // 3) 直连拿到了内容但略短（但比没有强）：仍然返回
  if (!blocked && directHtml) {
    const text = extractReadable(directHtml, config.maxChars);
    if (text.length > 0) return { text, via: "direct" };
  }
  return undefined;
}

/**
 * 并发补全多条网页正文：
 *   - 只处理前 maxPages 条（按结果顺序）；
 *   - parallel 路并发、budgetMs 总预算（超时后未开始的不再抓）；
 *   - 每条成功就回调 onReady（流式接口用它边补边发），失败静默跳过。
 */
export async function fillContents<T extends { url: string; content?: string; via?: string }>(
  pages: T[],
  userAgent: string,
  config: ContentConfig,
  onReady?: (page: T, index: number) => void,
): Promise<void> {
  const targets = pages.slice(0, Math.max(0, config.maxPages));
  if (targets.length === 0) return;
  const startedAt = Date.now();
  let cursor = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, config.parallel), targets.length) }, async () => {
    while (cursor < targets.length) {
      if (Date.now() - startedAt > config.budgetMs) return; // 总预算用完，放弃剩余
      const index = cursor++;
      const page = targets[index]!;
      if (page.content) continue;
      try {
        const result = await fetchContent(page.url, userAgent, config);
        if (result) {
          page.content = result.text;
          page.via = result.via;
          onReady?.(page, index + 1);
        }
      } catch {
        // 单条失败不影响其他
      }
    }
  });
  await Promise.all(workers);
}
