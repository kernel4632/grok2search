/**
 * ============================================================================
 * export-accounts.ts —— 从 grok2api 数据库导出 Web 账号（开箱即用关键脚本）
 * ============================================================================
 *
 * 背景：
 *   现网 grok2api 的 SQLite 里存着 400+ 个 Grok Web 账号（SSO 凭据用
 *   AES-256-GCM 加密）。本项目不想重造账号管理，直接一键导出：
 *
 *     bun scripts/export-accounts.ts \
 *       --db /data/apps/grok2api/data/backend.db \
 *       --config /opt/stacks/grok2api/config.yaml \
 *       --out /opt/grok2search/accounts.json
 *
 * 加密格式（与 grok2api backend/internal/infra/security/cipher.go 对齐）：
 *   - 密钥：config.yaml 里 secrets.credentialEncryptionKey（Base64，32 字节）
 *   - 密文：base64(raw) = nonce(12B) + ciphertext + tag(16B)
 *   - 算法：AES-256-GCM，无附加数据（AAD 为空）
 *
 * 导出结果：accounts.json = [{ id, name, uid, sso }]
 *   - id 用 grok2api 的账号主键（方便对号）
 *   - uid 是 grok.com 用户 uuid（WebSocket 地址参数）
 *   - sso 是解密后的 JWT（敏感！文件会写成 600 权限）
 */

import { Database } from "bun:sqlite";
import { createDecipheriv } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 1. 命令行参数解析（不引第三方 CLI 库，保持零依赖）
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const dbPath = arg("db", "/data/apps/grok2api/data/backend.db");
const configPath = arg("config", "/opt/stacks/grok2api/config.yaml");
const outPath = arg("out", "./accounts.json");

// ---------------------------------------------------------------------------
// 2. 取 AES 密钥（从 grok2api 的 config.yaml 里抓 secrets.credentialEncryptionKey）
// ---------------------------------------------------------------------------
const configText = readFileSync(configPath, "utf8");
const keyMatch = /credentialEncryptionKey:\s*"([^"]+)"/.exec(configText);
if (!keyMatch) {
  console.error(`无法从 ${configPath} 解析 credentialEncryptionKey`);
  process.exit(1);
}
const key = Buffer.from(keyMatch[1]!, "base64");
if (key.length !== 32) {
  console.error("credentialEncryptionKey 不是 32 字节的 Base64 密钥");
  process.exit(1);
}

/** 解密单条凭据（nonce 前置 + GCM tag 尾部） */
function decrypt(encoded: string): string {
  const data = Buffer.from(encoded, "base64"); // raw base64 无 padding 也能正确解析
  const nonce = data.subarray(0, 12);
  const ciphertext = data.subarray(12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// 3. 读取账号：Web / 启用 / 状态正常 / 有 user_id
// ---------------------------------------------------------------------------
const db = new Database(dbPath, { readonly: true }); // 只读打开，绝不影响 grok2api 运行
const rows = db
  .query<
    { id: number; name: string; user_id: string; encrypted_primary: string },
    []
  >(
    `SELECT p.id, p.name, p.user_id, c.encrypted_primary
       FROM provider_accounts p
       JOIN account_credentials c ON c.account_id = p.id
      WHERE p.provider = 'grok_web'
        AND p.enabled = 1
        AND p.auth_status = 'active'
        AND p.user_id IS NOT NULL AND p.user_id <> ''
      ORDER BY p.id`,
  )
  .all();

// ---------------------------------------------------------------------------
// 4. 解密 + 组装 + 写文件
// ---------------------------------------------------------------------------
const accounts: Array<{ id: string; name: string; uid: string; sso: string }> = [];
let failed = 0;

for (const row of rows) {
  try {
    const sso = decrypt(row.encrypted_primary);
    // 只接受形如 JWT 的凭据（防呆：解密结果不对时宁可跳过）
    if (!sso.startsWith("eyJ") && sso.length < 40) {
      failed += 1;
      continue;
    }
    accounts.push({ id: `g2a-${row.id}`, name: row.name || `web-${row.id}`, uid: row.user_id, sso });
  } catch {
    failed += 1; // 单条解密失败不影响整体导出
  }
}

await Bun.write(outPath, JSON.stringify(accounts, null, 2));
chmodSync(outPath, 0o600); // 文件含登录态，必须 600

console.log(
  JSON.stringify({
    msg: "export_done",
    out: outPath,
    total: rows.length,
    exported: accounts.length,
    failed,
  }),
);
