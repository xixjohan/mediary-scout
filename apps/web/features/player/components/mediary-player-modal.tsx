"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Film, Volume2, X, RefreshCw, Zap, Keyboard, EyeOff } from "lucide-react";
import type ArtplayerType from "artplayer";
import { MediaryPlayerCore } from "./mediary-player-core";
import { SHORTCUT_HINT, SHORTCUT_SUMMARY, usePlayerShortcuts } from "../player-shortcuts";
import {
  HINT_VISIBILITY_LABELS,
  readHintVisibility,
  writeHintVisibility,
  type HintVisibility,
} from "../player-preferences";
import {
  readPlayerDeliveryPreferenceAction,
  savePlayerDeliveryPreferenceAction,
} from "../../../app/actions/player-delivery-actions";
import type { SubtitleTrackInfo } from "@media-track/contracts";

export interface MediaryPlayerModalProps {
  title: string;
  streamUrl: string;
  proxyUrl?: string | undefined;
  subtitles?: SubtitleTrackInfo[] | undefined;
  poster?: string | undefined;
  deliveryMode?: "redirect" | "proxy" | undefined;
  /** 投送模式来源（session/binding/library/global/driver-rule），用于排障展示。 */
  deliverySource?: string | undefined;
  /** 人类可读的决策原因，hover 标签可见。 */
  deliveryReason?: string | undefined;
  onClose: () => void;
}

export function MediaryPlayerModal({
  title,
  streamUrl,
  proxyUrl,
  subtitles,
  poster,
  deliveryMode = "redirect",
  deliverySource,
  deliveryReason,
  onClose,
}: MediaryPlayerModalProps) {
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [currentMode, setCurrentMode] = useState<"redirect" | "proxy">(deliveryMode);
  // P2-B：账号级投送偏好。三处播放入口（含不走 play 接口的文件夹视图）
  // 统一在弹窗内读取同一个 account_settings 键，避免偏好只在一处生效。
  const rememberedModeRef = useRef<"redirect" | "proxy" | null>(null);
  const [overrideActive, setOverrideActive] = useState(deliverySource === "session");
  const [preferenceReset, setPreferenceReset] = useState(false);
  const [decisionNote, setDecisionNote] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hintVisibility, setHintVisibility] = useState<HintVisibility>("auto");
  const [showHelp, setShowHelp] = useState(false);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const playerRef = useRef<ArtplayerType | null>(null);

  const resetHideTimer = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 3500);
  }, []);

  useEffect(() => {
    setMounted(true);
    setHintVisibility(readHintVisibility());
    resetHideTimer();
    // 读取失败 / 演示站只读：静默降级为服务端解析结果，不阻断播放。
    void readPlayerDeliveryPreferenceAction()
      .then((preference) => {
        if (preference !== "proxy" && preference !== "redirect") return;
        rememberedModeRef.current = preference;
        setCurrentMode(preference);
        setOverrideActive(true);
        setDecisionNote(
          `已记忆的投送偏好：${preference === "proxy" ? "服务器分片代理" : "302 CDN 直连"}（刷新后保持）`,
        );
      })
      .catch(() => {});
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [resetHideTimer]);

  // 父级交付模式异步到达后同步显示；若已有账号级偏好，以偏好为准。
  useEffect(() => {
    setCurrentMode(rememberedModeRef.current ?? deliveryMode);
  }, [deliveryMode]);

  useEffect(() => {
    if (rememberedModeRef.current === null) {
      setOverrideActive(deliverySource === "session");
    }
  }, [deliverySource]);

  // 统一快捷键分派（全局焦点策略 + Escape 单一归属），取代旧的 window Escape 监听。
  usePlayerShortcuts({
    playerRef,
    onClose,
    onToggleHelp: () => setShowHelp((prev) => !prev),
    enabled: mounted,
  });

  const cycleHintVisibility = useCallback(() => {
    setHintVisibility((prev) => {
      const order: HintVisibility[] = ["auto", "hidden", "always"];
      const next = order[(order.indexOf(prev) + 1) % order.length] ?? "auto";
      writeHintVisibility(next);
      return next;
    });
  }, []);

  const activeUrl = currentMode === "proxy" && proxyUrl ? proxyUrl : streamUrl;
  const fallbackUrl = currentMode === "redirect" && proxyUrl ? proxyUrl : undefined;

  const copyAbsoluteLink = () => {
    const fullUrl = activeUrl.startsWith("http") ? activeUrl : `${window.location.origin}${activeUrl}`;
    void navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const modeLabel = (mode: "redirect" | "proxy") =>
    mode === "redirect" ? "302 CDN 直连" : "服务器分片代理";

  const toggleDeliveryMode = () => {
    if (!proxyUrl) return;
    const next = currentMode === "redirect" ? "proxy" : "redirect";
    setCurrentMode(next);
    rememberedModeRef.current = next;
    setOverrideActive(true);
    setPreferenceReset(false);
    setDecisionNote(`用户手动选择：${modeLabel(next)}（已记忆，下次打开保持）`);
    // 持久化失败（演示站 / 未认证）时本次会话内仍然生效。
    void savePlayerDeliveryPreferenceAction(next).catch(() => {});
  };

  const resetDeliveryPreference = () => {
    rememberedModeRef.current = null;
    setOverrideActive(false);
    setPreferenceReset(true);
    setDecisionNote("已恢复默认：下次打开重新按路径绑定 / 影视库配置解析投送模式");
    void savePlayerDeliveryPreferenceAction("auto").catch(() => {});
  };

  // P2-C：把 hover 里的决策原因提升为常驻说明；没有 reason 的入口给出可读兜底。
  const decisionText =
    decisionNote ??
    deliveryReason ??
    `${modeLabel(currentMode)} · 来源 ${deliverySource ?? "默认策略"}`;

  if (!mounted) return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.94)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backdropFilter: "blur(16px)",
        padding: "0.5rem",
      }}
      onClick={onClose}
    >
      {/* 沉浸式无边框影院视口 */}
      <div
        style={{
          position: "relative",
          width: "96vw",
          maxWidth: "1480px",
          height: "92vh",
          maxHeight: "920px",
          borderRadius: "14px",
          overflow: "hidden",
          background: "#000",
          boxShadow: "0 30px 60px -12px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseMove={resetHideTimer}
      >
        {/* 顶部悬浮遮罩控制层 (Top Floating Overlay) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "76px",
            background: "linear-gradient(to bottom, rgba(0, 0, 0, 0.88) 0%, rgba(0, 0, 0, 0.45) 60%, transparent 100%)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "1rem 1.4rem",
            zIndex: 9999,
            opacity: controlsVisible ? 1 : 0,
            pointerEvents: controlsVisible ? "auto" : "none",
            transition: "opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          {/* 左侧：媒体标题与模式徽标 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              minWidth: 0,
              maxWidth: "65%",
            }}
          >
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "8px",
                background: "rgba(34, 197, 94, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Film size={18} style={{ color: "var(--accent, #22c55e)" }} />
            </div>

            <span
              style={{
                fontSize: "1.05rem",
                fontWeight: 600,
                color: "#ffffff",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                letterSpacing: "-0.01em",
              }}
              title={title}
            >
              {title}
            </span>

            {/* 严格防折行胶囊标签 */}
            <span
              style={{
                fontSize: "0.76rem",
                fontWeight: 600,
                padding: "0.22rem 0.65rem",
                borderRadius: "9999px",
                whiteSpace: "nowrap",
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                background: currentMode === "redirect" ? "rgba(34, 197, 94, 0.18)" : "rgba(59, 130, 246, 0.18)",
                border: currentMode === "redirect" ? "1px solid rgba(34, 197, 94, 0.35)" : "1px solid rgba(59, 130, 246, 0.35)",
                color: currentMode === "redirect" ? "#4ade80" : "#60a5fa",
              }}
            >
              <span
                style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: currentMode === "redirect" ? "#22c55e" : "#3b82f6",
                  boxShadow: currentMode === "redirect" ? "0 0 6px #22c55e" : "0 0 6px #3b82f6",
                }}
              />
              {currentMode === "redirect" ? "302 CDN 直连" : "服务器分片代理"}
              {deliverySource && (
                <span
                  title={deliveryReason ?? undefined}
                  style={{ opacity: 0.65, fontSize: "0.68rem", marginLeft: "0.15rem" }}
                >
                  · {deliverySource}
                </span>
              )}
            </span>
          </div>

          {/* 右侧：模式切换、复制、关闭按钮 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              flexShrink: 0,
            }}
          >
            {/* 提示条偏好切换常驻顶部：即便提示条本身被隐藏，也始终有入口切回。 */}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={cycleHintVisibility}
              title={`提示条：${HINT_VISIBILITY_LABELS[hintVisibility]}（点击切换：自动渐隐 → 隐藏 → 常显）`}
              aria-label="切换提示条显示方式"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                fontSize: "0.78rem",
                background: "rgba(255, 255, 255, 0.1)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                color: "#e4e4e7",
                padding: "0.35rem 0.6rem",
                borderRadius: "8px",
                backdropFilter: "blur(8px)",
              }}
            >
              <EyeOff size={13} />
              {HINT_VISIBILITY_LABELS[hintVisibility]}
            </button>

            {proxyUrl && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={toggleDeliveryMode}
                title="一键热切换流投送模式"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.8rem",
                  background: "rgba(255, 255, 255, 0.1)",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  color: "#e4e4e7",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "8px",
                  backdropFilter: "blur(8px)",
                }}
              >
                <RefreshCw size={13} />
                切为{currentMode === "redirect" ? "代理模式" : "302直连"}
              </button>
            )}

            {overrideActive && !preferenceReset && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={resetDeliveryPreference}
                aria-label="恢复默认投送模式"
                title="清除已记忆的投送偏好，恢复按影视库 / 路径绑定配置解析"
                style={{
                  fontSize: "0.78rem",
                  background: "rgba(255, 255, 255, 0.08)",
                  border: "1px solid rgba(255, 255, 255, 0.15)",
                  color: "#d4d4d8",
                  padding: "0.35rem 0.6rem",
                  borderRadius: "8px",
                  backdropFilter: "blur(8px)",
                }}
              >
                恢复默认
              </button>
            )}

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={copyAbsoluteLink}
              title="复制真实串流直链 (可直接在 PotPlayer / VLC 播放)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                fontSize: "0.8rem",
                background: copied ? "rgba(34, 197, 94, 0.2)" : "rgba(255, 255, 255, 0.1)",
                border: copied ? "1px solid rgba(34, 197, 94, 0.4)" : "1px solid rgba(255, 255, 255, 0.15)",
                color: copied ? "#4ade80" : "#e4e4e7",
                padding: "0.35rem 0.75rem",
                borderRadius: "8px",
                backdropFilter: "blur(8px)",
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "已复制播放链" : "复制链接"}
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              style={{
                width: "32px",
                height: "32px",
                padding: 0,
                borderRadius: "50%",
                background: "rgba(255, 255, 255, 0.12)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                color: "#f4f4f5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                backdropFilter: "blur(8px)",
              }}
              aria-label="关闭播放器 (Esc)"
              title="关闭 (Esc)"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* P2-C：投送决策原因常驻展示（不随顶部控制层渐隐，避免只能 hover 才看到） */}
        <div
          data-testid="player-delivery-reason"
          title={deliveryReason ?? undefined}
          style={{
            position: "absolute",
            top: "82px",
            left: "1.4rem",
            zIndex: 9998,
            maxWidth: "min(62%, 720px)",
            padding: "0.3rem 0.7rem",
            borderRadius: "8px",
            background: "rgba(0, 0, 0, 0.55)",
            backdropFilter: "blur(6px)",
            border: "1px solid rgba(255, 255, 255, 0.10)",
            color: "rgba(255, 255, 255, 0.72)",
            fontSize: "0.74rem",
            lineHeight: 1.45,
            pointerEvents: "none",
          }}
        >
          <span style={{ color: "#a1a1aa" }}>投送决策：</span>
          {decisionText}
        </div>

        {/* 底部悬浮快捷提示胶囊：三档偏好（常显 / 自动渐隐 / 隐藏），文案由命令注册表生成 */}
        {hintVisibility !== "hidden" && (
          <div
            style={{
              position: "absolute",
              bottom: "64px",
              left: "1.4rem",
              zIndex: 9999,
              display: "inline-flex",
              alignItems: "center",
              gap: "0.65rem",
              padding: "0.35rem 0.85rem",
              borderRadius: "9999px",
              background: "rgba(0, 0, 0, 0.65)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              fontSize: "0.78rem",
              color: "var(--text-muted, #a1a1aa)",
              opacity: hintVisibility === "always" || controlsVisible ? 1 : 0,
              pointerEvents: hintVisibility === "always" || controlsVisible ? "auto" : "none",
              transition: "opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: "#22c55e", fontWeight: 500 }}>
              <Zap size={13} /> Web Audio 人声增强
            </span>
            <span>•</span>
            <span>{SHORTCUT_HINT}</span>
            {subtitles && subtitles.length > 0 && (
              <>
                <span>•</span>
                <span style={{ color: "#38bdf8" }}>{subtitles.length} 条外挂/内嵌字幕</span>
              </>
            )}
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              title="查看全部快捷键 (?)"
              aria-label="查看全部快捷键"
              style={{ display: "inline-flex", alignItems: "center", background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "0 0.15rem" }}
            >
              <Keyboard size={14} />
            </button>
          </div>
        )}

        {/* 快捷键帮助面板：替代常驻提示承担新用户引导 */}
        {showHelp && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 10000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0, 0, 0, 0.72)",
            }}
            onClick={() => setShowHelp(false)}
          >
            <div
              style={{
                width: "min(440px, 90%)",
                maxHeight: "80%",
                overflowY: "auto",
                padding: "1.25rem 1.5rem",
                borderRadius: "14px",
                background: "rgba(24, 24, 27, 0.96)",
                border: "1px solid rgba(255, 255, 255, 0.14)",
                color: "#f4f4f5",
                fontSize: "0.86rem",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.9rem" }}>
                <strong style={{ fontSize: "1rem", fontWeight: 600 }}>播放器快捷键</strong>
                <button
                  type="button"
                  onClick={() => setShowHelp(false)}
                  aria-label="关闭快捷键说明"
                  style={{ background: "transparent", border: "none", color: "#a1a1aa", cursor: "pointer" }}
                >
                  <X size={16} />
                </button>
              </div>
              {SHORTCUT_SUMMARY.map(([keyLabel, label]) => (
                <div
                  key={`${keyLabel}-${label}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span style={{ color: "#a1a1aa" }}>{label}</span>
                  <span style={{ color: "#4ade80", fontFamily: "monospace" }}>{keyLabel}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "0.35rem 0" }}>
                <span style={{ color: "#a1a1aa" }}>退出全屏 / 关闭播放器</span>
                <span style={{ color: "#4ade80", fontFamily: "monospace" }}>Esc</span>
              </div>
            </div>
          </div>
        )}

        {/* 100% 满屏核心播放器画布 */}
        <div style={{ width: "100%", height: "100%", position: "relative" }}>
          <MediaryPlayerCore
            key={activeUrl}
            url={activeUrl}
            fallbackUrl={fallbackUrl}
            title={title}
            subtitles={subtitles}
            poster={poster}
            onPlayerChange={(art) => {
              playerRef.current = art;
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
