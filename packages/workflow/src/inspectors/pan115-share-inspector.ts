import type { ResourceCandidate } from "../domain/domain.js";
import type {
  IShareInspectorAdapter,
  ResourceFileNode,
  ResourceInspectionResult,
  ResourceValidityStatus,
} from "./share-inspector-types.js";

const PAN115_SHARE_REGEX = /(?:115\.com|115cdn\.com)\/s\/([0-9a-zA-Z]+)/;

interface Pan115SnapItem {
  fid?: string;
  n?: string;
  s?: number | string;
  fc?: number;
  t?: string;
  ico?: string;
}

interface Pan115SnapResponse {
  state?: boolean;
  errno?: number | string;
  error?: string;
  data?: {
    count?: number;
    share_title?: string;
    snap_list?: Pan115SnapItem[];
    file_count?: number;
    total_size?: number | string;
  };
}

function extract115ShareCode(url: string): string | null {
  const match = PAN115_SHARE_REGEX.exec(url);
  return match && match[1] ? match[1] : null;
}

function extractCandidateCredentials(payload: Record<string, unknown> | undefined): {
  url: string;
  password: string;
} {
  const p = payload ?? {};
  const url = typeof p["url"] === "string" ? p["url"] : "";
  const password =
    typeof p["password"] === "string"
      ? p["password"]
      : typeof p["passcode"] === "string"
      ? p["passcode"]
      : "";
  return { url, password };
}

function classify115Error(
  errno: string,
  error?: string,
  hasPassword?: boolean
): ResourceValidityStatus {
  if (errno === "4100014" || errno === "4100012" || (!hasPassword && error?.includes("提取码"))) {
    return "password_required";
  }
  if (
    errno === "4100010" ||
    errno === "4100024" ||
    Boolean(error?.includes("取消") || error?.includes("不存在"))
  ) {
    return "invalid";
  }
  return "invalid";
}

function map115SnapItems(snapList: Pan115SnapItem[]): {
  fileNodes: ResourceFileNode[];
  computedBytes: number;
} {
  let computedBytes = 0;
  const fileNodes: ResourceFileNode[] = snapList.map((item, idx) => {
    const isDir = item.fc === 0 || item.ico === "folder";
    const size = typeof item.s === "number" ? item.s : Number(item.s);
    const sizeBytes = Number.isFinite(size) && size > 0 ? size : undefined;
    if (!isDir && sizeBytes) {
      computedBytes += sizeBytes;
    }
    return {
      id: item.fid || `node-115-${idx}`,
      name: item.n || `未命名文件_${idx}`,
      isDir,
      sizeBytes,
      updatedAt: item.t,
    };
  });
  return { fileNodes, computedBytes };
}

function resolveTotalBytes(declared?: number | string, computed: number = 0): number | undefined {
  if (declared) {
    const parsed = Number(declared);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return computed > 0 ? computed : undefined;
}

async function request115Snap(
  fetchFn: typeof fetch,
  shareCode: string,
  password: string,
  timeoutMs: number
): Promise<{ status: number; data: Pan115SnapResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const apiUrl = new URL("https://webapi.115.com/share/snap");
  apiUrl.searchParams.set("share_code", shareCode);
  if (password) {
    apiUrl.searchParams.set("receive_code", password.trim());
  }

  const res = await fetchFn(apiUrl.toString(), {
    headers: {
      Referer: `https://115.com/s/${shareCode}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));

  const data = (await res.json().catch(() => ({}))) as Pan115SnapResponse;
  return { status: res.status, data };
}

export class Pan115ShareInspectorAdapter implements IShareInspectorAdapter {
  readonly supportedTypes = ["115"] as const;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = 6000
  ) {}

  async inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult> {
    const now = new Date().toISOString();
    const { url, password } = extractCandidateCredentials(candidate.providerPayload);
    const shareCode = extract115ShareCode(url);

    if (!shareCode) {
      return {
        candidateId: candidate.id,
        status: "unknown",
        message: "未能解析 115 分享代码",
        probedAt: now,
      };
    }

    try {
      const { status: httpStatus, data } = await request115Snap(
        this.fetchFn,
        shareCode,
        password,
        this.timeoutMs
      );

      if (httpStatus === 429) {
        return {
          candidateId: candidate.id,
          status: "rate_limited",
          message: "115 接口限流，请稍后重试",
          probedAt: now,
        };
      }

      if (!data.state) {
        const status = classify115Error(
          String(data.errno || ""),
          data.error,
          Boolean(password.trim())
        );
        return {
          candidateId: candidate.id,
          status,
          message: data.error || "115 分享访问受限",
          probedAt: now,
        };
      }

      const { fileNodes, computedBytes } = map115SnapItems(data.data?.snap_list ?? []);
      const totalSizeBytes = resolveTotalBytes(data.data?.total_size, computedBytes);
      const fileCount = fileNodes.length > 0 ? fileNodes.length : data.data?.count;

      return {
        candidateId: candidate.id,
        status: "valid",
        totalSizeBytes,
        fileCount,
        files: fileNodes,
        probedAt: now,
      };
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        candidateId: candidate.id,
        status: isAbort ? "rate_limited" : "unknown",
        message: isAbort ? "探测超时，115 响应较慢" : "115 网盘嗅探失败",
        probedAt: now,
      };
    }
  }
}
