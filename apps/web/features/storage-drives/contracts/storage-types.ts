export interface Pan115ConnectionStatus {
  connected: boolean;
  source: "qr" | "env" | "none";
  userName: string | null;
  app: string | null;
  connectedAt: string | null;
}

export interface ConnectedStorageView {
  id: string;
  provider: string;
  providerUid: string;
  label: string | null;
  connectedAt: string | null;
  /** Bind time — orders drives (earliest = primary workspace). */
  createdAt: string;
  /** active = usable; frozen = cookie died (re-bind to recover). */
  status: "active" | "frozen";
  /** True once category directories are provisioned (CIDs stored). */
  provisioned: boolean;
}

export interface AccountStorageCredentials {
  id: string;
  provider: string;
  status: "active" | "frozen";
  cookie: string;
  credential: Record<string, unknown> | null;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  status: "active" | "frozen";
  message: string;
}

export class StorageOwnedByOtherAccountError extends Error {
  constructor() {
    super("该网盘账号已被本实例的其他用户连接，无法重复绑定。");
    this.name = "StorageOwnedByOtherAccountError";
  }
}
