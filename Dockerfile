# ============================================================================
# grok2search 镜像 —— 基于官方 Bun Alpine 镜像，直接执行 TypeScript（无需编译）
# ============================================================================
# 构建要点：
#   1. 先拷贝 package.json + bun.lock 安装依赖，利用 Docker 层缓存；
#   2. --production 跳过 @types/bun 等仅类型用的开发依赖；
#   3. 运行时不打包：Bun 原生执行 TS，镜像里就是源码 + node_modules；
#   4. config.json / accounts.json 通过 compose 挂载（含密钥，绝不烧进镜像）。
# ============================================================================
FROM oven/bun:1-alpine

# 时区（日志与上游时间对齐，便于排障）
ENV TZ=Asia/Shanghai

WORKDIR /app

# 依赖层：只依赖 lock 文件，源码变动不会导致重新安装
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# 源码层
COPY src ./src
COPY web ./web
COPY scripts ./scripts

# 数据目录（accounts.json 默认落在这里；compose 会挂载宿主机目录覆盖）
RUN mkdir -p /app/data

EXPOSE 8080

# 健康检查：/healthz 无认证，返回号池概览
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

# 默认入口：config.json 通过 GROK2SEARCH_CONFIG 指定（compose 挂载到 /app/config.json）
CMD ["bun", "src/index.ts"]
