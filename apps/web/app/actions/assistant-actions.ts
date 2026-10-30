"use server";

import { assertNotDemo } from "../../lib/demo-mode";
import type { PushSettingsActionResult } from "./settings-system-actions";
import { acquireLlmNotConfigured } from "./acquisition-actions";


// ── Agent memory (work detail page + Settings → AI 模型) ──────────────────────
// Writes use requireAuthenticatedAccountId (like unbindStorageAction): an anonymous
// remote caller resolves to the shared acct_unauthenticated sentinel, and must not be
// able to change memory state for it. The throw lands in each action's catch → a
// failed result, nothing written.
type MemoryAddressInput = import("../../lib/agent-memory-server").MemoryAddress;

export async function setAgentMemoryEnabledAction(enabled: boolean): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, requireAuthenticatedAccountId } = await import("../../lib/workflow-runtime");
    const { AGENT_MEMORY_ENABLED_SETTING_KEY } = await import("../../lib/agent-memory-server");
    await getWorkflowRepository().setAccountSetting(await requireAuthenticatedAccountId(), AGENT_MEMORY_ENABLED_SETTING_KEY, enabled ? "1" : "0");
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function deleteAgentMemoryAction(address: MemoryAddressInput, name: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, requireAuthenticatedAccountId } = await import("../../lib/workflow-runtime");
    const { deleteMemoryFromUi } = await import("../../lib/agent-memory-server");
    const result = await deleteMemoryFromUi(getWorkflowRepository(), await requireAuthenticatedAccountId(), address, name);
    return result.success ? { success: true } : { success: false, message: result.message };
  } catch (error) {
    return { success: false, message: `删除没成功：${String(error)}` };
  }
}

// ── User messages (work detail page) ─────────────────────────────────────────
// One sentence asking the agent to replace bad episodes, or a bad film. Same guards and
// result shape as the memory actions; the card refreshes the page itself afterwards, as
// the notes panel does. The work-level actions file under resolveMessageWork's work,
// the key the engine looks up — never a key derived from the page's storageId alone.
const MESSAGE_NOT_TRACKED = "这部作品没有在这块网盘上追踪";
const MESSAGE_ALREADY_TAKEN = "agent 已经开始处理这条留言了";

interface MessageWorkInput {
  tmdbId: number;
  mediaType: "movie" | "tv";
  // The page's workspace drive (undefined = primary), as for requestSeasonAction.
  storageId: string | undefined;
}

/** The caller's work for this title on the page's drive (null when it is not tracked
 *  there), and the page's workspace scope. Throws for an unauthenticated caller (→ the
 *  action's catch). */
async function messageWorkFor(input: MessageWorkInput) {
  const { getActiveWorkspaceScope, getWorkflowRepository, requireAuthenticatedAccountId } = await import("../../lib/workflow-runtime");
  const { resolveMessageWork } = await import("../../lib/user-message-server");
  await requireAuthenticatedAccountId();
  const repo = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(input.storageId);
  return { repo, scope, work: await resolveMessageWork({ repo, scope, tmdbId: input.tmdbId, mediaType: input.mediaType }) };
}

/** The message as it will be stored (body trimmed), checked before any lookup: the
 *  length limit applies to what is saved, and a bad message never costs a DB read.
 *  Null message = valid. */
async function checkMessageInput(input: { body: string; episodeTags: string[] }) {
  const { validateUserMessageInput } = await import("@media-track/workflow");
  // Whatever the client sent: only a string is trimmed, anything else goes to the validator as is.
  const body = typeof input.body === "string" ? input.body.trim() : input.body;
  return { body, message: validateUserMessageInput({ body, episodeTags: input.episodeTags }) };
}

export async function postUserMessageAction(
  input: MessageWorkInput & { body: string; episodeTags: string[] },
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const checked = await checkMessageInput(input);
    if (checked.message) return { success: false, message: checked.message };
    const { repo, work } = await messageWorkFor(input);
    if (!work) return { success: false, message: MESSAGE_NOT_TRACKED };
    await repo.createUserMessage({ ...work, body: checked.body, episodeTags: input.episodeTags, now: new Date().toISOString() });
    return { success: true };
  } catch (error) {
    return { success: false, message: `留言没发出去：${String(error)}` };
  }
}

/** Only while the message waits; once a run holds it the store refuses. */
export async function editUserMessageAction(input: { id: string; body: string; episodeTags: string[] }): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const checked = await checkMessageInput(input);
    if (checked.message) return { success: false, message: checked.message };
    const { getWorkflowRepository, requireAuthenticatedAccountId } = await import("../../lib/workflow-runtime");
    const accountId = await requireAuthenticatedAccountId();
    const edited = await getWorkflowRepository().editUserMessage({
      accountId,
      id: input.id,
      body: checked.body,
      episodeTags: input.episodeTags,
      now: new Date().toISOString(),
    });
    return edited ? { success: true } : { success: false, message: MESSAGE_ALREADY_TAKEN };
  } catch (error) {
    return { success: false, message: `修改没成功：${String(error)}` };
  }
}

export async function withdrawUserMessageAction(input: { id: string }): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, requireAuthenticatedAccountId } = await import("../../lib/workflow-runtime");
    const accountId = await requireAuthenticatedAccountId();
    const withdrawn = await getWorkflowRepository().withdrawUserMessage({ accountId, id: input.id, now: new Date().toISOString() });
    return withdrawn ? { success: true } : { success: false, message: MESSAGE_ALREADY_TAKEN };
  } catch (error) {
    return { success: false, message: `撤回没成功：${String(error)}` };
  }
}

/** What 「现在处理」 did. "queued": a replace run is queued for the work's waiting
 *  messages. "already_running": a run of this work is already queued or running — a
 *  queued replace run takes the messages along when it starts, otherwise they go right
 *  after the run in flight (the idle-queue scan), so the card says 「排队中 · 这次处理完
 *  接着处理」. "nothing_waiting": claimed or withdrawn since the page loaded. */
export type ProcessMessagesNowStatus = "queued" | "already_running" | "nothing_waiting";

/** 「现在处理」: the work's waiting messages skip the patrol. */
export async function processMessagesNowAction(
  input: MessageWorkInput,
): Promise<PushSettingsActionResult & { status?: ProcessMessagesNowStatus }> {
  assertNotDemo();
  try {
    const { repo, work } = await messageWorkFor(input);
    if (!work) return { success: false, message: MESSAGE_NOT_TRACKED };
    // Like every acquire entry point: never queue a run that can only fail in the worker.
    const preflight = await acquireLlmNotConfigured();
    if (preflight) return { success: false, message: preflight.message };
    const drive = (await repo.listConnectedStorages(work.accountId)).find((s) => s.id === work.drive);
    if (drive?.status === "frozen") return { success: false, message: "这块网盘登录已失效，重新绑定后再处理" };
    const { queueReplaceRequest } = await import("@media-track/workflow");
    if ((await repo.markUserMessagesUrgent({ ...work, now: new Date().toISOString() })) === 0) {
      return { success: true, status: "nothing_waiting" };
    }
    const result = await queueReplaceRequest({ repository: repo, work, origin: "user" });
    if (result.status === "not_tracked") return { success: false, message: MESSAGE_NOT_TRACKED };
    return { success: true, status: result.status };
  } catch (error) {
    return { success: false, message: `没能开始处理：${String(error)}` };
  }
}

/** 「不换了」: these episodes stay as they are; the patrol stops looking for them. Saved at
 *  once — the card's 撤销 calls restoreEpisodesToPendingAction. Refused while a replace run
 *  of the work is processing, as the card's button is — checked again here, since the page
 *  may not have seen the run start. */
export async function keepEpisodesAsIsAction(
  input: MessageWorkInput & { episodes: string[] },
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { USER_MESSAGE_LIMITS } = await import("@media-track/workflow");
    const { repo, scope, work } = await messageWorkFor(input);
    if (!work) return { success: false, message: MESSAGE_NOT_TRACKED };
    const { episodes } = input;
    if (!Array.isArray(episodes) || episodes.length > USER_MESSAGE_LIMITS.tagsMax || episodes.some((e) => typeof e !== "string")) {
      return { success: false, message: "集数不对" };
    }
    const { keepMustWait } = await import("../../lib/user-message-server");
    if (await keepMustWait({ repo, scope, work })) {
      const { KEEP_BUSY_HINT } = await import("../../lib/user-message-state");
      return { success: false, message: KEEP_BUSY_HINT };
    }
    await repo.removePendingReplacements({ ...work, episodes });
    return { success: true };
  } catch (error) {
    return { success: false, message: `没能保存：${String(error)}` };
  }
}

/** A 待换 row as the card got it (loadMessageThread): what 撤销 puts back. */
export interface PendingEpisodeInput {
  episode: string;
  messageId: string;
  requestedAt: string;
}

/** 撤销 after 「不换了」: the 待换 rows go back exactly as they were (the message that asked,
 *  and when), so the patrol looks for these episodes again. A row that is somehow still
 *  there is left alone. Only rows this work's own 待换 could have held are taken — its own
 *  messages, its own episodes, no future time — and one that is not refuses the whole call. */
export async function restoreEpisodesToPendingAction(
  input: MessageWorkInput & { episodes: PendingEpisodeInput[] },
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { USER_MESSAGE_LIMITS } = await import("@media-track/workflow");
    const { parsePendingRows, pendingRowsFitWork } = await import("../../lib/user-message-server");
    const rows = parsePendingRows(input.episodes, input.mediaType, USER_MESSAGE_LIMITS.tagsMax);
    if (!rows) return { success: false, message: "集数不对" };
    const { repo, scope, work } = await messageWorkFor(input);
    if (!work) return { success: false, message: MESSAGE_NOT_TRACKED };
    if (!(await pendingRowsFitWork({ repo, scope, work, mediaType: input.mediaType, rows, now: new Date() }))) {
      return { success: false, message: "要恢复的集对不上这部作品" };
    }
    // addPendingReplacements takes one message and one time per call.
    const groups = new Map<string, { messageId: string; requestedAt: string; episodes: string[] }>();
    for (const row of rows) {
      const key = `${row.messageId} ${row.requestedAt}`;
      const group = groups.get(key) ?? { messageId: row.messageId, requestedAt: row.requestedAt, episodes: [] };
      group.episodes.push(row.episode);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      await repo.addPendingReplacements({ ...work, episodes: group.episodes, messageId: group.messageId, now: group.requestedAt });
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `没能撤销：${String(error)}` };
  }
}
