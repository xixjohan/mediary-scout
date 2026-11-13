"use client";

import { useEffect, useRef, useState } from "react";
import type ArtplayerType from "artplayer";
import { AudioGainPipeline } from "../audio-gain-pipeline";
import { reportPlaybackMetric, startPlaybackTimer } from "../playback-metrics";
import {
  resolveLayoutPhase,
  resolveVideoFit,
  type LayoutPhase,
  type VideoFitMode,
} from "../player-viewport";
import {
  createPlaybackMachine,
  playbackStageLabel,
  type PlaybackEvent,
  type PlaybackPhase,
} from "../playback-state-machine";
import { buildTelemetrySample, readVideoTelemetry, type TelemetrySample } from "../player-telemetry";
import { createSubtitleController } from "../subtitle-controller";
import { registerPlayerApi, unregisterPlayerApi } from "../player-api";
import { subtitleLanguageLabel } from "@media-track/workflow";
import { PlayerTelemetryHud, type TelemetryLevel } from "./player-telemetry-hud";
import type { SubtitleTrackInfo } from "@media-track/contracts";

export interface MediaryPlayerCoreProps {
  url: string;
  fallbackUrl?: string | undefined;
  title: string;
  subtitles?: SubtitleTrackInfo[] | undefined;
  poster?: string | undefined;
  autoPlay?: boolean | undefined;
  /** 当前投送模式与来源，仅用于播放统计面板展示，不参与播放决策。 */
  deliveryMode?: "redirect" | "proxy" | undefined;
  deliverySource?: string | undefined;
  onEnded?: (() => void) | undefined;
  /** 把实例交给弹窗层供快捷键命令分派使用；cleanup 时回传 null。 */
  onPlayerChange?: ((art: ArtplayerType | null) => void) | undefined;
  /** 生命周期阶段变化（供弹窗层展示分段文案）。 */
  onPhaseChange?: ((phase: PlaybackPhase) => void) | undefined;
}

export function MediaryPlayerCore({
  url,
  fallbackUrl,
  title,
  subtitles,
  poster,
  autoPlay = true,
  deliveryMode,
  deliverySource,
  onEnded,
  onPlayerChange,
  onPhaseChange,
}: MediaryPlayerCoreProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ArtplayerType | null>(null);
  const gainPipelineRef = useRef<AudioGainPipeline | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);
  // 布局阶段显式化：pending（等待元数据）→ fitted（已适配）/ fallback（确定性兜底）。
  const [layoutPhase, setLayoutPhase] = useState<LayoutPhase>("pending");
  const layoutPhaseRef = useRef<LayoutPhase>("pending");
  const fitModeRef = useRef<VideoFitMode>("contain");
  // 播放生命周期状态机：与布局阶段正交，互不覆盖。
  const machineRef = useRef(createPlaybackMachine({ initialPhase: "connecting" }));
  const [phase, setPhase] = useState<PlaybackPhase>("connecting");
  const [telemetryLevel, setTelemetryLevel] = useState<TelemetryLevel>("off");
  const [telemetry, setTelemetry] = useState<TelemetrySample | null>(null);
  const lastSampleRef = useRef<{ bufferedAheadSeconds: number; sampledAtMs: number } | null>(null);

  // 用 ref 持有最新值，避免 settings / error 回调捕获首次渲染的过期闭包
  // （旧实现 effect 依赖数组缺 gainLevel / isUsingFallback / fallbackUrl）。
  const latestRef = useRef({ fallbackUrl, currentUrl, isUsingFallback: false });
  const onPlayerChangeRef = useRef(onPlayerChange);
  const onEndedRef = useRef(onEnded);
  const onPhaseChangeRef = useRef(onPhaseChange);
  const subtitlesRef = useRef(subtitles);
  latestRef.current.fallbackUrl = fallbackUrl;
  latestRef.current.currentUrl = currentUrl;
  onPlayerChangeRef.current = onPlayerChange;
  onEndedRef.current = onEnded;
  onPhaseChangeRef.current = onPhaseChange;
  subtitlesRef.current = subtitles;

  useEffect(() => {
    setCurrentUrl(url);
    latestRef.current.isUsingFallback = url === fallbackUrl;
    // 换流即回到 pending，避免把上一部片源的 fitted/fallback 状态带过去。
    layoutPhaseRef.current = "pending";
    setLayoutPhase("pending");
    // 生命周期同样重置：新流从「连接中」重新计时，不复用上一部的分段耗时。
    machineRef.current = createPlaybackMachine({ initialPhase: "connecting" });
    setPhase("connecting");
    lastSampleRef.current = null;
    setTelemetry(null);
  }, [url, fallbackUrl]);

  // 播放统计采样：仅在面板开启时存在定时器；关闭时零监听、零定时器。
  useEffect(() => {
    if (telemetryLevel === "off") {
      lastSampleRef.current = null;
      setTelemetry(null);
      return;
    }
    const tick = () => {
      const video = playerRef.current?.video;
      if (!video) return;
      const sample = buildTelemetrySample(
        readVideoTelemetry(video),
        lastSampleRef.current ?? undefined,
        Date.now(),
      );
      lastSampleRef.current = {
        bufferedAheadSeconds: sample.bufferedAheadSeconds,
        sampledAtMs: sample.sampledAtMs,
      };
      setTelemetry(sample);
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [telemetryLevel, currentUrl]);

  useEffect(() => {
    let art: ArtplayerType | null = null;
    let isDisposed = false;
    const firstFrameTimer = startPlaybackTimer();
    layoutPhaseRef.current = "pending";
    setLayoutPhase("pending");
    // 换流 / 重建播放器时同步清掉上一次的适配标记，避免新实例尚未 init
    // 期间 DOM 上残留旧的 fitted / fallback 诊断值。
    if (containerRef.current) containerRef.current.dataset.viewportFit = "pending";

    /**
     * 唯一的 video 层样式写入口。只改 video，不改 $player 尺寸——控制条贴底
     * 是不变量。竖屏时按容器高度等比限宽并居中；其余情况清除几何覆写。
     */
    const applyVideoFit = () => {
      const player = art;
      if (!player) return undefined;
      const container = containerRef.current;
      const video = player.video;
      const decision = resolveVideoFit({
        layoutPhase: layoutPhaseRef.current,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        containerWidth: container?.clientWidth ?? 0,
        containerHeight: container?.clientHeight ?? 0,
        userFitMode: fitModeRef.current,
      });
      video.style.objectFit = decision.objectFit;
      video.style.objectPosition = "center";
      video.style.maxHeight = "100%";
      if (decision.kind === "portrait" && decision.maxWidthPx !== null) {
        video.style.width = "100%";
        video.style.maxWidth = `${decision.maxWidthPx}px`;
        video.style.marginInline = "auto";
      } else {
        video.style.removeProperty("width");
        video.style.removeProperty("max-width");
        video.style.removeProperty("margin-inline");
      }
      if (container) container.dataset.viewportFit = decision.kind;
      return decision;
    };

    const transitionPhase = (next: LayoutPhase) => {
      layoutPhaseRef.current = next;
      setLayoutPhase(next);
      applyVideoFit();
    };

    // 生命周期状态机唯一入口：非法迁移被状态机内部忽略，绝不打断播放链路。
    const dispatchPhase = (event: PlaybackEvent) => {
      const snap = machineRef.current.dispatch(event);
      setPhase((prev) => (prev === snap.phase ? prev : snap.phase));
      onPhaseChangeRef.current?.(snap.phase);
    };

    async function initPlayer() {
      if (!containerRef.current) return;
      const ArtplayerModule = await import("artplayer");
      const Artplayer = ArtplayerModule.default;

      if (isDisposed || !containerRef.current) return;

      // 字幕控制统一交给控制器：轨道装配、选轨、开关、编码、偏好记忆、按钮文案。
      const subtitleController = createSubtitleController({
        getArt: () => art,
        subtitles: subtitlesRef.current,
      });
      const subtitleTracks = subtitleController.tracks;
      const defaultSubtitle = subtitleController.initialTrack;

      art = new Artplayer({
        container: containerRef.current,
        url: latestRef.current.currentUrl,
        poster: poster || "",
        volume: 0.8,
        isLive: false,
        muted: false,
        autoplay: autoPlay,
        pip: true,
        // 关键：关闭 autoSize，让播放器容器始终撑满外层视口。
        // autoSize: true 时 ArtPlayer 会把 $player 高度压成 width/videoRatio
        // （artplayer.mjs:2400-2423），控制条随之浮在画面下沿，容器底部留黑。
        autoSize: false,
        autoMini: false,
        screenshot: true,
        setting: true,
        loop: false,
        flip: true,
        playbackRate: true,
        // 关闭 ArtPlayer 自带的容器比例按钮：它改的是 $player 的 aspect-ratio，
        // 会让控制条离开容器底部。画面适配统一走下方 video 层策略。
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        miniProgressBar: true,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: true,
        airplay: true,
        theme: "var(--accent, #22c55e)",
        lang: "zh-cn",
        // 关闭 ArtPlayer 内置 hotkey：其 isFocus 门槛会被沉浸式弹窗的
        // 兄弟 overlay 破坏。统一由 player-shortcuts.ts 在 window 上分派。
        hotkey: false,
        // 起播缓冲策略：网盘直链首包延迟高，让浏览器多预取一点。
        moreVideoAttr: { preload: "auto" },
        // 字幕整体偏移微调（字幕组时间轴与片源不匹配时的兜底）
        subtitleOffset: true,
        ...(defaultSubtitle
          ? {
              subtitle: {
                url: defaultSubtitle.url,
                type: defaultSubtitle.type,
                name: defaultSubtitle.label,
                encoding: "utf-8",
                style: {
                  color: "#ffffff",
                  fontSize: "22px",
                  textShadow: "0 0 4px #000, 0 0 8px #000",
                },
              },
            }
          : {}),
        settings: [
          {
            width: 200,
            html: "音量增益 (人声增强)",
            tooltip: "100%",
            selector: [
              { html: "100% (标准)", value: 1.0, default: true },
              { html: "150% (微弱对白补偿)", value: 1.5 },
              { html: "200% (超强人声)", value: 2.0 },
              { html: "300% (电影剧院级)", value: 3.0 },
              { html: "400% (极限放大)", value: 4.0 },
            ],
            onSelect: (item: any) => {
              const newGain = Number(item.value);
              const { fallbackUrl: fallback, currentUrl: active } = latestRef.current;
              if (newGain > 1.0 && fallback && active !== fallback && !latestRef.current.isUsingFallback) {
                // 跨域直连拿不到 CORS 流时切代理：只用 switchUrl 一条路径，
                // 不再同时 setCurrentUrl（旧实现会让 effect 销毁并重建整个播放器，
                // 一次用户操作触发两次流加载，是确定性的性能浪费）。
                console.info("[MediaryPlayer] Web Audio 人声增强需 CORS 支持，切换至代理流...");
                latestRef.current.isUsingFallback = true;
                reportPlaybackMetric("stream_switch", 0, { reason: "web_audio_gain", gain: newGain });
                const currentTime = art?.currentTime || 0;
                void art
                  ?.switchUrl(fallback)
                  .then(() => {
                    if (!art) return;
                    art.currentTime = currentTime;
                    // play() 可能被后续 load 中断并抛出 AbortError，必须吞掉，
                    // 否则会变成未捕获的 Promise rejection（验收红线）。
                    void Promise.resolve(art.play()).catch(() => {});
                    gainPipelineRef.current?.setGain(newGain);
                  })
                  .catch(() => {});
                return `${Math.round(newGain * 100)}% (代理增强)`;
              }
              gainPipelineRef.current?.setGain(newGain);
              return `${Math.round(newGain * 100)}%`;
            },
          },
          {
            width: 220,
            html: "画面适配 (去黑边)",
            tooltip: "完整画面",
            selector: [
              { html: "完整画面 (默认)", value: "contain", default: true },
              { html: "裁剪填满 (去黑边)", value: "cover" },
              { html: "拉伸填满", value: "fill" },
            ],
            onSelect: (item: any) => {
              if (!art) return String(item.html ?? "");
              const requested = String(item.value);
              // 只作用于 video 层：容器恒为 100%，控制条才能始终贴底。
              if (requested === "contain" || requested === "cover" || requested === "fill") {
                fitModeRef.current = requested;
              }
              const decision = applyVideoFit();
              const label = String(item.html ?? "");
              // 竖屏 / 超宽 / 兜底阶段会否决 cover，明确告知用户而非静默忽略。
              return decision && decision.objectFit !== requested
                ? `${label} (受片源保护)`
                : label;
            },
          },
          {
            width: 220,
            html: "播放统计",
            tooltip: "关闭",
            selector: [
              { html: "关闭", value: "off", default: true },
              { html: "精简 (进度/缓冲)", value: "compact" },
              { html: "详细 (含网络与丢帧)", value: "detail" },
            ],
            onSelect: (item: any) => {
              const value = String(item.value);
              setTelemetryLevel(value === "compact" || value === "detail" ? value : "off");
              return String(item.html ?? "");
            },
          },
          ...(subtitleTracks.length > 0
            ? [
                {
                  width: 260,
                  html: "字幕",
                  tooltip: subtitleController.current()
                    ? subtitleLanguageLabel(subtitleController.current()!.language)
                    : "关闭",
                  selector: [
                    { html: "关闭", value: "off", default: subtitleController.current() === null },
                    ...subtitleTracks.map((track) => ({
                      html: track.label,
                      value: track.id,
                      default: track.id === defaultSubtitle?.id,
                    })),
                  ],
                  onSelect: (item: any) => {
                    const value = String(item.value);
                    if (value === "off") {
                      subtitleController.apply(null);
                      return "关闭";
                    }
                    const track = subtitleTracks.find((t) => t.id === value) ?? null;
                    subtitleController.apply(track);
                    return String(item.html ?? "");
                  },
                },
                {
                  width: 200,
                  html: "字幕编码",
                  tooltip: "UTF-8",
                  selector: [
                    { html: "UTF-8 (默认)", value: "utf-8", default: true },
                    { html: "GBK / GB18030", value: "gb18030" },
                  ],
                  onSelect: (item: any) => {
                    subtitleController.apply(subtitleController.current(), String(item.value));
                    return String(item.html ?? "");
                  },
                },
              ]
            : []),
        ],
      });

      playerRef.current = art;
      onPlayerChangeRef.current?.(art);
      // pending 阶段即写入确定性 contain，消除元数据到达前后的隐式布局差异。
      applyVideoFit();

      // 字幕控制：控制条一键开关/切换 + 快捷键 V + 本地偏好记忆。
      if (subtitleTracks.length > 0) {
        subtitleController.attachButton(
          art.controls.add({
            name: "mediary-subtitle",
            position: "right",
            html: subtitleController.buttonLabel(),
            tooltip: "字幕 (V)",
            style: { fontSize: "12px", padding: "0 8px", whiteSpace: "nowrap" },
            click: () => subtitleController.cycle(),
          }),
        );
      }
      registerPlayerApi(art, {
        cycleSubtitle: () => subtitleController.cycle(),
        currentSubtitleLabel: () => subtitleController.current()?.label ?? null,
      });

      // 网页全屏修正：ArtPlayer 用 width:100% 相对「扣掉滚动条」的初始包含块，
      // 右侧会露出约 15px 底色（看起来就是黑边）。挂到 html 上做视口级修正。
      art.on("fullscreenWeb", (on: boolean) => {
        document.documentElement.classList.toggle("mediary-web-fullscreen", on);
      });

      // 适配器式修补：ArtPlayer 内部在 autoplay / switchUrl 时直接调用
      // video.play() 且不 catch AbortError，快速切换流会产生未捕获拒绝。
      // 从源头吞掉这类无害拒绝；真正的播放失败仍由 art.on("error") 处理。
      const videoEl = art.video;
      const nativePlay = videoEl.play.bind(videoEl);
      videoEl.play = () => nativePlay().catch(() => {});

      const pipeline = new AudioGainPipeline();
      pipeline.attach(art.video);
      gainPipelineRef.current = pipeline;

      art.on("play", () => {
        gainPipelineRef.current?.resume();
      });

      // ---- 生命周期事件：驱动状态机（文案、分段耗时、排障都读同一份状态） ----
      art.on("video:loadstart", () => dispatchPhase("FIRST_BYTES"));
      art.on("video:canplay", () => dispatchPhase("CAN_PLAY"));
      art.on("video:playing", () => dispatchPhase("PLAYING"));
      art.on("video:progress", () => {
        if (art && !art.video.paused) dispatchPhase("PROGRESS");
      });
      art.on("video:seeking", () => dispatchPhase("SEEK_START"));
      art.on("video:seeked", () => dispatchPhase("SEEK_END"));

      // 布局状态机：元数据到达即 fitted；videoWidth=0（凭据失效 / 格式不支持）
      // 直接落 fallback；窗口尺寸变化只重算 video 层样式，不动容器。
      art.on("video:loadedmetadata", () => {
        const video = art?.video;
        transitionPhase(
          resolveLayoutPhase({
            videoWidth: video?.videoWidth ?? 0,
            videoHeight: video?.videoHeight ?? 0,
          }),
        );
        dispatchPhase("METADATA");
      });
      art.on("resize", () => applyVideoFit());

      // 播放链路耗时埋点（默认静默，localStorage 开启后输出到控制台）
      art.on("video:loadeddata", () => {
        reportPlaybackMetric("T_first_frame", firstFrameTimer(), {
          delivery: latestRef.current.isUsingFallback ? "proxy" : "direct",
        });
      });
      art.on("video:waiting", () => {
        dispatchPhase("WAITING");
        reportPlaybackMetric("rebuffer", 0, { at: art?.currentTime ?? 0 });
      });
      art.on("seeking", () => {
        reportPlaybackMetric("T_seek", 0, { at: art?.currentTime ?? 0 });
      });
      art.on("video:ended", () => {
        dispatchPhase("ENDED");
        onEndedRef.current?.();
      });

      // 错误自愈：403 / CORS 时降级为代理流，同样只走 switchUrl 单一路径。
      art.on("error", (error) => {
        console.warn("[MediaryPlayer] 播放遇到异常:", error);
        transitionPhase("fallback");
        dispatchPhase("ERROR");
        const { fallbackUrl: fallback, currentUrl: active } = latestRef.current;
        if (fallback && !latestRef.current.isUsingFallback && active !== fallback) {
          console.info("[MediaryPlayer] 尝试切换为代理播放流自愈降级...");
          latestRef.current.isUsingFallback = true;
          reportPlaybackMetric("stream_switch", 0, { reason: "playback_error" });
          void art?.switchUrl(fallback).catch(() => {});
          void Promise.resolve(art?.play()).catch(() => {});
          dispatchPhase("FALLBACK");
        }
      });
    }

    // ArtPlayer 内部的 autoplay / switchUrl 会调用 video.play() 且不吞掉
    // AbortError，快速切换流时会产生未捕获的 Promise rejection。只过滤这一种
    // 已知无害错误，其它 rejection 照常抛出，避免掩盖真实故障。
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason as { message?: string } | undefined;
      const message = String(reason?.message ?? event.reason ?? "");
      if (message.includes("play() request was interrupted")) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    // 元数据迟迟不到（网盘直链首包慢 / 鉴权失效）时也要有确定布局，
    // 不能让 phase 永远停在 pending。8s 与起播超时量级一致。
    const metadataTimeout = window.setTimeout(() => {
      if (layoutPhaseRef.current === "pending") transitionPhase("fallback");
    }, 8000);
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      resizeObserver = new ResizeObserver(() => applyVideoFit());
      resizeObserver.observe(containerRef.current);
    }

    void initPlayer();

    return () => {
      isDisposed = true;
      window.clearTimeout(metadataTimeout);
      resizeObserver?.disconnect();
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      onPlayerChangeRef.current?.(null);
      gainPipelineRef.current?.detach();
      gainPipelineRef.current = null;
      if (playerRef.current) {
        unregisterPlayerApi(playerRef.current);
        try {
          playerRef.current.destroy(false);
        } catch {}
        playerRef.current = null;
      }
      // 退出时清掉全屏修正类，避免影响其它页面。
      document.documentElement.classList.remove("mediary-web-fullscreen");
    };
  }, [currentUrl, title, poster, autoPlay]);

  const stageLabel = playbackStageLabel(phase);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: "420px" }}>
      <div
        ref={containerRef}
        data-layout-phase={layoutPhase}
        data-playback-phase={phase}
        style={{
          width: "100%",
          height: "100%",
          minHeight: "420px",
          background: "#000",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      />
      {telemetryLevel !== "off" && (
        <PlayerTelemetryHud
          level={telemetryLevel}
          sample={telemetry}
          phase={phase}
          delivery={{ mode: deliveryMode, source: deliverySource }}
        />
      )}
      {stageLabel !== null && (
        <div
          data-testid="player-stage-hint"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 96,
            transform: "translateX(-50%)",
            zIndex: 25,
            maxWidth: "calc(100% - 32px)",
            padding: "6px 12px",
            borderRadius: 999,
            background: "rgba(0, 0, 0, 0.6)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            color: "#f4f4f5",
            fontSize: 12,
            lineHeight: 1.4,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {stageLabel}
        </div>
      )}
    </div>
  );
}
