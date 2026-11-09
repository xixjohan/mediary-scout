import { connection } from "next/server";
import { Gauge } from "lucide-react";
import { QualityPreferenceForm } from "../quality-preference-form";
import {
  getCurrentAccountId,
  getAccountScopedSettings,
  QUALITY_PREFERENCE_SETTING_KEY,
} from "../../../../lib/workflow-runtime";

export async function QualityPreferenceSection() {
  await connection();
  const repository = getAccountScopedSettings(await getCurrentAccountId());
  const initial = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY)) ?? "any";
  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Gauge size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            偏好画质
          </h2>
          <p className="panel-note">优先获取的画质档位（覆盖优先，找不到不留缺）</p>
        </div>
      </div>
      <QualityPreferenceForm initial={initial} />
    </section>
  );
}
