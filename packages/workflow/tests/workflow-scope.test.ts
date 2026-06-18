import { describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../src/domain.js";
import { scopeFromAccount, type WorkflowScope } from "../src/workflow-scope.js";

describe("WorkflowScope", () => {
  it("scopeFromAccount fills account + storage", () => {
    const s: WorkflowScope = scopeFromAccount(DEFAULT_ACCOUNT_ID, "cs_1");
    expect(s).toEqual({ accountId: DEFAULT_ACCOUNT_ID, connectedStorageId: "cs_1" });
  });
  it("scopeFromAccount allows null storage (pre-migration / unscoped reads)", () => {
    expect(scopeFromAccount(DEFAULT_ACCOUNT_ID, null)).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      connectedStorageId: null,
    });
  });
});
