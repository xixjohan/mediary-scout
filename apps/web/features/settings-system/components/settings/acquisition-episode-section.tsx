import { connection } from "next/server";
import { FolderTree } from "lucide-react";
import { AcquisitionEpisodeForm } from "../acquisition-episode-form";
import { getCurrentAccountId, getAccountScopedSettings, getAcquisitionEpisodePolicies } from "../../../../lib/workflow-runtime";

export async function AcquisitionEpisodeSection() {
  await connection();
  const accountId = await getCurrentAccountId();
  const repository = getAccountScopedSettings(accountId);
  const initial = await getAcquisitionEpisodePolicies(repository);

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <FolderTree size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            单集搜索穿透与画质截止线
          </h2>
          <p className="panel-note">网盘合集文件清单穿透取件、智能单集裁决倾斜度与画质截止线洗版控制</p>
        </div>
      </div>
      <AcquisitionEpisodeForm initial={initial} />
    </section>
  );
}
