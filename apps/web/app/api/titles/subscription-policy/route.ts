import { connection, NextResponse, type NextRequest } from "next/server";
import { parseEpisodeFilter } from "@media-track/workflow";
import { requireApiAccount } from "../../../../lib/auth-chain";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";
import type { SubscriptionPolicyWrite } from "@media-track/workflow";

/**
 * GET/PUT /api/titles/subscription-policy — the strategy table's read + write (batch 5).
 *
 * The plan's 四件套 ③. Split from the preview route deliberately: **a preview is a read
 * and saving is a write**, and keeping them apart is what makes the preview safe to call
 * while the user is still typing. A route that previews AND saves on the same call would
 * either save on every keystroke or force the user to save blind.
 *
 * ## What GET returns for an unconfigured work
 *
 * `null`, not an empty policy. The panel needs to tell the user "you have not configured
 * a rule for this work" — which is a different sentence from "your rule excludes
 * everything". An empty policy would make the two indistinguishable, and the second one
 * looks like a bug the user cannot find.
 *
 * ## What PUT refuses
 *
 * An unparseable `episodeFilter` is a 400, not a stored-but-dead filter. A filter we
 * cannot read excludes EVERYTHING (see subscription-policy.ts), so saving one would turn
 * the subscription off silently — the exact failure the plan's cost-model section warns
 * about. The user gets to fix the typo now instead of wondering in a week why nothing
 * downloads.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Validate a write. Returns the normalized policy, or the field that was wrong. */
export function parseSubscriptionPolicyWrite(
  value: unknown,
): { ok: true; policy: SubscriptionPolicyWrite } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "policy 缺失或类型不对" };
  }
  const raw = value as Record<string, unknown>;
  const terms = (key: string): string[] => {
    const list = raw[key];
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw new Error(`${key} 必须是数组`);
    for (const term of list) {
      if (typeof term !== "string") throw new Error(`${key} 里只能有字符串`);
    }
    return list as string[];
  };
  const episodeFilter = raw["episodeFilter"];
  if (episodeFilter !== undefined && typeof episodeFilter !== "string") {
    return { ok: false, error: "episodeFilter 必须是字符串" };
  }
  const cooldownDays = raw["cooldownDays"];
  if (
    cooldownDays !== undefined &&
    (typeof cooldownDays !== "number" || !Number.isInteger(cooldownDays) || cooldownDays < 0)
  ) {
    return { ok: false, error: "cooldownDays 必须是非负整数" };
  }
  let mustContain: string[];
  let mustNotContain: string[];
  try {
    mustContain = terms("mustContain");
    mustNotContain = terms("mustNotContain");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "policy 无法解析" };
  }
  const filter = episodeFilter ?? "";
  // An unreadable filter excludes everything, so it may not be saved as-is.
  if (parseEpisodeFilter(filter) === null) {
    return { ok: false, error: "episodeFilter 看不懂：形如 S01-S03、E01-E10、S02E05，用分号隔开" };
  }
  return {
    ok: true,
    policy: {
      mustContain,
      mustNotContain,
      episodeFilter: filter,
      useRegex: raw["useRegex"] === true,
      cooldownDays: cooldownDays ?? 0,
    },
  };
}

/** tmdbId from the body, shared by both verbs. */
function parseTitleKey(value: unknown): { ok: true; tmdbId: number } | { ok: false; error: string } {
  const tmdbId = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return { ok: false, error: "tmdbId 必须是正整数" };
  }
  return { ok: true, tmdbId };
}

export async function GET(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  const tmdbIdParam = new URL(request.url).searchParams.get("tmdbId");
  const parsed = parseTitleKey(Number(tmdbIdParam));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }

  // The title must be tracked by THIS account — an untracked title is invisible, not
  // configurable (same fail-closed rule as the preview and resources routes).
  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const tracked = states.find((state) => state.title.tmdbId === parsed.tmdbId);
  if (!tracked) {
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }

  const stored = await getWorkflowRepository().getSubscriptionPolicy({
    accountId,
    titleKey: tracked.title.id,
  });
  // null, not an empty policy: the panel must be able to say "you have not configured a
  // rule", which is a different sentence from "your rule excludes everything".
  return NextResponse.json({ policy: stored }, { status: 200, headers: NO_STORE });
}

export async function PUT(request: NextRequest): Promise<Response> {
  await connection();
  const accountId = await requireApiAccount(request);
  if (accountId instanceof Response) return accountId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400, headers: NO_STORE });
  }
  const raw = body as Record<string, unknown>;
  const title = parseTitleKey(raw["tmdbId"]);
  if (!title.ok) {
    return NextResponse.json({ error: title.error }, { status: 400, headers: NO_STORE });
  }
  const policy = parseSubscriptionPolicyWrite(raw["policy"]);
  if (!policy.ok) {
    return NextResponse.json({ error: policy.error }, { status: 400, headers: NO_STORE });
  }

  const states = await getWorkflowRepository().listTrackedSeasonStates(accountId);
  const tracked = states.find((state) => state.title.tmdbId === title.tmdbId);
  if (!tracked) {
    return NextResponse.json({ error: "title not tracked" }, { status: 404, headers: NO_STORE });
  }

  const saved = await getWorkflowRepository().upsertSubscriptionPolicy({
    accountId,
    titleKey: tracked.title.id,
    policy: policy.policy,
    now: new Date().toISOString(),
  });
  return NextResponse.json({ policy: saved }, { status: 200, headers: NO_STORE });
}
