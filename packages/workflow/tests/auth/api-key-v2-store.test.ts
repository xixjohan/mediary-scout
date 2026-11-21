import { describe, expect, it } from "vitest";
import { ApiKeyV2Store } from "../../src/auth/api-key-v2-store.js";
import type { WorkflowRepository } from "../../src/persistence/repository.js";

function createInMemoryRepo(): WorkflowRepository {
  const store = new Map<string, string>();
  return {
    getSetting: async (key: string) => store.get(key) || null,
    setSetting: async (key: string, val: string) => {
      store.set(key, val);
    },
  } as unknown as WorkflowRepository;
}

describe("ApiKeyV2Store in-place update", () => {
  it("successfully updates key name, permissions, channels and increments version", async () => {
    const repo = createInMemoryRepo();
    const store = new ApiKeyV2Store(repo);

    const created = await store.createKey({
      name: "Old Agent Key",
      permissions: ["media:search", "media:detail"],
      allowApi: true,
      allowMcp: true,
      expiresAt: 1700000000000,
    });

    const originalHash = created.entity.keyHash;
    const originalPrefix = created.entity.keyPrefix;
    const originalMasked = created.entity.maskedKey;

    const updated = await store.updateKey(
      created.entity.id,
      {
        name: "Renamed Agent Key",
        permissions: ["media:search", "media:detail", "strm:read"],
        allowApi: true,
        allowMcp: false,
        expiresAt: 1800000000000,
      },
      ["*"] // Owner actor
    );

    expect(updated.id).toBe(created.entity.id);
    expect(updated.name).toBe("Renamed Agent Key");
    expect(updated.permissions).toEqual(["media:search", "media:detail", "strm:read"]);
    expect(updated.allowApi).toBe(true);
    expect(updated.allowMcp).toBe(false);
    expect(updated.expiresAt).toBe(1800000000000);
    expect(updated.updatedAt).toBeTypeOf("number");
    expect(updated.version).toBe(2);

    // 验证密钥不可变性 (In-place Mutation 不篡改密钥本身)
    expect(updated.keyHash).toBe(originalHash);
    expect(updated.keyPrefix).toBe(originalPrefix);
    expect(updated.maskedKey).toBe(originalMasked);

    // 重新查库验证持久化单源性
    const fetched = await store.getKey(created.entity.id);
    expect(fetched?.name).toBe("Renamed Agent Key");
    expect(fetched?.permissions).toContain("strm:read");
    expect(fetched?.version).toBe(2);
  });

  it("enforces delegation boundary guard (Subset Invariance Theorem)", async () => {
    const repo = createInMemoryRepo();
    const store = new ApiKeyV2Store(repo);

    const created = await store.createKey({
      name: "Member Key",
      permissions: ["media:search"],
    });

    const memberActorPerms = ["media:search", "media:detail", "storage:list"];

    // 尝试塞入超出 Member 自身角色的权限
    await expect(
      store.updateKey(
        created.entity.id,
        {
          permissions: ["media:search", "system:settings"],
        },
        memberActorPerms
      )
    ).rejects.toThrow(/权限越界/);

    // 正常子集权限允许更新
    const okUpdated = await store.updateKey(
      created.entity.id,
      {
        permissions: ["media:search", "storage:list"],
      },
      memberActorPerms
    );
    expect(okUpdated.permissions).toEqual(["media:search", "storage:list"]);
  });

  it("enforces state machine terminal state guard (revoked key cannot be edited)", async () => {
    const repo = createInMemoryRepo();
    const store = new ApiKeyV2Store(repo);

    const created = await store.createKey({
      name: "Leaked Key",
      permissions: ["media:search"],
    });

    // 吊销此 Key
    await store.revokeKey(created.entity.id);

    // 尝试就地编辑吊销 Key 必须被状态机拦截
    await expect(
      store.updateKey(created.entity.id, {
        name: "Revived Key",
        permissions: ["media:search", "media:play"],
      })
    ).rejects.toThrow("已吊销的 API Key 无法编辑权限");
  });

  it("enforces protocol channel validity guard (cannot disable both channels)", async () => {
    const repo = createInMemoryRepo();
    const store = new ApiKeyV2Store(repo);

    const created = await store.createKey({
      name: "Channel Key",
      permissions: ["media:search"],
      allowApi: true,
      allowMcp: true,
    });

    await expect(
      store.updateKey(created.entity.id, {
        allowApi: false,
        allowMcp: false,
      })
    ).rejects.toThrow("必须至少启用 REST API 或 MCP 中的一个访问通道");
  });

  it("precisely evicts prefix cache upon in-place update", async () => {
    const repo = createInMemoryRepo();
    const store = new ApiKeyV2Store(repo);

    const created = await store.createKey({
      name: "Cached Key",
      permissions: ["media:search"],
    });

    // 第一次查：填入 _prefixCache
    const hit1 = await store.findKeyByPlainToken(created.plainTextKey);
    expect(hit1).toBeDefined();
    expect(hit1?.permissions).toEqual(["media:search"]);

    // 更新权限为增加 media:detail
    await store.updateKey(created.entity.id, {
      permissions: ["media:search", "media:detail"],
    });

    // 第二次查：前缀缓存已精准驱逐，返回包含最新权限的实体
    const hit2 = await store.findKeyByPlainToken(created.plainTextKey);
    expect(hit2).toBeDefined();
    expect(hit2?.permissions).toEqual(["media:search", "media:detail"]);
    expect(hit2?.version).toBe(2);
  });
});
