export interface ForeignWorkFinding {
  stagingDirectoryId: string;
  files: Array<{ providerFileId: string; sourcePath: string }>;
}

export interface ForeignWorkReview {
  workflowRunId: string;
  titleName: string;
  findings: ForeignWorkFinding[];
}
