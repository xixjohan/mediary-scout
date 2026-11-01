import { connection } from "next/server";
import { FolderTree } from "lucide-react";
import { LibraryDirNamingForm } from "../library-dir-naming-form";
import { getLibraryDirNamingAction } from "../../../../app/actions/settings-runtime-governance-actions";

export async function LibraryDirNamingSection() {
  await connection();
  const initial = await getLibraryDirNamingAction();
  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <FolderTree size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            媒体库目录偏好
          </h2>
          <p className="panel-note">新连接网盘时的目录命名建树规则（根目录及电影/剧集/番剧分类文件夹名称）</p>
        </div>
      </div>
      <LibraryDirNamingForm initial={initial} />
    </section>
  );
}
