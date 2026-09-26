/**
 * app.js —— 面板前端逻辑（Vue 3 响应式 + SSE 实时推送 + 详情面板 + 无限滚动）
 *
 * 设计要点：
 *   1. 数据来自 /admin/stream 的 SSE 快照（每 2 秒），Vue 只做响应式 diff，
 *      不整块重渲染，所以不会有闪烁；
 *   2. SSE 只推最新 20 条日志，历史通过 /admin/logs?before= 滚动加载，合并去重；
 *   3. 点击日志/搜索结果 → 右侧详情面板（沿用参考站点的 detail-panel 交互）；
 *   4. 页面状态（当前视图、输入框、已加载日志）与数据更新解耦，刷新不打断操作。
 */

const { createApp } = Vue;

createApp({
  data() {
    return {
      // ---- 页面状态 ----
      view: "overview",
      railCollapsed: false,
      now: new Date().toLocaleString("zh-CN"),

      // ---- 远端数据（SSE 推送）----
      connected: false,
      status: {
        uptimeSec: 0,
        accounts: { total: 0, idle: 0, busy: 0, cooldown: 0, exhausted: 0 },
        clearance: { cached: false },
        quota: { running: false, progress: { done: 0, total: 0 }, lastRunAt: 0, intervalMs: 0 },
        storage: { ready: false, logs: 0, results: 0, bytes: 0 },
        search: { quietMs: 0, maxMs: 0, maxAttempts: 0, retryBudgetMs: 0 },
        model: "grok-search",
      },
      accounts: [],
      logs: [],
      hasMore: true,
      loadingMore: false,
      lastUpdate: "—",

      // ---- 操作状态 ----
      form: { ssoText: "", importResult: "" },
      busy: { import: false, del: "" },
      notice: "",
      test: { query: "", loading: false, result: null, error: "", elapsedMs: 0 },

      // ---- 详情面板 ----
      detail: { open: false, title: "", subtitle: "", meta: [], item: null, pages: [], posts: [], loading: false, expired: false },

      // ---- 导航 ----
      tabs: [
        { id: "overview", label: "概览", icon: "#i-grid" },
        { id: "accounts", label: "账号池", icon: "#i-server" },
        { id: "search", label: "搜索测试", icon: "#i-search" },
        { id: "logs", label: "请求日志", icon: "#i-network" },
      ],
    };
  },

  computed: {
    currentTab() {
      return this.tabs.find((tab) => tab.id === this.view) ?? this.tabs[0];
    },
    uptimeText() {
      const seconds = this.status.uptimeSec;
      return seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
    },
    /** 最近 50 条日志的统计：平均首字 / 平均总耗时 / 成功率 */
    recent() {
      const list = this.logs.slice(0, 50).filter((item) => item.ok);
      const total = this.logs.slice(0, 50);
      const firsts = list.filter((item) => item.firstResultMs != null);
      return {
        total: total.length,
        ok: list.length,
        rate: total.length ? Math.round((list.length / total.length) * 100) : 0,
        avgFirst: firsts.length ? Math.round(firsts.reduce((sum, item) => sum + item.firstResultMs, 0) / firsts.length) : 0,
        avgMs: list.length ? Math.round(list.reduce((sum, item) => sum + (item.elapsedMs || 0), 0) / list.length) : 0,
      };
    },
    /** 耗时趋势图：最近 40 条正序，失败点标红 */
    perf() {
      const list = this.logs.slice(0, 40).reverse();
      if (list.length < 2) return { points: "", area: "", dots: [], max: 0 };
      const height = 44;
      const max = Math.max(1000, ...list.map((item) => item.elapsedMs || 0));
      const step = 400 / (list.length - 1);
      const coords = list.map((item, index) => ({ x: index * step, y: height - ((item.elapsedMs || 0) / max) * height, ok: item.ok }));
      return {
        points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" "),
        area: `0,${height} ` + coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ") + ` 400,${height}`,
        dots: coords.filter((c) => !c.ok),
        max,
      };
    },
    /** 成功率环形图：圆周长 + 缺口偏移（SVG stroke-dasharray 实现） */
    ring() {
      const radius = 15.5;
      const c = 2 * Math.PI * radius;
      return { c, off: c * (1 - this.recent.rate / 100) };
    },
    /** 账号状态分段条：空闲/忙碌/冷却/耗尽 各占比例 */
    accountSegments() {
      const a = this.status.accounts;
      const total = a.total || 1;
      return [
        { label: "空闲", value: a.idle, cls: "idle", pct: Math.round((a.idle / total) * 100) },
        { label: "忙碌", value: a.busy, cls: "busy", pct: Math.round((a.busy / total) * 100) },
        { label: "冷却", value: a.cooldown, cls: "cool", pct: Math.round((a.cooldown / total) * 100) },
        { label: "耗尽", value: a.exhausted, cls: "drain", pct: Math.round((a.exhausted / total) * 100) },
      ].filter((s) => s.value > 0);
    },
    /** 配额总览：fast 剩余总量 + 5 档分布直方图（数据来自每个账号的 quota.fast） */
    quotaSummary() {
      const windows = this.accounts.map((account) => account.quota?.fast).filter((w) => w && w.total > 0);
      const remaining = windows.reduce((sum, w) => sum + w.remaining, 0);
      const total = windows.reduce((sum, w) => sum + w.total, 0);
      const definitions = [
        { label: "0%", level: "fail" },
        { label: "1-25%", level: "fail" },
        { label: "25-50%", level: "warn" },
        { label: "50-75%", level: "ok" },
        { label: "75-100%", level: "ok" },
      ];
      const buckets = definitions.map((definition) => ({ ...definition, count: 0 }));
      for (const w of windows) {
        const percent = (w.remaining / w.total) * 100;
        const bucket = percent <= 0 ? buckets[0] : percent <= 25 ? buckets[1] : percent <= 50 ? buckets[2] : percent <= 75 ? buckets[3] : buckets[4];
        bucket.count += 1;
      }
      const max = Math.max(1, ...buckets.map((b) => b.count));
      return {
        remaining,
        total,
        percent: total ? Math.round((remaining / total) * 100) : 0,
        known: windows.length,
        exhausted: windows.filter((w) => w.remaining <= 0).length,
        usable: windows.filter((w) => w.remaining > 0).length,
        unknown: this.accounts.length - windows.length,
        syncedText: windows.length ? this.shortTime(new Date(Math.max(...windows.map((w) => w.syncedAt))).toISOString()) : "—",
        buckets: buckets.map((b) => ({ ...b, height: (b.count / max) * 100 })),
      };
    },
  },

  methods: {
    /** 带 Basic 凭据的同源请求封装（凭据由浏览器缓存自动附带） */
    async api(path, options = {}) {
      const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      return body;
    },

    /** SSE 快照落地：状态/账号直接替换；日志做"合并去重"（保留已加载的历史） */
    applySnapshot(snapshot) {
      this.status = snapshot.status ?? this.status;
      this.accounts = snapshot.accounts ?? [];
      this.mergeLogs(snapshot.logs ?? []);
      this.lastUpdate = new Date().toLocaleTimeString("zh-CN");
    },

    /** 合并新日志：按 id 去重，保持 id 倒序；不打断已加载的历史分页 */
    mergeLogs(incoming) {
      const known = new Set(this.logs.map((item) => item.id));
      const fresh = incoming.filter((item) => !known.has(item.id));
      if (fresh.length === 0) return;
      this.logs = [...fresh, ...this.logs].sort((a, b) => b.id - a.id);
    },

    /** 建立 SSE 连接 */
    connect() {
      const source = new EventSource("admin/stream");
      source.onmessage = (event) => {
        this.connected = true;
        try { this.applySnapshot(JSON.parse(event.data)); } catch {}
      };
      source.onerror = () => (this.connected = false);
    },

    /** 滚动到底部附近时加载更早的日志（无限滚动） */
    onScroll(event) {
      if (this.view !== "logs" || !this.hasMore || this.loadingMore) return;
      const el = event.target;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) this.loadMore();
    },
    async loadMore() {
      if (!this.hasMore || this.loadingMore) return;
      this.loadingMore = true;
      try {
        const before = this.logs.length ? this.logs[this.logs.length - 1].id : undefined;
        const result = await this.api(`admin/logs?limit=50${before ? `&before=${before}` : ""}`);
        const page = result.logs ?? [];
        this.mergeLogs(page);
        if (page.length < 50) this.hasMore = false;
      } catch {
        this.hasMore = false; // 拉取失败就先停下，避免无限重试
      } finally {
        this.loadingMore = false;
      }
    },

    // ---------- 详情面板 ----------
    /** 打开日志详情：拉取该次请求的结果快照（包含全部网页/帖子） */
    async openLog(log) {
      this.detail = {
        open: true, title: log.query || "（无搜索词）", subtitle: this.shortTime(log.at),
        meta: [
          ["状态", log.ok ? "成功" : "失败"],
          ["首字", `${durText(log.firstResultMs)}`],
          ["总耗时", `${durText(log.elapsedMs)}`],
          ["结果", `${log.pages ?? 0} 网页 / ${log.posts ?? 0} 帖子`],
          ...(log.error ? [["错误", log.error]] : []),
        ],
        item: null, pages: [], posts: [], loading: log.ok, expired: false,
      };
      if (!log.ok) { this.detail.loading = false; return; }
      try {
        const result = await this.api(`admin/results/${log.id}`);
        const json = result.json ?? {};
        this.detail.pages = json.pages ?? [];
        this.detail.posts = json.posts ?? [];
      } catch {
        this.detail.expired = true; // 快照过期或已被环形缓冲淘汰
      } finally {
        this.detail.loading = false;
      }
    },
    /** 打开单条结果详情（搜索测试/日志结果里的条目） */
    openItem(kind, item) {
      this.detail = {
        open: true,
        title: kind === "page" ? (item.title || item.url) : `@${item.handle}（${item.name}）`,
        subtitle: kind === "page" ? this.host(item.url) : item.createdAt,
        meta: kind === "page"
          ? [["来源", item.url], ["搜索词", item.query || "—"]]
          : [["浏览", String(item.views ?? "—")], ["点赞", String(item.likes ?? "—")], ["链接", item.url]],
        item,
        pages: [], posts: [], loading: false, expired: false,
      };
    },

    // ---------- 展示辅助 ----------
    navCount(tab) {
      if (tab.id === "accounts") return this.status.accounts.total;
      if (tab.id === "logs") return this.logs.length;
      return null;
    },
    shortTime(iso) {
      try { return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return iso; }
    },
    accountState(account) {
      if (account.busy) return "忙碌";
      if (account.cooldownUntil > Date.now()) return `冷却 ${Math.ceil((account.cooldownUntil - Date.now()) / 1000)}s`;
      return "空闲";
    },
    /** 额度颜色分档：>50% 绿、>0 黄、0 红 */
    quotaLevel(percent) {
      return percent <= 0 ? "fail" : percent <= 50 ? "warn" : "ok";
    },
    /** 字节转可读文本（面板显示数据库占用） */
    bytesText(bytes) {
      if (!bytes) return "0 B";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    },
    /** 把毫秒换成"3.2s / 1.2m"这种更友好的时长 */
    durText(ms) {
      if (ms == null) return "—";
      if (ms < 1000) return `${ms} ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
      return `${(ms / 60_000).toFixed(1)} m`;
    },
    clean(text, max = 260) {
      const value = String(text ?? "").replace(/\s+/g, " ").trim();
      return value.length > max ? `${value.slice(0, max)}…` : value;
    },
    host(url) {
      try { return new URL(url).host; } catch { return url; }
    },
    /** 相对条内百分比（日志耗时 mini bar） */
    barPct(value, max) {
      if (value == null || !max) return 0;
      return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
    },
    /** 账号成功比例（5:1 即 83%） */
    okPct(account) {
      const t = (account.ok || 0) + (account.fail || 0);
      return t ? Math.round((account.ok / t) * 100) : 50;
    },

    // ---------- 账号操作 ----------
    /** 批量导入：每行一个 SSO，后端自动解析 uid 后写回号池 */
    async importAccounts() {
      this.busy.import = true;
      this.notice = "";
      this.form.importResult = "";
      try {
        const result = await this.api("admin/accounts/import", { method: "POST", body: JSON.stringify({ sso: this.form.ssoText }) });
        this.form.importResult = `共 ${result.total} 行：成功 ${result.added}，失败 ${result.failed}`;
        if (result.errors?.length) this.notice = result.errors.map((item) => `${item.sso} ${item.error}`).join("；");
        if (result.added > 0) this.form.ssoText = "";
      } catch (error) {
        this.notice = `导入失败：${error.message}`;
      } finally {
        this.busy.import = false;
      }
    },
    async removeAccount(account) {
      if (!confirm(`确定删除账号 ${account.name || account.id}？`)) return;
      this.busy.del = account.id;
      this.notice = "";
      try {
        await this.api(`admin/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
        this.notice = "账号已删除";
      } catch (error) {
        this.notice = `删除失败：${error.message}`;
      } finally {
        this.busy.del = "";
      }
    },
    async reloadAccounts() {
      try {
        const result = await this.api("admin/accounts/reload", { method: "POST" });
        this.notice = `号池已重载，共 ${result.total} 个账号`;
      } catch (error) {
        this.notice = `重载失败：${error.message}`;
      }
    },
    /** 手动触发全量配额刷新（后台跑，进度由 SSE 状态推送） */
    async refreshQuota() {
      try {
        const result = await this.api("admin/quota/refresh", { method: "POST" });
        this.notice = `开始刷新配额（${result.total} 个账号），进度见上方状态`;
      } catch (error) {
        this.notice = `刷新失败：${error.message}`;
      }
    },

    // ---------- 搜索测试 ----------
    async runTest() {
      if (!this.test.query || this.test.loading) return;
      this.test.loading = true;
      this.test.error = "";
      this.test.result = null;
      try {
        const result = await this.api("admin/search", { method: "POST", body: JSON.stringify({ query: this.test.query }) });
        this.test.result = result;
        this.test.elapsedMs = result.elapsedMs;
      } catch (error) {
        this.test.error = `搜索失败：${error.message}`;
      } finally {
        this.test.loading = false;
      }
    },
  },

  mounted() {
    // 首帧快照（SSE 未连上前兜底）+ 建立推送连接
    this.api("admin/state").then((snapshot) => this.applySnapshot(snapshot)).catch(() => {});
    this.connect();
    setInterval(() => (this.now = new Date().toLocaleString("zh-CN")), 1000);
  },
}).mount("#app");
