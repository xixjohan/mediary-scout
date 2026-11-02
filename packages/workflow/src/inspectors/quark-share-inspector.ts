import type { ResourceCandidate } from "../domain/domain.js";
import type {
  IShareInspectorAdapter,
  ResourceFileNode,
  ResourceInspectionResult,
  ResourceValidityStatus,
} from "./share-inspector-types.js";

const QUARK_SHARE_REGEX = /pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/;

interface QuarkDetailItem {
  fid?: string;
  file_name?: string;
  size?: number;
  dir?: boolean;
  file_type?: number;
  updated_at?: number | string;
}

function extractQuarkPwdId(url: string): string | null {
  const match = QUARK_SHARE_REGEX.exec(url);
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

function classifyQuarkTokenError(
  code?: number,
  hasPassword?: boolean,
  dataStoken?: string
): ResourceValidityStatus {
  if (code === 40004 || code === 40003 || code === 40011) {
    return "invalid";
  }
  if (code === 40008 || (code !== 0 && !dataStoken && !hasPassword)) {
    return "password_required";
  }
  if (!dataStoken || code !== 0) {
    return "invalid";
  }
  return "valid";
}

function mapQuarkItemsToFileNodes(items: QuarkDetailItem[]): {
  fileNodes: ResourceFileNode[];
  totalBytes: number;
} {
  let totalBytes = 0;
  const fileNodes: ResourceFileNode[] = items.map((item, idx) => {
    const isDir = Boolean(item.dir || item.file_type === 0);
    const sizeBytes = typeof item.size === "number" ? item.size : undefined;
    if (!isDir && sizeBytes) {
      totalBytes += sizeBytes;
    }
    return {
      id: item.fid || `node-${idx}`,
      name: item.file_name || `未命名文件_${idx}`,
      isDir,
      sizeBytes,
      updatedAt: item.updated_at ? String(item.updated_at) : undefined,
    };
  });
  return { fileNodes, totalBytes };
}

async function requestQuarkDetail(
  fetchFn: typeof fetch,
  pwdId: string,
  stoken: string
): Promise<QuarkDetailItem[]> {
  const detailUrl = new URL("https://pan.quark.cn/1/clouddrive/share/sharepage/detail");
  detailUrl.searchParams.set("pwd_id", pwdId);
  detailUrl.searchParams.set("stoken", stoken);
  detailUrl.searchParams.set("pdir_fid", "0");
  detailUrl.searchParams.set("_fetch_total", "1");
  detailUrl.searchParams.set("size", "50");

  const detailRes = await fetchFn(detailUrl.toString(), {
    headers: {
      Referer: "https://pan.quark.cn/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  const detailJson = (await detailRes.json().catch(() => ({}))) as {
    data?: { list?: QuarkDetailItem[] };
  };
  return detailJson.data?.list ?? [];
}

export class QuarkShareInspectorAdapter implements IShareInspectorAdapter {
  readonly supportedTypes = ["quark", "uc"] as const;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = 6000
  ) {}

  async inspect(candidate: ResourceCandidate): Promise<ResourceInspectionResult> {
    const now = new Date().toISOString();
    const { url, password } = extractCandidateCredentials(candidate.providerPayload);
    const pwdId = extractQuarkPwdId(url);

    if (!pwdId) {
      return {
        candidateId: candidate.id,
        status: "unknown",
        message: "未能解析夸克分享 ID",
        probedAt: now,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const tokenRes = await this.fetchFn(
        "https://pan.quark.cn/1/clouddrive/share/sharepage/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Referer: "https://pan.quark.cn/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          body: JSON.stringify({
            pwd_id: pwdId,
            passcode: password.trim(),
          }),
          signal: controller.signal,
        }
      ).finally(() => clearTimeout(timer));

      if (tokenRes.status === 429) {
        return {
          candidateId: candidate.id,
          status: "rate_limited",
          message: "夸克网盘接口限流，请稍后重试",
          probedAt: now,
        };
      }

      const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
        code?: number;
        message?: string;
        data?: { stoken?: string };
      };

      const validity = classifyQuarkTokenError(
        tokenJson.code,
        Boolean(password.trim()),
        tokenJson.data?.stoken
      );
      if (validity !== "valid") {
        return {
          candidateId: candidate.id,
          status: validity,
          message: tokenJson.message || "分享状态异常",
          probedAt: now,
        };
      }

      const items = await requestQuarkDetail(this.fetchFn, pwdId, tokenJson.data!.stoken!);
      const { fileNodes, totalBytes } = mapQuarkItemsToFileNodes(items);

      return {
        candidateId: candidate.id,
        status: "valid",
        totalSizeBytes: totalBytes > 0 ? totalBytes : undefined,
        fileCount: fileNodes.length,
        files: fileNodes,
        probedAt: now,
      };
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        candidateId: candidate.id,
        status: isAbort ? "rate_limited" : "unknown",
        message: isAbort ? "探测超时，网盘响应较慢" : "网盘嗅探连接失败",
        probedAt: now,
      };
    }
  }
}
