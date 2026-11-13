import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioGainPipeline } from "./audio-gain-pipeline";

describe("AudioGainPipeline (跨域防静音惰性挂载测试)", () => {
  let mockSourceNode: any;
  let mockGainNode: any;
  let mockCompressorNode: any;
  let mockAudioCtx: any;
  let mockVideo: HTMLMediaElement;

  beforeEach(() => {
    mockSourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    mockGainNode = {
      gain: {
        value: 1.0,
        setValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    mockCompressorNode = {
      threshold: { setValueAtTime: vi.fn() },
      knee: { setValueAtTime: vi.fn() },
      ratio: { setValueAtTime: vi.fn() },
      attack: { setValueAtTime: vi.fn() },
      release: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    mockAudioCtx = {
      currentTime: 0,
      state: "running",
      destination: {},
      createMediaElementSource: vi.fn().mockReturnValue(mockSourceNode),
      createGain: vi.fn().mockReturnValue(mockGainNode),
      createDynamicsCompressor: vi.fn().mockReturnValue(mockCompressorNode),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (globalThis as any).AudioContext = class {
      constructor() {
        return mockAudioCtx;
      }
    };
    (globalThis as any).window = { AudioContext: (globalThis as any).AudioContext };

    mockVideo = {
      muted: false,
      volume: 1,
    } as unknown as HTMLMediaElement;
  });

  it("默认状态 (100% 增益) 严禁挂载 Web Audio，保持浏览器原生声卡直通，避免跨域静音", () => {
    const pipeline = new AudioGainPipeline();
    const attached = pipeline.attach(mockVideo);

    expect(attached).toBe(true);
    expect(pipeline.isPipelineAttached()).toBe(false);
    expect(mockAudioCtx.createMediaElementSource).not.toHaveBeenCalled();
    expect(pipeline.getGain()).toBe(1.0);
  });

  it("当增益放大至 150% (> 100%) 时，触发惰性挂载并串联 DynamicsCompressor 压限器", () => {
    const pipeline = new AudioGainPipeline();
    pipeline.attach(mockVideo);

    expect(pipeline.isPipelineAttached()).toBe(false);

    // 用户调大音量至 150%
    pipeline.setGain(1.5);

    expect(pipeline.isPipelineAttached()).toBe(true);
    expect(mockAudioCtx.createMediaElementSource).toHaveBeenCalledWith(mockVideo);
    expect(mockAudioCtx.createDynamicsCompressor).toHaveBeenCalled();
    expect(mockAudioCtx.createGain).toHaveBeenCalled();

    // 检查串联拓扑: source -> compressor -> gain -> destination
    expect(mockSourceNode.connect).toHaveBeenCalledWith(mockCompressorNode);
    expect(mockCompressorNode.connect).toHaveBeenCalledWith(mockGainNode);
    expect(mockGainNode.connect).toHaveBeenCalledWith(mockAudioCtx.destination);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(1.5, 0);
  });

  it("增益回退至 100% 时更新 Gain 节点数值，destroy/detach 清理所有 Web Audio 节点", () => {
    const pipeline = new AudioGainPipeline();
    pipeline.attach(mockVideo);
    pipeline.setGain(2.0);
    expect(pipeline.isPipelineAttached()).toBe(true);

    pipeline.setGain(1.0);
    expect(mockGainNode.gain.setValueAtTime).toHaveBeenCalledWith(1.0, 0);

    pipeline.detach();
    expect(mockSourceNode.disconnect).toHaveBeenCalled();
    expect(mockCompressorNode.disconnect).toHaveBeenCalled();
    expect(mockGainNode.disconnect).toHaveBeenCalled();
    expect(mockAudioCtx.close).toHaveBeenCalled();
    expect(pipeline.isPipelineAttached()).toBe(false);
  });
});
