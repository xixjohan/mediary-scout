"use client";

import { useState, useTransition } from "react";
import { Check, FolderSync, LoaderCircle } from "lucide-react";
import {
  saveLibraryDirNamingAction,
  type LibraryDirNamingInput,
} from "../../../app/actions/settings-runtime-governance-actions";
import { runAction } from "../../../lib/run-action";

export function LibraryDirNamingForm({ initial }: { initial: LibraryDirNamingInput }) {
  const [isPending, startTransition] = useTransition();
  const [rootName, setRootName] = useState(initial.rootName || "Mediary Scout");
  const [moviesName, setMoviesName] = useState(initial.moviesName || "Movies");
  const [tvName, setTvName] = useState(initial.tvName || "TV");
  const [animeName, setAnimeName] = useState(initial.animeName || "Anime");
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () =>
          saveLibraryDirNamingAction({
            rootName,
            moviesName,
            tvName,
            animeName,
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 媒体库目录偏好已保存" : `❌ ${res.message}`);
      setTimeout(() => setResult(null), 3500);
    });
  };

  const handleResetDefaults = () => {
    setRootName("Mediary Scout");
    setMoviesName("Movies");
    setTvName("TV");
    setAnimeName("Anime");
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        自定义新绑定网盘时自动初始化的媒体库目录名称。保存后作为新绑网盘的建树模板；已绑定的网盘继续沿用其已固化的目录结构，安全不发生历史文件漂移。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            媒体库根目录
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="Mediary Scout"
            value={rootName}
            onChange={(e) => setRootName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            电影子目录
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="Movies"
            value={moviesName}
            onChange={(e) => setMoviesName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            剧集子目录
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="TV"
            value={tvName}
            onChange={(e) => setTvName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted block" style={{ marginBottom: 4 }}>
            番剧子目录
          </label>
          <input
            type="text"
            className="setting-control w-full"
            placeholder="Anime"
            value={animeName}
            onChange={(e) => setAnimeName(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存目录偏好
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={handleResetDefaults}
          disabled={isPending}
        >
          <FolderSync size={14} aria-hidden />
          填入官方默认值
        </button>
      </div>

      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
