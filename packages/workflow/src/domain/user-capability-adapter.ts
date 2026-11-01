import { getMultiUserMode, type MultiUserMode } from "./storage-scope-strategy.js";

export interface UserCapabilities {
  canRequest: boolean;
  canBypassApproval: boolean;
  canManageDrives: boolean;
  canDeleteMedia: boolean;
  canViewGlobalSettings: boolean;
  dailyRequestQuota: number;
}

export class UserCapabilityAdapter {
  static getCapabilities(
    account: { id: string; isOwner: boolean },
    mode: MultiUserMode = getMultiUserMode(),
  ): UserCapabilities {
    if (mode === "off") {
      return {
        canRequest: true,
        canBypassApproval: true,
        canManageDrives: true,
        canDeleteMedia: true,
        canViewGlobalSettings: true,
        dailyRequestQuota: Infinity,
      };
    }

    if (mode === "isolated") {
      return {
        canRequest: true,
        canBypassApproval: true,
        canManageDrives: true,
        canDeleteMedia: true,
        canViewGlobalSettings: account.isOwner,
        dailyRequestQuota: Infinity,
      };
    }

    // Shared Resource Mode:
    // Only owner can manage physical drives, delete shared media, and view global system settings.
    // Regular users can request media and are subject to daily quota.
    return {
      canRequest: true,
      canBypassApproval: account.isOwner,
      canManageDrives: account.isOwner,
      canDeleteMedia: account.isOwner,
      canViewGlobalSettings: account.isOwner,
      dailyRequestQuota: account.isOwner ? Infinity : 10,
    };
  }
}
