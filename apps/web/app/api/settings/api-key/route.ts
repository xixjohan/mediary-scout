import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { requireApiAccount } from "../../../../lib/auth-chain";
import {
  clearApiKey,
  readApiKeyState,
  rotateApiKey,
} from "../../../../lib/api-key-management";
import { API_KEY_SETTING_KEY } from "@media-track/shared";

/**
 * S5.5（需求 #5）：设置页 API Key 管理端点。
 *
 *   GET    /api/settings/api-key → { origin, masked, configured }   三态
 *   POST   /api/settings/api-key → { apiKey, masked, origin }       轮换（一次性完整值）
 *   DELETE /api/settings/api-key → { ok, origin, masked }           清 DB
 *
 * 三个方法都先过 S5.4 登录链（requireApiAccount）——改 key 是写操作，
 * 浏览器带 session cookie，脚本带 JWT，都能用。
 *
 * 落盘经 SQLite app_settings，值由 SECRET_SETTING_KEYS 透明加密
 * （enc:v1:…）；「清除」在该层就是写空串——resolveApiKey 把 DB 空串
 * 视为「用户清空了」，回落到 env，不会把实例锁死。
 */
export async function GET(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // key 是**实例级**凭据（/api/auth/token 用它换 JWT），多用户模式下普通账号
  // 不该能轮换/清除——登录 ≠ 有权改 everyone 用的钥匙。与 /api/update/status
  // 同款：非 owner 一律 404（不泄露端点存在性），也不写库。
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { getWorkflowRepository } = await import("../../../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  const state = await readApiKeyState(process.env, {
    get: () => repository.getSetting(API_KEY_SETTING_KEY),
    set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
    clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
  });
  return NextResponse.json(state);
}

export async function POST(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // key 是**实例级**凭据（/api/auth/token 用它换 JWT），多用户模式下普通账号
  // 不该能轮换/清除——登录 ≠ 有权改 everyone 用的钥匙。与 /api/update/status
  // 同款：非 owner 一律 404（不泄露端点存在性），也不写库。
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
  // 形状契约：不给 = 生成；给了就必须是字符串。此前非字符串被静默丢弃、转而
  // 生成一枚随机 key——调用方以为设了自己的值，实际拿到的是别的（H2 复核）。
  if (body !== null && body.apiKey !== undefined && typeof body.apiKey !== "string") {
    return NextResponse.json({ error: "apiKey 必须是字符串" }, { status: 400 });
  }
  const explicit = typeof body?.apiKey === "string" ? body.apiKey : undefined;

  const { getWorkflowRepository } = await import("../../../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  let rotation;
  try {
    rotation = await rotateApiKey({
      get: () => repository.getSetting(API_KEY_SETTING_KEY),
      set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
      clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
    }, explicit);
  } catch (error) {
    // rotateApiKey 对过短显式值抛错（lib 层已保证不写库）；这里必须翻成 4xx——
    // 直接溅出去是 500 空体，调用方看不到「至少 16 位」这条原因（H2 复核）。
    const message = error instanceof Error ? error.message : "apiKey 不合法";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // apiKey 是完整值，只在这一个响应里出现；此后端上只剩掩码。
  return NextResponse.json(rotation);
}

export async function DELETE(request: NextRequest) {
  const gate = await requireApiAccount(request);
  if (gate instanceof Response) return gate;
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // key 是**实例级**凭据（/api/auth/token 用它换 JWT），多用户模式下普通账号
  // 不该能轮换/清除——登录 ≠ 有权改 everyone 用的钥匙。与 /api/update/status
  // 同款：非 owner 一律 404（不泄露端点存在性），也不写库。
  if (!(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });

  const { getWorkflowRepository } = await import("../../../../lib/workflow-runtime");
  const repository = getWorkflowRepository();
  const result = await clearApiKey(process.env, {
    get: () => repository.getSetting(API_KEY_SETTING_KEY),
    set: (value) => repository.setSetting(API_KEY_SETTING_KEY, value),
    clear: () => repository.setSetting(API_KEY_SETTING_KEY, ""),
  });

  if (!result.cleared) {
    // env 态：页面清不掉部署期注入的值。说清楚，而不是假装成功。
    return NextResponse.json(
      { error: "当前生效的 key 来自环境变量（MEDIA_TRACK_API_KEY），页面无法撤销；请改部署配置。" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, origin: result.origin, masked: result.masked });
}
