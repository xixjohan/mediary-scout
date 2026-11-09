import { connection } from "next/server";
import { Languages } from "lucide-react";
import { PreferredLanguageForm } from "../preferred-language-form";
import {
  getCurrentAccountId,
  getAccountScopedSettings,
  PREFERRED_LANGUAGE_SETTING_KEY,
} from "../../../../lib/workflow-runtime";

export async function PreferredLanguageSection() {
  await connection();
  const repository = getAccountScopedSettings(await getCurrentAccountId());
  const initial = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY)) ?? "中文";
  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Languages size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            偏好语言
          </h2>
          <p className="panel-note">搜索资源时优先你偏好的字幕语言，避免拿到看不了的版本</p>
        </div>
      </div>
      <PreferredLanguageForm initial={initial} />
    </section>
  );
}
