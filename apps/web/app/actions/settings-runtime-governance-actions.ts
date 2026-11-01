"use server";

import { revalidatePath } from "next/cache";
import { assertNotDemo } from "../../lib/demo-mode";

export interface LibraryDirNamingInput {
  rootName?: string;
  moviesName?: string;
  tvName?: string;
  animeName?: string;
}

export async function saveLibraryDirNamingAction(
  naming: LibraryDirNamingInput,
): Promise<{ success: boolean; message?: string }> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../../lib/workflow-runtime");
    const {
      LIBRARY_ROOT_DIR_SETTING_KEY,
      LIBRARY_MOVIES_DIR_SETTING_KEY,
      LIBRARY_TV_DIR_SETTING_KEY,
      LIBRARY_ANIME_DIR_SETTING_KEY,
    } = await import("../../lib/runtime/settings-readers");

    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();

    if (naming.rootName !== undefined) {
      await repository.setAccountSetting(accountId, LIBRARY_ROOT_DIR_SETTING_KEY, naming.rootName.trim());
    }
    if (naming.moviesName !== undefined) {
      await repository.setAccountSetting(accountId, LIBRARY_MOVIES_DIR_SETTING_KEY, naming.moviesName.trim());
    }
    if (naming.tvName !== undefined) {
      await repository.setAccountSetting(accountId, LIBRARY_TV_DIR_SETTING_KEY, naming.tvName.trim());
    }
    if (naming.animeName !== undefined) {
      await repository.setAccountSetting(accountId, LIBRARY_ANIME_DIR_SETTING_KEY, naming.animeName.trim());
    }

    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function getLibraryDirNamingAction(): Promise<LibraryDirNamingInput> {
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../../lib/workflow-runtime");
    const { resolveLibraryDirNaming } = await import("../../lib/runtime/settings-readers");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    const resolved = await resolveLibraryDirNaming(repository, accountId, process.env);
    return resolved;
  } catch {
    return {
      rootName: "Mediary Scout",
      moviesName: "Movies",
      tvName: "TV",
      animeName: "Anime",
    };
  }
}

export interface ProxyConfigInput {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export async function saveProxyConfigAction(
  config: ProxyConfigInput,
): Promise<{ success: boolean; message?: string | undefined; enabled?: boolean | undefined; proxyDisplay?: string | undefined }> {
  assertNotDemo();
  try {
    const { getWorkflowRepository } = await import("../../lib/workflow-runtime");
    const {
      HTTP_PROXY_SETTING_KEY,
      HTTPS_PROXY_SETTING_KEY,
      NO_PROXY_SETTING_KEY,
      proxyManager,
    } = await import("../../features/settings-system/core/http-proxy");

    const repo = getWorkflowRepository();
    const httpProxy = config.httpProxy?.trim() || "";
    const httpsProxy = config.httpsProxy?.trim() || "";
    const noProxy = config.noProxy?.trim() || "";

    await repo.setSetting(HTTP_PROXY_SETTING_KEY, httpProxy);
    await repo.setSetting(HTTPS_PROXY_SETTING_KEY, httpsProxy);
    await repo.setSetting(NO_PROXY_SETTING_KEY, noProxy);

    const result = await proxyManager.reload({ httpProxy, httpsProxy, noProxy });
    revalidatePath("/settings");
    return { success: true, enabled: result.enabled, proxyDisplay: result.proxyDisplay };
  } catch (error) {
    return { success: false, message: `保存代理配置失败：${String(error)}` };
  }
}

export async function getProxyConfigAction(): Promise<ProxyConfigInput> {
  try {
    const { getWorkflowRepository } = await import("../../lib/workflow-runtime");
    const {
      HTTP_PROXY_SETTING_KEY,
      HTTPS_PROXY_SETTING_KEY,
      NO_PROXY_SETTING_KEY,
    } = await import("../../features/settings-system/core/http-proxy");

    const repo = getWorkflowRepository();
    const http = (await repo.getSetting(HTTP_PROXY_SETTING_KEY))?.trim() || process.env.HTTP_PROXY || "";
    const https = (await repo.getSetting(HTTPS_PROXY_SETTING_KEY))?.trim() || process.env.HTTPS_PROXY || "";
    const noProxy = (await repo.getSetting(NO_PROXY_SETTING_KEY))?.trim() || process.env.NO_PROXY || "";

    return {
      httpProxy: http,
      httpsProxy: https,
      noProxy,
    };
  } catch {
    return {
      httpProxy: process.env.HTTP_PROXY || "",
      httpsProxy: process.env.HTTPS_PROXY || "",
      noProxy: process.env.NO_PROXY || "",
    };
  }
}

export async function testProxyConnectionAction(
  testUrl?: string,
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  assertNotDemo();
  try {
    const { testProxyConnectivity } = await import("../../features/settings-system/core/http-proxy");
    return await testProxyConnectivity(testUrl);
  } catch (error) {
    return { ok: false, latencyMs: 0, message: `测试异常: ${String(error)}` };
  }
}
