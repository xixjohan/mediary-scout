import { DEFAULT_ACCOUNT_ID } from "@media-track/contracts";
import {
  migrateLegacyCookieToDefaultAccount,
  type WorkflowRepository,
} from "@media-track/workflow";
import { getWorkflowRepository } from "../../../composition/runtime-container";
import { isDemoMode } from "../../../lib/demo-mode";
import { isUpdateHoldActive } from "../core/update-hold";
import {
  getJevInheritedBaseUrl as getJevInheritedBaseUrlFromRepo,
  JEV_BASE_URL_SETTING_KEY,
} from "../../../lib/runtime/settings-readers";
import { seedDemoWorkflowRepository } from "../../../lib/demo-workflow";

export class UpdateInProgressError extends Error {
  constructor(message = "正在更新，更新完成后再试。") {
    super(message);
    this.name = "UpdateInProgressError";
  }
}

export function isUpdateInProgress(): boolean {
  return isUpdateHoldActive(Date.now());
}

export function getAccountScopedSettings(
  accountId: string,
  repository: {
    getAccountSetting(accountId: string, key: string): Promise<string | null>;
    getSetting(key: string): Promise<string | null>;
  } = getWorkflowRepository(),
): {
  getSetting(key: string): Promise<string | null>;
  getOwnSetting(key: string): Promise<string | null>;
} {
  return {
    async getOwnSetting(key: string): Promise<string | null> {
      const own = await repository.getAccountSetting(accountId, key);
      return own !== null && own !== "" ? own : null;
    },
    async getSetting(key: string): Promise<string | null> {
      const own = await repository.getAccountSetting(accountId, key);
      if (own !== null && own !== "") {
        return own;
      }
      return repository.getSetting(key);
    },
  };
}

let demoSeedPromise: Promise<void> | null = null;

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}

export async function ensureDemoSeeded(targetRepository: WorkflowRepository): Promise<void> {
  if (!isDemoMode()) {
    return;
  }
  if (process.env.MEDIA_TRACK_DEMO_SEED === "0") {
    return;
  }
  demoSeedPromise ??= seedDemoIfEmpty(targetRepository);
  await demoSeedPromise;
}

export async function runStartupMigrations(): Promise<void> {
  try {
    const result = await migrateLegacyCookieToDefaultAccount({
      repository: getWorkflowRepository(),
      env: process.env,
      now: new Date().toISOString(),
    });
    if (result.migrated) {
      console.log(
        `[media-track] migrated legacy 115 cookie → ${DEFAULT_ACCOUNT_ID} connected_storage (uid ${result.providerUid})`,
      );
    }
    const filled = await getWorkflowRepository().backfillConnectedStorageId();
    if (filled > 0) {
      console.log(`[media-track] backfilled connected_storage_id on ${filled} legacy row(s)`);
    }
  } catch (error) {
    console.error(`[media-track] startup migration failed: ${String(error)}`);
  }
}

export async function getJevBaseUrlOverride(
  accountId: string,
  repo: Pick<WorkflowRepository, "getAccountSetting"> = getWorkflowRepository(),
): Promise<string> {
  return (await repo.getAccountSetting(accountId, JEV_BASE_URL_SETTING_KEY))?.trim() ?? "";
}

export async function getJevInheritedBaseUrl(
  repo: Pick<WorkflowRepository, "getSetting"> = getWorkflowRepository(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return getJevInheritedBaseUrlFromRepo(repo, env);
}
