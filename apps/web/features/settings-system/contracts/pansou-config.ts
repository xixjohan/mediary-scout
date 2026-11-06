/** PanSou settings accepted by the settings form and server action. */
export interface PanSouConfigInput {
  username?: string;
  password?: string;
  /** Directly pasted JWT. Takes precedence over username/password. */
  token?: string;
}

export type PanSouConfigSaveMode = "override" | "credentials" | "clear";
