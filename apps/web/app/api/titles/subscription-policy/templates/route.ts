import { connection, NextResponse, type NextRequest } from "next/server";
import { requireApiAccount } from "../../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../../lib/workflow-runtime";
import { parseSubscriptionPolicyWrite } from "../route";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;
  const templates = await getWorkflowRepository().listSubscriptionPolicyTemplates(accountId);
  return NextResponse.json({ templates }, { headers: NO_STORE });
}

export async function POST(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400, headers: NO_STORE }); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NextResponse.json({ error: "请求体格式错误" }, { status: 400, headers: NO_STORE });
  const body = raw as Record<string, unknown>;
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!name || name.length > 40) return NextResponse.json({ error: "模板名称必填且不能超过 40 字" }, { status: 400, headers: NO_STORE });
  const parsed = parseSubscriptionPolicyWrite(body["policy"]);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const repository = getWorkflowRepository();
  if ((await repository.listSubscriptionPolicyTemplates(accountId)).length >= 50) {
    return NextResponse.json({ error: "最多保存 50 个订阅策略模板" }, { status: 409, headers: NO_STORE });
  }
  const template = await repository.createSubscriptionPolicyTemplate({
    id: `spt_${crypto.randomUUID()}`, accountId, name, policy: parsed.policy, now: new Date().toISOString(),
  });
  return NextResponse.json({ template }, { status: 201, headers: NO_STORE });
}

export async function PUT(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400, headers: NO_STORE }); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NextResponse.json({ error: "请求体格式错误" }, { status: 400, headers: NO_STORE });
  const body = raw as Record<string, unknown>;
  const id = body["id"];
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (typeof id !== "string" || !/^spt_[\w-]{1,80}$/.test(id)) return NextResponse.json({ error: "模板 ID 无效" }, { status: 400, headers: NO_STORE });
  if (!name || name.length > 40) return NextResponse.json({ error: "模板名称必填且不能超过 40 字" }, { status: 400, headers: NO_STORE });
  const parsed = parseSubscriptionPolicyWrite(body["policy"]);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const template = await getWorkflowRepository().updateSubscriptionPolicyTemplate({
    id, accountId, name, policy: parsed.policy, now: new Date().toISOString(),
  });
  return template
    ? NextResponse.json({ template }, { headers: NO_STORE })
    : NextResponse.json({ error: "模板不存在" }, { status: 404, headers: NO_STORE });
}

export async function DELETE(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;
  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400, headers: NO_STORE }); }
  const id = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["id"] : null;
  if (typeof id !== "string" || !/^spt_[\w-]{1,80}$/.test(id)) return NextResponse.json({ error: "模板 ID 无效" }, { status: 400, headers: NO_STORE });
  const deleted = await getWorkflowRepository().deleteSubscriptionPolicyTemplate({ id, accountId });
  return deleted
    ? NextResponse.json({ deleted: true }, { headers: NO_STORE })
    : NextResponse.json({ error: "模板不存在" }, { status: 404, headers: NO_STORE });
}
