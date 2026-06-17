import { describe, expect, it } from "vitest";
import { resolveStorageBinding, provisionCategoryDirs } from "../src/index.js";

describe("resolveStorageBinding", () => {
  const existing = { id: "cs1", accountId: "a1", provider: "pan115", providerUid: "115_X" };
  it("new uid → insert", () => {
    expect(
      resolveStorageBinding({ provider: "pan115", providerUid: "115_Y", accountId: "a1", existing: null }),
    ).toEqual({ action: "insert" });
  });
  it("same uid, same account → refresh", () => {
    expect(
      resolveStorageBinding({ provider: "pan115", providerUid: "115_X", accountId: "a1", existing }),
    ).toEqual({ action: "refresh", storageId: "cs1" });
  });
  it("same uid, other account → reject", () => {
    expect(
      resolveStorageBinding({ provider: "pan115", providerUid: "115_X", accountId: "a2", existing }),
    ).toEqual({ action: "reject", ownerAccountId: "a1" });
  });
});

describe("provisionCategoryDirs (find-or-create, idempotent)", () => {
  it("reuses existing same-name dirs, creates missing ones", async () => {
    const created: string[] = [];
    const fakeStorage = {
      async listChildDirs(parentId: string) {
        return parentId === "ROOT"
          ? [{ name: "media-track", id: "rootcid" }]
          : [{ name: "Movies", id: "moviescid" }];
      },
      async createDirectory({ name, parentId }: { name: string; parentId: string }) {
        const id = `new_${name}`;
        created.push(`${name}@${parentId}`);
        return id;
      },
    };
    const cids = await provisionCategoryDirs({ storage: fakeStorage, baseParentId: "ROOT" });
    expect(cids.rootCid).toBe("rootcid"); // reused
    expect(cids.moviesCid).toBe("moviescid"); // reused under root
    expect(cids.tvCid).toBe("new_TV"); // created
    expect(cids.animeCid).toBe("new_Anime"); // created
    expect(created).toEqual(["TV@rootcid", "Anime@rootcid"]);
  });
});
