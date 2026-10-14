#!/usr/bin/env node
/**
 * 自签 minerva JWT（HS256）—— 用于 SP Agent 的 `SP_ADMIN_TOKEN`。
 *
 * 原理：minerva BFF 的 Koa 鉴权只要求 `Authorization: Bearer <JWT>`，
 * 且 `business-minerva-auth` 对角色名「Super Admin」直接放行全部权限
 * （见 sitin-next `packages/business-minerva-auth/src/super-admin.ts`）。
 * 因此用对应环境的 JWT_SECRET 自签的 token 即可访问 SP 运维接口。
 *
 * 用法：
 *   node scripts/make-sp-token.mjs --secret <JWT_SECRET> [--userId social-proxy-agent-bot] [--roles "Super Admin"] [--days 30]
 *
 * JWT_SECRET 取值（sitin-next 仓库，勿写入本仓库任何文件）：
 *   dev:  packages/app-minerva-server/.env.development  → JWT_SECRET
 *   prod: packages/app-minerva-server/.env.production   → JWT_SECRET
 *
 * ⚠️ 产出的 token 权限等同超管、且只认环境不认人 —— 仅存本地 .env，切勿提交/外发。
 */
import { createHmac } from 'node:crypto';

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (key?.startsWith('--')) {
            args[key.slice(2)] = argv[i + 1];
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const secret = args.secret;
if (!secret) {
    console.error('缺少 --secret <JWT_SECRET>（见脚本头部注释）');
    process.exit(1);
}

const userId = args.userId ?? 'social-proxy-agent-bot';
const roles = (args.roles ?? 'Super Admin').split(',').map((role) => role.trim());
const days = Number(args.days ?? 30);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = { userId, roles, iat: now, exp: now + days * 86_400 };

const data = `${encode(header)}.${encode(payload)}`;
const signature = createHmac('sha256', secret).update(data).digest('base64url');

console.log(`${data}.${signature}`);
