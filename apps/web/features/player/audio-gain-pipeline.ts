/**
 * Web Audio Gain Pipeline (音频增益放大处理器)
 *
 * 借鉴自《视频播放器优化v2》中的音频管线：
 * 1. 默认状态 (100% 音量):
 *    严禁挂载 Web Audio API 的 createMediaElementSource，避免触发 W3C 跨域无 CORS 静音陷阱 (Silence Trap)。
 *    浏览器原生硬件解码器直接直通系统声卡，享受零延迟、无失真与全格式硬件加速。
 * 2. 增强状态 (> 100% ~ 400% 音量):
 *    按需懒挂载 (Lazy Attachment) Web Audio 上下文与 DynamicsCompressorNode + GainNode，
 *    在同源代理流下提供无爆破音的高清人声对白线性放大。
 */

export class AudioGainPipeline {
  private audioCtx: AudioContext | null = null;
  private videoElement: HTMLMediaElement | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private currentGain = 1.0;
  private isAttached = false;

  /**
   * 绑定媒体元素（默认惰性模式，gain=1.0 时不建立 Web Audio 节点）
   */
  attach(videoElement: HTMLMediaElement): boolean {
    this.videoElement = videoElement;
    if (this.currentGain > 1.0) {
      return this.ensureAttached();
    }
    return true;
  }

  /**
   * 激活 Web Audio 硬件管道
   */
  ensureAttached(): boolean {
    if (this.isAttached) return true;
    if (!this.videoElement) return false;

    try {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return false;

      this.audioCtx = new AudioCtxClass();
      this.sourceNode = this.audioCtx.createMediaElementSource(this.videoElement);
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.gainNode = this.audioCtx.createGain();

      // 动态压限器参数：抑制超高增益下的爆破削顶失真，同时提亮微弱对白
      this.compressorNode.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
      this.compressorNode.knee.setValueAtTime(30, this.audioCtx.currentTime);
      this.compressorNode.ratio.setValueAtTime(12, this.audioCtx.currentTime);
      this.compressorNode.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      this.compressorNode.release.setValueAtTime(0.25, this.audioCtx.currentTime);

      this.gainNode.gain.setValueAtTime(this.currentGain, this.audioCtx.currentTime);

      // 管道串联：source -> compressor -> gain -> destination
      this.sourceNode.connect(this.compressorNode);
      this.compressorNode.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);

      this.isAttached = true;
      return true;
    } catch (err) {
      console.warn("[AudioGainPipeline] 初始化 Web Audio Gain 失败:", err);
      return false;
    }
  }

  setGain(gain: number): void {
    this.currentGain = Math.max(0.5, Math.min(4.0, gain));

    if (this.currentGain > 1.0 && !this.isAttached) {
      this.ensureAttached();
    }

    if (this.audioCtx && this.gainNode) {
      if (this.audioCtx.state === "suspended") {
        void this.audioCtx.resume();
      }
      this.gainNode.gain.setValueAtTime(this.currentGain, this.audioCtx.currentTime);
    }
  }

  getGain(): number {
    return this.currentGain;
  }

  isPipelineAttached(): boolean {
    return this.isAttached;
  }

  resume(): void {
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      void this.audioCtx.resume();
    }
  }

  detach(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }
    if (this.compressorNode) {
      try {
        this.compressorNode.disconnect();
      } catch {}
      this.compressorNode = null;
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {}
      this.gainNode = null;
    }
    if (this.audioCtx) {
      try {
        if (this.audioCtx.state !== "closed") {
          void this.audioCtx.close();
        }
      } catch {}
      this.audioCtx = null;
    }
    this.videoElement = null;
    this.isAttached = false;
  }
}
