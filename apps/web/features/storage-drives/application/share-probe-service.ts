import {
  CredentialedShareInspectorAdapter,
  GuangYaClient,
  Pan123Client,
  TianyiClient,
  classifyShareProbeErrorMessage,
  isPan123AuthError,
  parseGuangYaShareUrl,
  parsePan123ShareUrl,
  parseTianyiShareUrl,
  type CredentialedShareProbe,
  type ResourceType,
  type ShareProbeOutcome,
} from "@media-track/workflow";
import type { AccountStorageCredentials } from "../contracts/storage-types";

/**
 * 「分享链接是否还有效」的登录态探针装配。
 *
 * 数据来源永远是**用户自己那块盘的账号**：判定分享死亡必须从真正会去转存的
 * 那个账号出发（123/天翼/光鸭的分享列表接口要求登录态）。因此本模块只接收
 * `AccountStorageCredentials`，不接触多用户权限——权限在路由层（requireOwner）。
 *
 * 品牌分工:
 *  - 115 / 夸克 / UC / 磁力：注册表的默认匿名适配器已能判定（webapi/share/snap、
 *    sharepage/token、磁力形状），这里不重复实现；
 *  - 123 / 天翼 / 光鸭：用登录态探针（本模块），没有凭据时返回空数组。
 *
 * 刻意不复用 `brand-ingest-executors.ts` 的 CLIENT_FACTORIES：那个模块面向
 * 「提交转存」，这里面向「只读探测」，失败语义不同（探测必须区分提取码错误 /
 * 已失效 / 限流；提交只需要 ok/message）。
 */

async function probeWithBrandList(input: {
  files: () => Promise<Array<{ name: string; sizeBytes?: number | undefined; isDir: boolean }>>;
  emptyMeansInvalid: boolean;
}): Promise<ShareProbeOutcome> {
  try {
    const files = await input.files();
    if (files.length === 0 && input.emptyMeansInvalid) {
      return { kind: "invalid", message: "分享中没有文件（可能已失效或被限制）" };
    }
    return { kind: "listed", files };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 账号授权失效 ≠ 分享失效：那是我们要用户去重连盘，不是判这条资源死。
    if (isPan123AuthError(error)) {
      return { kind: "unknown", message: `网盘授权失效，请重新连接后再校验：${message}` };
    }
    if (/频繁|限流|rate limit|429/i.test(message)) {
      return { kind: "rate_limited", message: "网盘接口限流，请稍后重试" };
    }
    const verdict = classifyShareProbeErrorMessage(message);
    if (verdict === "password_required") return { kind: "password_required", message };
    if (verdict === "invalid") return { kind: "invalid", message };
    return { kind: "unknown", message };
  }
}

function readUrl(payload: Record<string, unknown>): string {
  const url = payload["url"];
  return typeof url === "string" ? url.trim() : "";
}

function readPassword(payload: Record<string, unknown>): string {
  const password = payload["password"] ?? payload["passcode"];
  return typeof password === "string" ? password.trim() : "";
}

function credentialString(creds: AccountStorageCredentials, key: string): string {
  const value = creds.credential?.[key];
  return typeof value === "string" ? value : "";
}

function pan123Probe(creds: AccountStorageCredentials): CredentialedShareInspectorAdapter[] {
  const token = credentialString(creds, "token") || creds.cookie || "";
  if (!token) return [];
  const client = new Pan123Client({ token });
  const probe: CredentialedShareProbe = async (candidate) => {
    const parsed = parsePan123ShareUrl(readUrl(candidate.providerPayload));
    if (!parsed) return { kind: "invalid", message: "无法解析 123 分享链接" };
    return probeWithBrandList({
      emptyMeansInvalid: true,
      files: async () => {
        const items = await client.listShareDir({
          shareKey: parsed.shareKey,
          sharePwd: readPassword(candidate.providerPayload) || parsed.sharePwd,
        });
        return items.map((item) => ({ name: item.name, sizeBytes: item.size, isDir: item.isFolder }));
      },
    });
  };
  return [
    new CredentialedShareInspectorAdapter({
      types: ["123"] satisfies ResourceType[],
      probe,
      emptyMeans: "invalid",
    }),
  ];
}

function tianyiProbe(creds: AccountStorageCredentials): CredentialedShareInspectorAdapter[] {
  const sessionKey = credentialString(creds, "sessionKey");
  const accessToken = credentialString(creds, "accessToken");
  if (!sessionKey || !accessToken) return [];
  const client = new TianyiClient({
    sessionKey,
    accessToken,
    refreshToken: credentialString(creds, "refreshToken"),
    ...(credentialString(creds, "familySessionKey")
      ? { familySessionKey: credentialString(creds, "familySessionKey") }
      : {}),
  });
  const probe: CredentialedShareProbe = async (candidate) => {
    const parsed = parseTianyiShareUrl(readUrl(candidate.providerPayload));
    if (!parsed) return { kind: "invalid", message: "无法解析天翼分享链接" };
    return probeWithBrandList({
      emptyMeansInvalid: true,
      files: async () => {
        const info = await client.getShareInfo(parsed.shareCode);
        const items = await client.listShareDir({
          shareId: info.shareId,
          fileId: info.fileId,
          shareMode: info.shareMode,
          accessCode: readPassword(candidate.providerPayload) || parsed.accessCode,
        });
        return items.map((item) => ({ name: item.name, sizeBytes: item.size, isDir: item.isFolder }));
      },
    });
  };
  return [
    new CredentialedShareInspectorAdapter({
      types: ["tianyi"] satisfies ResourceType[],
      probe,
      emptyMeans: "invalid",
    }),
  ];
}

function guangyaProbe(creds: AccountStorageCredentials): CredentialedShareInspectorAdapter[] {
  const accessToken = credentialString(creds, "accessToken");
  if (!accessToken) return [];
  const client = new GuangYaClient({ accessToken, refreshToken: credentialString(creds, "refreshToken") });
  const probe: CredentialedShareProbe = async (candidate) => {
    const parsed = parseGuangYaShareUrl(readUrl(candidate.providerPayload));
    if (!parsed) return { kind: "invalid", message: "无法解析光鸭分享链接" };
    return probeWithBrandList({
      // 光鸭的半失效分享会「换 token 成功但列不出文件」，空表不判死。
      emptyMeansInvalid: false,
      files: async () => {
        const shareToken = await client.getShareAccessToken(
          parsed.shareId,
          readPassword(candidate.providerPayload) || parsed.code,
        );
        const items = await client.listShareFiles(shareToken, "");
        return items.map((item) => ({ name: item.fileName, sizeBytes: item.fileSize, isDir: item.resType === 2 }));
      },
    });
  };
  return [
    new CredentialedShareInspectorAdapter({
      types: ["guangya"] satisfies ResourceType[],
      probe,
      emptyMeans: "unknown",
    }),
  ];
}

const PROBE_BUILDERS: Record<string, (creds: AccountStorageCredentials) => CredentialedShareInspectorAdapter[]> = {
  pan123: pan123Probe,
  tianyi: tianyiProbe,
  guangya: guangyaProbe,
};

/** 该盘能提供的登录态探针（可能为空：品牌没有登录态探测能力，或凭据不全）。 */
export function buildShareProbesForCredentials(
  creds: AccountStorageCredentials,
): CredentialedShareInspectorAdapter[] {
  return PROBE_BUILDERS[creds.provider]?.(creds) ?? [];
}
