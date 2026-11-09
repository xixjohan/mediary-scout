import { connection } from "next/server";
import { ShieldAlert } from "lucide-react";
import { AcquisitionFilterForm } from "../acquisition-filter-form";
import { getCurrentAccountId, getAccountScopedSettings, getAcquisitionFilterPreferences } from "../../../../lib/workflow-runtime";

export async function AcquisitionFilterSection() {
  await connection();
  const accountId = await getCurrentAccountId();
  const repository = getAccountScopedSettings(accountId);
  const initial = await getAcquisitionFilterPreferences(repository);

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <ShieldAlert size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            资源排毒与无关内容过滤
          </h2>
          <p className="panel-note">前置过滤小说、有声书、影视原声带、花絮剪辑及伪装假种压缩包，避免浪费网盘离线配额</p>
        </div>
      </div>
      <AcquisitionFilterForm initial={initial} />
    </section>
  );
}
