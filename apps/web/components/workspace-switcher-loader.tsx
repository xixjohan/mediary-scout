import { switcherItems } from "@media-track/workflow";
import { getAccountConnectedStorages } from "../lib/workflow-runtime";
import { WorkspaceSwitcher } from "./workspace-switcher";

/**
 * Server loader for the drive switcher: fetches the account's connected drives
 * (sanitized — no cookie) and hands the computed tab list to the client switcher.
 * Renders nothing for 0–1 drives, so single-user/single-drive sees no chrome.
 * Mounted inside a Suspense boundary in the layout so its DB read never blocks the
 * static shell (cacheComponents-safe).
 */
export async function WorkspaceSwitcherLoader() {
  const storages = (await getAccountConnectedStorages()).filter(
    (storage) => storage.provider === "pan115",
  );
  if (storages.length < 2) {
    return null;
  }
  // pathname is client-only; pass "/" here and let the client re-derive active.
  const tabs = switcherItems(
    storages.map((storage) => ({
      id: storage.id,
      label: storage.label,
      providerUid: storage.providerUid,
      createdAt: storage.createdAt,
      status: storage.status,
    })),
    "/",
  ).map((item) => ({ id: item.id, href: item.href, label: item.label, frozen: item.frozen }));
  return <WorkspaceSwitcher tabs={tabs} />;
}
