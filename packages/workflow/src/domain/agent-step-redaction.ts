/**
 * Redaction for agent tool-call args before they are shown to a human.
 *
 * The trace is post-mortem material (「这一步为什么这么做」), and it is captured
 * PRE-execution — so `args` carries exactly what the agent was about to send:
 * 115/夸克 cookies, refresh tokens, share links whose codes are the capability.
 * Persisted verbatim, a log page becomes a credential dump. The plan therefore
 * makes redaction a PREREQUISITE of the log page (W4 L1: 「先做脱敏」), not a
 * follow-up.
 *
 * Two rules, both applied recursively so a credential nested inside a plan is
 * caught too:
 *
 *  1. BY KEY — a key naming a credential/session/authorization has its whole value
 *     replaced. Deliberately over-inclusive: at a credential boundary, redacting a
 *     diagnostic value costs a little debuggability, while under-redacting costs an
 *     account.
 *  2. BY VALUE SHAPE — a credential can arrive under an innocuous key (the model
 *     invents parameter names). A string that looks like a drive cookie header
 *     (`UID=`/`CID=`/`SEID=`/`__uid=`) or a URL is replaced regardless of its key.
 *     URLs go because a share link's code IS the capability, and the resource
 *     endpoint's acceptance criterion is explicitly "no URL shapes in the body".
 *
 * What is deliberately KEPT: episode codes, keywords, file ids, candidate ids,
 * directory ids, names. The trace must stay useful for debugging, and the batch-2
 * acceptance criteria assert on candidateId — a blanket "long opaque string" rule
 * would redact UUIDs and break both.
 *
 * Non-mutating: returns a new value and never touches the caller's object.
 */

/** Replaces a redacted value. Distinct from `null`/`""` so the UI can render it. */
export const REDACTED = "[已脱敏]";

/**
 * Keys whose value is a credential, session or authorization. Substring match on
 * purpose — `refreshToken`, `cookieHeader`, `sessionKey` all have to hit.
 *
 * Deliberately does NOT contain a bare `auth`: it would swallow `authKind`, and
 * "which auth path did this run take" is exactly the diagnostic a post-mortem
 * needs. A literal `auth: "Bearer x"` is covered by the Bearer value shape below
 * instead of by the key name.
 */
const SENSITIVE_KEY_RE =
  /cookie|token|credential|password|passwd|secret|authorization|session|api_?key|access_?key|private_?key|refresh_?key/i;

/** Drive cookie headers, whatever key they arrive under (115: UID/CID/SEID/__uid). */
const COOKIE_VALUE_RE = /(?:^|[\s;,])(?:UID|CID|SEID|__uid|kefu_token|refresh_token)\s*=/i;

/** Absolute URL — a share link's code is the capability. */
const URL_RE = /^(?:https?|ftp):\/\/\S+$/i;

/** Bearer token, whatever key it arrives under (covers a literal `auth:` arg). */
const BEARER_RE = /^Bearer\s+\S+$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

function redactString(value: string): string {
  if (URL_RE.test(value)) return REDACTED;
  if (COOKIE_VALUE_RE.test(value)) return REDACTED;
  if (BEARER_RE.test(value)) return REDACTED;
  return value;
}

/**
 * Recursively redact. Arrays keep their length; objects keep their keys.
 *
 * A sensitive key redacts its whole value, objects included. Recursing into
 * `credential: { … }` instead would leak any leaf whose name is not itself
 * suspicious (`secret: { algorithm, value }` — `value` is the secret). At a
 * credential boundary the subtree is treated as opaque; the cost is that you no
 * longer see WHICH credential fields were present, which is an acceptable trade
 * for not leaking one.
 *
 * Diagnostic keys stay visible because the key regex excludes a bare `auth`
 * (see above): `authKind: "cookie"` survives.
 */
export function redactSensitive(value: unknown, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSensitive(v, k);
    }
    return out;
  }
  return value;
}

/** Redact an agent step's `args`. Shallow-copies; the input is never mutated. */
export function redactAgentStepArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactSensitive(args) as Record<string, unknown>;
}
