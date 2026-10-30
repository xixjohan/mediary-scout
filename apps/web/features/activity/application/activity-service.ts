import {
  getTrackedSeasonStatusView,
  type TrackedSeasonStatusView,
  type WorkflowRepository,
} from "@media-track/workflow";

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
  accountId: string,
): Promise<TrackedSeasonStatusView | null> {
  const trackedStates = await targetRepository.listTrackedSeasonStates(accountId);
  const firstTracked =
    trackedStates.find((state) => state.season.status === "active") ?? trackedStates[0];
  if (!firstTracked) {
    return null;
  }
  return getTrackedSeasonStatusView({
    repository: targetRepository,
    trackedSeasonId: firstTracked.season.id,
    scope: { accountId, connectedStorageId: firstTracked.connectedStorageId },
  });
}
