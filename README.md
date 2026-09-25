# grok2search

> 把 Grok 的**搜索结果**直接变成可用的 API：只取搜索帧（网页 + X 帖子），不等正文总结。
> 后端 3 个文件约 850 行（Bun + Elysia，重度中文注释），前端监控面板沿用
> [monitor.onyxaxis.org](https://monitor.onyxaxis.org/) 的全套风格（Vue 3 + SSE 无闪烁刷新）。

[![Bun](https://img.shields.io/badge/Bun-1.4-000)](https://bun.sh) [![Elysia](https://img.shields.io/badge/Elysia-1.4-6a5acd)](https://elysiajs.com) [![Vue](https://img.shields.io/badge/Vue-3-42b883)](https://vuejs.org) [![Docker](https://img.shields.io/badge/Docker-compose-2496ed)](https://docs.docker.com/compose/)

---

## 1. 它是什么

Grok Web 会话里，模型会先跑若干轮真实搜索（web + X），每轮都有
`tool_usage_card`（搜索词）和 `tool_result`（网页/帖子结果）帧；这些帧在会话开头
几秒就全部到达，而正文总结往往要几十秒甚至卡死。

grok2search 只做一件事：**抓取这些搜索帧并立即返回**：

* `queries`：模型实际发起的搜索词；
* `pages`：网页结果 —— 标题 + URL + **正文节选（snippet）**，按 URL 去重；
* `posts`：X 帖子 —— 全文 + 作者 + 时间 + 浏览/点赞 + 链接，按帖子去重；
* 聊天接口把上述内容整理成一段可直接展示的正文（形态接近 LLM 回答）；
  `/v1/search` 返回纯结构化 JSON；
* 多账号轮询 + 失败换号 + 冷却调度；内置 FlareSolverr，一键启动。

**为什么快**：最后一个搜索帧静默 4 秒、或模型开始写正文的瞬间就收工返回，
正常 **3~18 秒** 出结果，不受正文总结卡顿影响。

---

## 2. 快速开始（Docker，一键）

```bash
git clone https://github.com/kernel4632/grok2search.git
cd grok2search

# 1) 配置：复制示例并改密钥（面板账密 + API 密钥）
cp config.example.json config.json
vi config.json         # panel.user / panel.pass / clientKeys

# 2) 号池：两种方式任选
#    a) 从 grok2api 数据库一键导出（若你在用 grok2api）
bun scripts/export-accounts.ts \
  --db /data/apps/grok2api/data/backend.db \
  --config /opt/stacks/grok2api/config.yaml \
  --out ./accounts.json
#    b) 手动维护 accounts.json：[{"uid":"...","sso":"eyJ..."}, ...]
#       也可以启动后在面板「账号池」里批量粘贴 SSO（uid 自动解析）

# 3) 启动（自带 FlareSolverr）
docker compose up -d --build

# 4) 验证
curl http://127.0.0.1:46328/healthz
curl http://127.0.0.1:46328/v1/search \
  -H "Authorization: Bearer <你的 clientKey>" \
  -H 'Content-Type: application/json' -d '{"query":"今天有什么新闻"}'
```

默认监听 `127.0.0.1:46328`（只绑本机），公网访问请用 Nginx/Caddy 反代并配置 HTTPS：

```nginx
location /groksearch/ {
    proxy_pass http://127.0.0.1:46328/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # SSE（/admin/stream）必须关闭缓冲
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

---

## 3. API

### 公开（`Authorization: Bearer <clientKey>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 仅返回 `grok-search` |
| POST | `/v1/chat/completions` | OpenAI 兼容；`stream` 支持 SSE；`search_format=json` 可切结构化 |
| POST | `/v1/responses` | Responses 兼容（基础事件流） |
| POST | `/v1/search` | 原生结构化：`{query}` → `{queries,pages,posts}` |
| GET | `/healthz` | 存活 + 号池概览（无认证） |

```bash
curl http://127.0.0.1:46328/v1/chat/completions \
  -H "Authorization: Bearer <你的 clientKey>" \
  -H "Content-Type: application/json" \
  -d '{"model":"grok-search","messages":[{"role":"user","content":"今天北京有什么新闻"}]}'
```

### 面板 / 管理（浏览器 Basic 认证）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` `/assets/*` | 监控面板（Vue + SSE，浏览器原生登录弹窗） |
| GET | `/admin/state` | 状态快照（号池/清关/最新日志 20 条） |
| GET | `/admin/stream` | SSE 每 2 秒推送快照（前端自动刷新用） |
| GET | `/admin/logs?before=&limit=` | 日志分页（面板无限滚动加载历史） |
| GET | `/admin/results/:id` | 单条日志的搜索结果快照（点击日志查看内容） |
| POST | `/admin/accounts` | 添加/更新账号 `{uid,sso,name?}` |
| POST | `/admin/accounts/import` | **批量导入**：`{sso}` 多行、每行一个 SSO，自动解析 uid |
| DELETE | `/admin/accounts/:id` | 删除账号（id 或 uid） |
| POST | `/admin/accounts/reload` | 热重载 accounts.json |
| POST | `/admin/search` | 面板搜索测试 `{query}` |
| POST | `/admin/clearance/refresh` | 强制刷新 Cloudflare 清关 |
| GET | `/docs` | Swagger 文档 |

### 面板功能

* **概览**：账号统计 + 平均首字/平均耗时/成功率 + 最近请求耗时趋势图（失败点标红）；
* **账号池**：多行 SSO 批量导入（uid 自动解析）、删除、重载、冷却/忙碌状态；
* **搜索测试**：实时搜索并展示全部结果，点任意条目弹出完整内容（网页/帖子）；
* **请求日志**：SSE 实时推送 + 下滑无限加载历史；只展示搜索词/结果数/首字/总耗时/状态，
  不展示任何密钥；点击任意一条 → 右侧详情面板展示该次搜索的完整结果快照；
* 所有数据更新都是响应式 diff（仅更新数据，不重建页面），自动刷新不会闪烁或打断操作。

---

## 4. 配置（`config.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `panel.user` / `panel.pass` | — | 面板登录（浏览器原生弹窗） |
| `clientKeys` | `[]` | 公开 API 密钥列表（空则 `/v1/*` 全部 401） |
| `accountsFile` | `accounts.json` | 号池文件 |
| `flareSolverrUrl` | `http://flaresolverr:8191/v1` | 清关地址（compose 内置服务名） |
| `upstream.baseUrl` | `https://grok.com` | 上游站点 |
| `upstream.sessionModel` | `fast` | **上游内部模型代号**（不是 grok-chat-fast） |
| `search.maxAttempts` | 12 | 单请求最多换号数（换号重试直到成功；号池耗尽才失败） |
| `search.retryBudgetMs` | 150000 | 单请求重试总预算（毫秒），超时返回最后一次错误 |
| `search.quietMs` | 4000 | 搜索静默多久算"搜完" |
| `search.maxMs` | 18000 | 单路硬上限 |
| `search.firstProgressMs` | 10000 | 哑号快速让位：限时内毫无搜索进展即换号 |
| `quota.intervalMs` | 21600000 | 账号配额全量刷新周期（6 小时；0=只手动/顺带刷新） |
| `quota.concurrency` | 3 | 配额刷新并发（带 120ms 限速，避免打爆上游） |
| `dataDir` | data | 运行数据目录（`quota.json` 配额缓存落在这里） |
| `search.snippetMaxChars` | 500 | 正文节选裁剪长度 |
| `search.maxPages` / `maxPosts` | 40 / 20 | 结果条数上限 |
| `cooldownMs` | 60000 | 失败账号冷却时长 |
| `clearanceTtlMs` | 600000 | 清关缓存时长 |

环境变量覆盖：`GROK2SEARCH_CONFIG`、`GROK2SEARCH_FLARESOLVERR_URL`、`GROK2SEARCH_ACCOUNTS_FILE`。

---

## 5. 架构（刻意保持小）

```
src/
  index.ts   (~250 行) HTTP 入口：配置 + 路由 + 双认证 + SSE + 静态托管
  grok.ts    (~550 行) 上游三合一：号池 + 清关 + WebSocket 会话采集 + 帧解析 + 日志/结果快照
  format.ts  (~65 行)  结果整理：正文（LLM 风格）/ 结构化 JSON
web/
  index.html / app.js / app.css / custom.css   监控面板（Vue 3 + SSE + 详情面板）
scripts/
  export-accounts.ts                           从 grok2api 导出号池
test/
  core.test.ts + fixtures/frames.json          真实抓帧夹具单测
```

* **协议要点**（改动前先看 `grok.ts` 顶部注释）：WebSocket `wss://grok.com/ws/mgw/?uid=`，
  Cookie = `sso` + `sso-rw` + Cloudflare 清关 + `x-userid`；会话模型名 `fast`；
  搜索帧 `response.chunk.tool_usage_card` / `response.chunk.tool_result`；
* **为什么不用并发竞速**：不等正文总结后，"卡死"只可能发生在搜索阶段之前，
  概率极低；单路 + 失败换号重试即可，代码量和上游消耗都更小。

---

## 6. 开发与测试

```bash
bun install
bun test             # 单元测试（真实抓帧夹具：解析/收集/格式化）
bun x tsc --noEmit   # 类型检查
bun run dev          # 本地热重载（需可达的 FlareSolverr，见 config.json）
```

---

## 7. 常见问题

* **一直 503 `no_account`**：`accounts.json` 为空或全部冷却。查面板「账号池」或 `GET /admin/status`。
* **握手失败 / 403**：Cloudflare 清关过期，`POST /admin/clearance/refresh` 后重试；
  仍失败检查 FlareSolverr 容器日志。
* **搜不到结果**：查面板「请求日志」；可调大 `search.maxMs` / `search.quietMs`，
  或确认账号本身没有被上游限制。
* **下游要"总结"**：本项目刻意不做；可用返回的 `pages/posts` 自行喂给任意模型。

---

## 8. 免责声明

本项目仅用于技术研究与学习。请遵守 Grok 官方使用条款及当地法律法规；
使用产生的一切后果由使用者自行承担。账号凭据、`config.json`、`accounts.json`
均已加入 `.gitignore`，请勿将其提交到任何公开仓库。

## License

[MIT](LICENSE)
