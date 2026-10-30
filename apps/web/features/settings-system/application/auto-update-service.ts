import { getWorkflowRepository } from "../../../composition/runtime-container";
import { isDemoMode } from "../../../lib/demo-mode";
import { isUpdateHoldActive } from "../core/update-hold";
import { shouldAutoUpdate } from "../core/auto-update-schedule";
import {
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY,
  AUTO_UPDATE_LAST_ATTEMPT_SETTING_KEY,
  beijingDateTime,
  getAutoUpdateTime,
  isAutoUpdateEnabled,
  parseAutoUpdateFailStreak,
} from "../../../lib/runtime/settings-readers";
import { resolveIsDesktop } from "../../../lib/desktop-flag";

export async function runAutoUpdateIfDue(): Promise<void> {
  if (isDemoMode() || resolveIsDesktop()) return;
  const repository = getWorkflowRepository();
  if (!(await isAutoUpdateEnabled(repository))) return;
  const time = await getAutoUpdateTime(repository);
  const { date, hhmm } = beijingDateTime();
  const lastAttemptDate = (await repository.getSetting(AUTO_UPDATE_LAST_ATTEMPT_SETTING_KEY))?.trim() ?? null;
  if (hhmm < time || lastAttemptDate === date) return;
  await repository.setSetting(AUTO_UPDATE_LAST_ATTEMPT_SETTING_KEY, date);
  const { loadUpdateView } = await import("../../../lib/update-view-server");
  const { requestUpdate } = await import("../../../lib/updater-client");
  const view = await loadUpdateView();
  if (!view.updater || !view.available) return;
  const tag = view.available.tag;
  let failStreak = parseAutoUpdateFailStreak(await repository.getSetting(AUTO_UPDATE_FAIL_STREAK_SETTING_KEY));
  if (view.updater.targetTag === tag && (view.updater.phase === "rolled_back" || view.updater.phase === "failed")) {
    const at = view.updater.finishedAt ?? view.updater.startedAt ?? "";
    if (!failStreak || failStreak.tag !== tag) {
      failStreak = { tag, count: 1, at };
    } else if (failStreak.at !== at) {
      failStreak = { tag, count: failStreak.count + 1, at };
    }
    await repository.setSetting(AUTO_UPDATE_FAIL_STREAK_SETTING_KEY, JSON.stringify(failStreak));
  }
  const due = shouldAutoUpdate({
    enabled: true,
    time,
    now: { date, hhmm },
    lastAttemptDate,
    available: tag,
    failStreak,
    updater: view.updater,
    updateHoldActive: isUpdateHoldActive(Date.now()),
  });
  if (!due) return;
  const result = await requestUpdate(tag);
  if (result.ok) console.log(`[auto-update] started ${tag}`);
  else console.warn(`[auto-update] ${tag} not started: ${result.reason}`);
}
