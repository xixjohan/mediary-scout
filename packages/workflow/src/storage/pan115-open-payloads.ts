/** 云下载配额（`/open/offline/get_quota_info`）。字段缺失时为 undefined——
 *  不能拿 0 冒充「没有余额」，那会把宽裕误判成耗尽。 */
export interface Pan115QuotaInfo {
  total: { count?: number; used?: number; surplus?: number };
  packages: Array<{ name: string; count?: number; used?: number; surplus?: number }>;
}

/** `/open/upload/init` 的结果。`status === 2` 表示秒传已完成。 */
export interface Pan115UploadInitResult {
  status: number;
  fileId?: string | undefined;
  pickCode?: string | undefined;
}

export interface QuotaInfoResponse {
  data?: Array<Record<string, unknown>> | Record<string, unknown>;
  count?: unknown;
  used?: unknown;
  surplus?: unknown;
}

/** 平台未返回该字段时保持 undefined，绝不拿 0 冒充。 */
function numberField(source: unknown, key: string): number | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function quotaFields(source: unknown): { count?: number; used?: number; surplus?: number } {
  const count = numberField(source, "count");
  const used = numberField(source, "used");
  const surplus = numberField(source, "surplus");
  return {
    ...(count === undefined ? {} : { count }),
    ...(used === undefined ? {} : { used }),
    ...(surplus === undefined ? {} : { surplus }),
  };
}

/** 官方返回 data[]，每项含 count/used/surplus/name；也见过 `{ package: [] }` 形态。 */
export function normalizeQuotaInfo(res: QuotaInfoResponse): Pan115QuotaInfo {
  const raw = res.data;
  const packages = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { package?: unknown }).package)
      ? (raw as { package: Array<Record<string, unknown>> }).package
      : [];

  // 官方文档把总数标量与 data[] 同级列出，而 data 为数组时放不进标量——
  // 所以两种形态都读：data 是对象时从 data 取，否则从响应顶层取。
  const totalSource = !Array.isArray(raw) && raw && typeof raw === "object" ? raw : res;

  return {
    total: quotaFields(totalSource),
    packages: packages.map((p) => ({ name: String(p["name"] ?? ""), ...quotaFields(p) })),
  };
}

/** 官方 target 约定: U_1_<目录ID>，根目录为 0。`fileid` 是整文件 SHA1（秒传判定
 *  依据），`preid` 是前 128K SHA1。 */
export function buildUploadInitBody(input: {
  fileName: string;
  fileSize: number;
  directoryId: string;
  fileSha1: string;
  preid?: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("file_name", input.fileName);
  body.set("file_size", String(input.fileSize));
  body.set("target", `U_1_${input.directoryId || "0"}`);
  body.set("fileid", input.fileSha1);
  if (input.preid !== undefined) body.set("preid", input.preid);
  return body;
}

export function normalizeUploadInit(data: Record<string, unknown> | undefined): Pan115UploadInitResult {
  const payload = data ?? {};
  return {
    status: Number(payload["status"] ?? 0),
    fileId: typeof payload["file_id"] === "string" ? payload["file_id"] : undefined,
    pickCode: typeof payload["pick_code"] === "string" ? payload["pick_code"] : undefined,
  };
}