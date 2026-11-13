"use client";

import { useEffect, useRef, useState } from "react";
import type ArtplayerType from "artplayer";
import { AudioGainPipeline } from "../audio-gain-pipeline";
import { reportPlaybackMetric, startPlaybackTimer } from "../playback-metrics";
import type { SubtitleTrackInfo } from "@media-track/contracts";

export interface MediaryPlayerCoreProps {
  url: string;
  fallbackUrl?: string | undefined;
  title: string;
  subtitles?: SubtitleTrackInfo[] | undefined;
  poster?: string | undefined;
  autoPlay?: boolean | undefined;
  onEnded?: (() => void) | undefined;
  /** 把实例交给弹窗层供快捷键命令分派使用；cleanup 时回传 null。 */
  onPlayerChange?: ((art: ArtplayerType | null) => void) | undefined;
}

export function MediaryPlayerCore({
  url,
  fallbackUrl,
  title,
  subtitles,
  poster,
  autoPlay = true,
  onEnded,
  onPlayerChange,
}: MediaryPlayerCoreProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ArtplayerType | null>(null);
  const gainPipelineRef = useRef<AudioGainPipeline | null>(null);
  const [currentUrl, setCurrentUrl] = useState(url);

  // 用 ref 持有最新值，避免 settings / error 回调捕获首次渲染的过期闭包
  // （旧实现 effect 依赖数组缺 gainLevel / isUsingFallback / fallbackUrl）。
  const latestRef = useRef({ fallbackUrl, currentUrl, isUsingFallback: false });
  const onPlayerChangeRef = useRef(onPlayerChange);
  const onEndedRef = useRef(onEnded);
  const subtitlesRef = useRef(subtitles);
  latestRef.current.fallbackUrl = fallbackUrl;
  latestRef.current.currentUrl = currentUrl;
  onPlayerChangeRef.current = onPlayerChange;
  onEndedRef.current = onEnded;
  subtitlesRef.current = subtitles;

  useEffect(() => {
    setCurrentUrl(url);
    latestRef.current.isUsingFallback = url === fallbackUrl;
  }, [url, fallbackUrl]);

  useEffect(() => {
    let art: ArtplayerType | null = null;
    let isDisposed = false;
    const firstFrameTimer = startPlaybackTimer();

    async function initPlayer() {
      if (!containerRef.current) return;
      const ArtplayerModule = await import("artplayer");
      const Artplayer = ArtplayerModule.default;

      if (isDisposed || !containerRef.current) return;

      const currentSubtitles = subtitlesRef.current;
      const defaultSub = currentSubtitles && currentSubtitles.length > 0 ? currentSubtitles[0] : null;

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
        ...(defaultSub?.url
          ? {
              subtitle: {
                url: defaultSub.url,
                type: (defaultSub.format === "ass" ? "ass" : "vtt") as "ass" | "vtt",
                style: {
                  color: "#ffffff",
                  fontSize: "22px",
                  textShadow: "0 0 4px #000, 0 0 8px #000",
                },
                encoding: "utf-8",
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
              // 只作用于 video 层：容器恒为 100%，控制条才能始终贴底。
              art.video.style.objectFit = String(item.value);
              return String(item.html ?? "");
            },
          },
        ],
      });

      playerRef.current = art;
      onPlayerChangeRef.current?.(art);

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

      // 播放链路耗时埋点（默认静默，localStorage 开启后输出到控制台）
      art.on("video:loadeddata", () => {
        reportPlaybackMetric("T_first_frame", firstFrameTimer(), {
          delivery: latestRef.current.isUsingFallback ? "proxy" : "direct",
        });
      });
      art.on("video:waiting", () => {
        reportPlaybackMetric("rebuffer", 0, { at: art?.currentTime ?? 0 });
      });
      art.on("seeking", () => {
        reportPlaybackMetric("T_seek", 0, { at: art?.currentTime ?? 0 });
      });
      art.on("video:ended", () => onEndedRef.current?.());

      // 错误自愈：403 / CORS 时降级为代理流，同样只走 switchUrl 单一路径。
      art.on("error", (error) => {
        console.warn("[MediaryPlayer] 播放遇到异常:", error);
        const { fallbackUrl: fallback, currentUrl: active } = latestRef.current;
        if (fallback && !latestRef.current.isUsingFallback && active !== fallback) {
          console.info("[MediaryPlayer] 尝试切换为代理播放流自愈降级...");
          latestRef.current.isUsingFallback = true;
          reportPlaybackMetric("stream_switch", 0, { reason: "playback_error" });
          void art?.switchUrl(fallback).catch(() => {});
          void Promise.resolve(art?.play()).catch(() => {});
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

    void initPlayer();

    return () => {
      isDisposed = true;
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      onPlayerChangeRef.current?.(null);
      gainPipelineRef.current?.detach();
      gainPipelineRef.current = null;
      if (playerRef.current) {
        try {
          playerRef.current.destroy(false);
        } catch {}
        playerRef.current = null;
      }
    };
  }, [currentUrl, title, poster, autoPlay]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "420px",
        background: "#000",
        borderRadius: "8px",
        overflow: "hidden",
      }}
    />
  );
}
