/**
 * CredentialStore（任务单 S1.6）：凭据相关持久化切片的 Kysely 实现。
 *
 * 覆盖 app_settings / account_settings / connected_storages 三张表的全部
 * 读写——也就是所有"泄了就该出事"的数据所在。行为与迁移前的手写 SQL
 * 逐条对齐（跨账号冲突 no-op、同账号刷新、frozen 保留、按 (id, account)
 * 删除），由 tests/credential-store.test.ts 钉死。
 *
 * 加解密不在此层：调用方（SqliteWorkflowRepository）负责在边界上
 * encryptSecret / decryptSecret，本 store 只做类型安全的持久化。
 */
import type { Kysely } from "kysely";
import type { MediaryDatabase } from "./db-schema.js";
import type { ConnectedStorage, UpsertConnectedStorageInput } from "./account-credentials.js";

/** connected_storages 的原始行形状（payload 为落盘文本，可能是密文）。 */
export interface ConnectedStorageRecord {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
  label: string | null;
  payload: string;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
  status: "active" | "frozen";
  frozenReason: string | null;
  frozenAt: string | null;
  createdAt: string;
}

/** upsert 入参：payload 由调用方序列化并加密后，以 payloadText 原样落盘。 */
export type UpsertConnectedStorageText = Omit<UpsertConnectedStorageInput, "payload"> & {
  payloadText: string;
};

export class CredentialStore {
  constructor(private readonly kysely: Kysely<MediaryDatabase>) {}

  // ---- app_settings ----

  async getGlobalSetting(key: string): Promise<string | null> {
    const row = await this.kysely
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async setGlobalSetting(key: string, value: string): Promise<void> {
    await this.kysely
      .insertInto("app_settings")
      .values({ key, value })
      .onConflict((oc) => oc.columns(["key"]).doUpdateSet({ value }))
      .execute();
  }

  // ---- account_settings ----

  async getAccountSetting(accountId: string, key: string): Promise<string | null> {
    const row = await this.kysely
      .selectFrom("account_settings")
      .select("value")
      .where("account_id", "=", accountId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
    await this.kysely
      .insertInto("account_settings")
      .values({ account_id: accountId, key, value })
      .onConflict((oc) => oc.columns(["account_id", "key"]).doUpdateSet({ value }))
      .execute();
  }

  // ---- connected_storages ----

  /**
   * 绑定/重绑网盘。UNIQUE(provider, provider_uid) 冲突时：
   * 同账号 → 刷新 label/payload/CIDs（status/frozen 不在 SET 列表，保留冻结态）；
   * 跨账号 → WHERE 不成立，整句 no-op（偷不占、改不了）。
   */
  async upsertConnectedStorage(row: UpsertConnectedStorageText): Promise<void> {
    await this.kysely
      .insertInto("connected_storages")
      .values({
        id: row.id,
        account_id: row.accountId,
        provider: row.provider,
        provider_uid: row.providerUid,
        label: row.label ?? null,
        payload: row.payloadText,
        root_cid: row.rootCid ?? null,
        movies_cid: row.moviesCid ?? null,
        tv_cid: row.tvCid ?? null,
        anime_cid: row.animeCid ?? null,
        created_at: row.createdAt,
      })
      .onConflict((oc) =>
        oc
          .columns(["provider", "provider_uid"])
          .doUpdateSet({
            label: row.label ?? null,
            payload: row.payloadText,
            root_cid: row.rootCid ?? null,
            movies_cid: row.moviesCid ?? null,
            tv_cid: row.tvCid ?? null,
            anime_cid: row.animeCid ?? null,
          })
          .whereRef("account_id", "=", "excluded.account_id"),
      )
      .execute();
  }

  async findConnectedStorageByUid(provider: string, providerUid: string): Promise<ConnectedStorageRecord | null> {
    const row = await this.kysely
      .selectFrom("connected_storages")
      .selectAll()
      .where("provider", "=", provider)
      .where("provider_uid", "=", providerUid)
      .executeTakeFirst();
    return row ? this.toRecord(row) : null;
  }

  async listConnectedStorages(accountId: string): Promise<ConnectedStorageRecord[]> {
    const rows = await this.kysely
      .selectFrom("connected_storages")
      .selectAll()
      .where("account_id", "=", accountId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((r) => this.toRecord(r));
  }

  async setConnectedStorageStatus(
    storageId: string,
    status: "active" | "frozen",
    frozenReason: string | null,
    frozenAt: string | null,
  ): Promise<void> {
    await this.kysely
      .updateTable("connected_storages")
      .set({ status, frozen_reason: frozenReason, frozen_at: frozenAt })
      .where("id", "=", storageId)
      .execute();
  }

  /** 按 (id, account) 删除；返回是否真的删掉了（跨账号删除是 no-op）。 */
  async deleteConnectedStorage(storageId: string, accountId: string): Promise<boolean> {
    const result = await this.kysely
      .deleteFrom("connected_storages")
      .where("id", "=", storageId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async hasAnyConnectedStorage(): Promise<boolean> {
    const row = await this.kysely
      .selectFrom("connected_storages")
      .select((eb) => eb.lit(1).as("one"))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  private toRecord(row: {
    id: string;
    account_id: string;
    provider: string;
    provider_uid: string;
    label: string | null;
    payload: string;
    root_cid: string | null;
    movies_cid: string | null;
    tv_cid: string | null;
    anime_cid: string | null;
    status: string;
    frozen_reason: string | null;
    frozen_at: string | null;
    created_at: string;
  }): ConnectedStorageRecord {
    return {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      providerUid: row.provider_uid,
      label: row.label,
      payload: row.payload,
      rootCid: row.root_cid,
      moviesCid: row.movies_cid,
      tvCid: row.tv_cid,
      animeCid: row.anime_cid,
      status: row.status === "frozen" ? "frozen" : "active",
      frozenReason: row.frozen_reason,
      frozenAt: row.frozen_at,
      createdAt: row.created_at,
    };
  }
}

/** 供仓储把 record 还原为领域对象（含解密由调用方负责）。 */
export function connectedStorageFromRecord(
  record: ConnectedStorageRecord,
  payload: unknown,
): ConnectedStorage {
  return {
    id: record.id,
    accountId: record.accountId,
    provider: record.provider,
    providerUid: record.providerUid,
    label: record.label,
    payload,
    rootCid: record.rootCid,
    moviesCid: record.moviesCid,
    tvCid: record.tvCid,
    animeCid: record.animeCid,
    status: record.status,
    frozenReason: record.frozenReason,
    frozenAt: record.frozenAt,
    createdAt: record.createdAt,
  };
}
