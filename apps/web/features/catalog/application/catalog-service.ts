import { getWorkflowRepository } from "../../../composition/runtime-container";
import { ForeignWorkFinding, ForeignWorkReview } from "../contracts/catalog-types";

export async function getForeignWorkReview(
  workflowRunId: string,
  accountId: string,
): Promise<ForeignWorkReview | null> {
  const repository = getWorkflowRepository();
  const snapshot = await repository.getWorkflowRunSnapshot(workflowRunId, accountId);
  if (!snapshot) {
    return null;
  }
  const findings = snapshot.workflowRun.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event) => event.data as unknown as ForeignWorkFinding)
    .filter((finding) => Array.isArray(finding?.files) && finding.files.length > 0);
  return { workflowRunId, titleName: snapshot.title.title, findings };
}
