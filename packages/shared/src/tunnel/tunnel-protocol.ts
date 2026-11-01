/**
 * ProxyByCF FRP 隧道全双工通信协议与报文类型定义
 * 
 * 对标参考：
 * - ProxyByCF (apps/worker/src/features/tunnel/durable-object.ts)
 * - LinuxWebTool (TunnelFrameSerializer.cs, FrpTunnelEngine.cs)
 */

export type TunnelFrameType =
  | "HTTP_REQUEST"
  | "HTTP_RESPONSE"
  | "HTTP_STREAM_START"
  | "HTTP_STREAM_CHUNK"
  | "HTTP_STREAM_END"
  | "HTTP_ABORT"
  | "HTTP_ACK"
  | "PING"
  | "PONG";

/** 外部访客打到网关后，网关下发给客户端的 HTTP 请求帧 */
export interface TunnelRequestFrame {
  readonly type: "HTTP_REQUEST";
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly bodyBase64?: string | null;
}

/** 单包极速响应帧（适用于 3xx 重定向、204/304、HEAD 或小体积响应） */
export interface TunnelResponseFrame {
  readonly type: "HTTP_RESPONSE";
  readonly requestId: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly bodyBase64?: string | null;
}

/** 流式响应起始帧 */
export interface TunnelStreamStartFrame {
  readonly type: "HTTP_STREAM_START";
  readonly requestId: string;
  readonly statusCode: number;
  readonly headers: Record<string, string>;
}

/** 流式数据分块帧 */
export interface TunnelStreamChunkFrame {
  readonly type: "HTTP_STREAM_CHUNK";
  readonly requestId: string;
  readonly chunkBase64: string;
}

/** 流式结束帧 */
export interface TunnelStreamEndFrame {
  readonly type: "HTTP_STREAM_END";
  readonly requestId: string;
}

/** 外部访客中断或拖拽寻轨信令（指示客户端立即取消内网拉流） */
export interface TunnelAbortFrame {
  readonly type: "HTTP_ABORT";
  readonly requestId: string;
}

/** 滑动窗口背压确认帧（指示下游已消费特定字节，为发送端补充信用额度） */
export interface TunnelAckFrame {
  readonly type: "HTTP_ACK";
  readonly requestId: string;
  readonly bytes: number;
}

/** 心跳帧 */
export interface TunnelPingFrame {
  readonly type: "PING";
  readonly timestamp?: number;
}

export interface TunnelPongFrame {
  readonly type: "PONG";
  readonly timestamp?: number;
}

export type AnyTunnelFrame =
  | TunnelRequestFrame
  | TunnelResponseFrame
  | TunnelStreamStartFrame
  | TunnelStreamChunkFrame
  | TunnelStreamEndFrame
  | TunnelAbortFrame
  | TunnelAckFrame
  | TunnelPingFrame
  | TunnelPongFrame;

/** 穿透线路持久化实体定义 */
export interface FrpTunnelLineEntity {
  id: string;
  name: string;
  serverUrl: string;
  backupServerUrls?: string[] | undefined;
  tunnelHost: string;
  apiKey: string;
  localTargetUrl: string;
  enabled?: boolean | undefined;
  autoStart?: boolean | undefined;
  heartbeatIntervalSec?: number | undefined;
  enableLan302Proxy?: boolean | undefined;
  allowLanStreamingOverride?: boolean | undefined;
  activeStreamsWindow?: number | undefined;
  createdAt: number | string;
  updatedAt: number | string;
}

/** 线路实时运行状态指标 */
export type FrpTunnelLineState = "Disconnected" | "Connecting" | "Connected" | "Reconnecting" | "Stopped" | "Degraded";

export interface FrpTunnelLineStatus {
  readonly id: string;
  readonly state: FrpTunnelLineState;
  readonly publicUrl: string | null;
  readonly connectedAt: string | null;
  readonly sentBytes: number;
  readonly receivedBytes: number;
  readonly lastError: string | null;
  readonly recentLogs: readonly FrpTunnelLogItem[];
}

export interface FrpTunnelLogItem {
  readonly level: "INFO" | "WARN" | "ERROR";
  readonly message: string;
  readonly timestamp: string;
}
