/**
 * ProxyByCF FRP 隧道全双工长连接客户端引擎
 * 
 * 核心特性：
 * 1. 零平台依赖：纯 Node.js 原生运行，仅需 ServerUrl / TunnelHost / Key；
 * 2. 流生命周期协同：HTTP_ABORT 信令与 AbortController 即时级联中断；
 * 3. 滑动窗口背压流控：4MB~16MB BDP 动态额度 + HTTP_ACK 驱动消费；
 * 4. ActiveMediaStreams 智能抢占与 302 虚拟子路由拦截改写；
 * 5. 多线路故障转移 (Failover) 与自愈重连状态机。
 * 
 * 对标参考：
 * - ProxyByCF (tools/frp/lib/tunnel-client.mjs)
 * - LinuxWebTool (FrpTunnelEngine.cs)
 */

import { MediaStreamCoordinator } from "./media-stream-coordinator.js";
import {
  isAllowedLanTarget,
  isSinglePacketDispatch,
  parseVirtualLanRoute,
  rewriteLanLocationToVirtualRoute,
  sanitizeHeaders,
  TunnelFrameSerializer,
} from "./tunnel-frame-serializer.js";
import type {
  AnyTunnelFrame,
  FrpTunnelLineEntity,
  FrpTunnelLineState,
  FrpTunnelLineStatus,
  FrpTunnelLogItem,
  TunnelRequestFrame,
} from "./tunnel-protocol.js";

const INITIAL_CREDIT_BYTES = 4 * 1024 * 1024; // 4MB 初始背压额度
const FAST_START_BURST_BYTES = 16 * 1024 * 1024; // 16MB 起播突发保护

interface InFlightSession {
  readonly requestId: string;
  readonly abortController: AbortController;
  credit: number;
  totalSent: number;
  ackResolver?: (() => void) | null;
}

export class FrpTunnelClient {
  private _state: FrpTunnelLineState = "Disconnected";
  private _ws: any = null;
  private _isStopped = true;
  private _activeCts: AbortController | null = null;
  private _connectedAt: string | null = null;
  private _sentBytes = 0;
  private _receivedBytes = 0;
  private _lastError: string | null = null;
  private _publicUrl: string | null = null;

  private readonly _logs: FrpTunnelLogItem[] = [];
  private readonly _coordinator = new MediaStreamCoordinator();
  private readonly _inFlight = new Map<string, InFlightSession>();

  constructor(public readonly config: FrpTunnelLineEntity) {}

  public getStatus(): FrpTunnelLineStatus {
    return {
      id: this.config.id,
      state: this._state,
      publicUrl: this._publicUrl,
      connectedAt: this._connectedAt,
      sentBytes: this._sentBytes,
      receivedBytes: this._receivedBytes,
      lastError: this._lastError,
      recentLogs: [...this._logs],
    };
  }

  public getLogs(): FrpTunnelLogItem[] {
    return [...this._logs];
  }

  public addLog(level: "INFO" | "WARN" | "ERROR", message: string): void {
    const item: FrpTunnelLogItem = {
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    this._logs.push(item);
    if (this._logs.length > 100) {
      this._logs.shift();
    }
  }

  public async start(): Promise<void> {
    if (!this._isStopped) return;
    this._isStopped = false;
    this._activeCts = new AbortController();
    this._runLoop(this._activeCts.signal).catch((err) => {
      this._lastError = err instanceof Error ? err.message : String(err);
      this.addLog("ERROR", `隧道主循环异常退出: ${this._lastError}`);
    });
  }

  public async stop(): Promise<void> {
    this._isStopped = true;
    this._state = "Stopped";
    this._activeCts?.abort();
    if (this._ws) {
      try {
        this._ws.close(1000, "Normal closure");
      } catch {}
      this._ws = null;
    }
    this._coordinator.clear();
    this.addLog("INFO", "穿透隧道客户端已手动停止");
  }

  /**
   * 构建 WebSocket 连接 URI
   */
  public buildConnectUri(baseUrl: string, host: string, apiKey?: string): string {
    let clean = baseUrl.trim();
    if (!clean.startsWith("http://") && !clean.startsWith("https://") && !clean.startsWith("ws://") && !clean.startsWith("wss://")) {
      clean = "https://" + clean;
    }
    const url = new URL(clean);
    const protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
    url.protocol = protocol;

    // 拼装 /tunnel/connect 路由
    let pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname.endsWith("/tunnel/connect")) {
      pathname = `${pathname}/tunnel/connect`;
    }
    url.pathname = pathname;
    url.searchParams.set("host", host.trim().toLowerCase());
    if (apiKey?.trim()) {
      url.searchParams.set("token", apiKey.trim());
    }
    return url.toString();
  }

  /**
   * 主重连调度循环
   */
  private async _runLoop(signal: AbortSignal): Promise<void> {
    let currentDelayMs = 1500;
    const maxDelayMs = 30000;

    const targetServers = [
      this.config.serverUrl,
      ...(this.config.backupServerUrls || []),
    ].filter(Boolean);

    let serverIndex = 0;

    while (!signal.aborted && !this._isStopped) {
      const activeServerUrl = targetServers[serverIndex % targetServers.length] || this.config.serverUrl;
      const wsUrl = this.buildConnectUri(activeServerUrl, this.config.tunnelHost, this.config.apiKey);

      try {
        this._state = "Connecting";
        this.addLog("INFO", `正在建立全双工反向穿透长连接: ${activeServerUrl} (Host: ${this.config.tunnelHost})`);

        // 使用 Node.js 全局 WebSocket 或动态加载 ws
        const WebSocketImpl = (globalThis as any).WebSocket;
        if (!WebSocketImpl) {
          throw new Error("当前运行时未找到全局 WebSocket 支持，请确认 Node.js >= 22");
        }

        const ws = new WebSocketImpl(wsUrl, {
          headers: this.config.apiKey ? { "x-pyw-token": this.config.apiKey.trim() } : {},
        });

        await new Promise<void>((resolve, reject) => {
          const onOpen = () => {
            cleanup();
            resolve();
          };
          const onError = (e: any) => {
            cleanup();
            reject(new Error(e?.message || "WebSocket 连接失败"));
          };
          const cleanup = () => {
            ws.removeEventListener("open", onOpen);
            ws.removeEventListener("error", onError);
          };
          ws.addEventListener("open", onOpen);
          ws.addEventListener("error", onError);
        });

        this._ws = ws;
        this._state = "Connected";
        this._connectedAt = new Date().toISOString();
        this._lastError = null;
        currentDelayMs = 1500; // 重置退避延迟
        this._publicUrl = this._computePublicUrl(activeServerUrl, this.config.tunnelHost);
        this.addLog("INFO", `反向穿透长连接建立成功！公网入口: ${this._publicUrl || activeServerUrl}`);

        // 监听并维持消息循环
        await this._handleSession(ws, signal);
      } catch (error) {
        if (this._isStopped) break;
        const msg = error instanceof Error ? error.message : String(error);
        this._lastError = msg;
        this._state = "Reconnecting";
        this.addLog("WARN", `连接断开或异常 (${msg})，将在 ${(currentDelayMs / 1000).toFixed(1)} 秒后尝试故障转移重连...`);

        // 轮换到下一个候选服务器 (Failover)
        serverIndex++;

        // Full Jitter 状态机退避策略：在 0 到 currentDelayMs 之间引入均匀随机抖动，彻底消除穿透服务端的雷群冲击
        const sleepMs = Math.floor(Math.random() * currentDelayMs);
        await new Promise((r) => setTimeout(r, sleepMs));
        currentDelayMs = Math.min(currentDelayMs * 1.5, maxDelayMs);
      }
    }
  }

  /**
   * 维持 WebSocket 会话生命周期与心跳
   */
  private async _handleSession(ws: any, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let heartbeatTimer: any = null;

      const stopHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      };

      const startHeartbeat = () => {
        const intervalMs = (this.config.heartbeatIntervalSec || 15) * 1000;
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ type: "PING", timestamp: Date.now() }));
            } catch {}
          }
        }, intervalMs);
      };

      startHeartbeat();

      const onMessage = (event: any) => {
        const rawData = typeof event.data === "string" ? event.data : event.data?.toString();
        if (!rawData) return;
        this._receivedBytes += rawData.length;
        const frame = TunnelFrameSerializer.deserialize(rawData);
        if (frame) {
          this._dispatchFrame(frame, ws, signal);
        }
      };

      const onClose = () => {
        stopHeartbeat();
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        resolve();
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
    });
  }

  /**
   * 消息分发中枢
   */
  private _dispatchFrame(frame: AnyTunnelFrame, ws: any, signal: AbortSignal): void {
    switch (frame.type) {
      case "HTTP_REQUEST":
        void this._forwardHttpRequest(frame, ws, signal);
        break;

      case "HTTP_ABORT": {
        const reqId = frame.requestId;
        const session = this._inFlight.get(reqId);
        if (session) {
          session.abortController.abort(new Error("访客取消或进度条拖拽中断"));
          this._inFlight.delete(reqId);
          this.addLog("INFO", `>> [HTTP_ABORT] 收到中断信令，即时释放本地连接: ${reqId}`);
        }
        this._coordinator.abortStream(reqId, "HTTP_ABORT received");
        break;
      }

      case "HTTP_ACK": {
        const session = this._inFlight.get(frame.requestId);
        if (session) {
          session.credit += frame.bytes;
          if (session.ackResolver) {
            session.ackResolver();
            session.ackResolver = null;
          }
        }
        break;
      }

      case "PONG":
        // 收到心跳响应，保持存活
        break;
    }
  }

  /**
   * 执行本地请求转发与流媒体协议加速
   */
  private _buildTargetUrl(path: string): string {
    const virtualLan = parseVirtualLanRoute(path);
    if (virtualLan.isVirtualLan && virtualLan.internalUrl) {
      return virtualLan.internalUrl;
    }
    const base = this.config.localTargetUrl.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private _apply302Rewriting(
    location: string | null,
    statusCode: number,
    resHeaders: Record<string, string>,
  ): void {
    if (location && statusCode >= 300 && statusCode <= 308 && this.config.enableLan302Proxy) {
      const rewritten = rewriteLanLocationToVirtualRoute(location, this.config.tunnelHost);
      if (rewritten.rewritten) {
        resHeaders["location"] = rewritten.location;
        this.addLog("INFO", `>> [302改写] 拦截内网重定向，改写为公网虚拟路由: ${rewritten.location}`);
      }
    }
  }

  private async _dispatchSinglePacket(
    res: Response,
    requestId: string,
    statusCode: number,
    method: string,
    resHeaders: Record<string, string>,
    ws: any,
  ): Promise<void> {
    let bodyPayload: string | null = null;
    if (statusCode !== 204 && statusCode !== 304 && method !== "HEAD") {
      const ab = await res.arrayBuffer();
      if (ab.byteLength > 0) {
        bodyPayload = Buffer.from(ab).toString("base64");
      }
    }

    const respFrame = TunnelFrameSerializer.serializeHttpResponse(
      requestId,
      statusCode,
      resHeaders,
      bodyPayload,
    );
    this._sendFrame(respFrame, ws);
  }

  private async _streamResponse(
    res: Response,
    requestId: string,
    session: InFlightSession,
    reqCts: AbortController,
    signal: AbortSignal,
    ws: any,
  ): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    try {
      while (!reqCts.signal.aborted && !signal.aborted) {
        if (session.totalSent > FAST_START_BURST_BYTES && session.credit <= 0) {
          await Promise.race([
            new Promise<void>((r) => {
              session.ackResolver = r;
            }),
            new Promise<void>((r) => setTimeout(r, 250)),
          ]);
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (value && value.byteLength > 0) {
          session.credit -= value.byteLength;
          session.totalSent += value.byteLength;
          const chunkFrame = TunnelFrameSerializer.serializeStreamChunk(requestId, value);
          this._sendFrame(chunkFrame, ws);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private _checkAndPreemptStream(
    requestId: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    reqCts: AbortController,
  ): void {
    const scope = this._coordinator.extractSessionScope(headers);
    const rangeHeader = headers["range"] || headers["Range"];
    const isProbe = this._coordinator.isBoundedRangeProbe(rangeHeader);

    if (!isProbe && method === "GET") {
      const preempted = this._coordinator.registerOrPreempt(requestId, scope, path, reqCts);
      if (preempted) {
        this.addLog("INFO", `>> [寻轨抢占] 设备 ${scope} 拖拽进度条，抢占并终止旧流: ${preempted}`);
      }
    }
  }

  private _createFetchOptions(
    method: string,
    headers: Record<string, string>,
    bodyBase64: string | null | undefined,
    reqCts: AbortController,
  ): RequestInit {
    const reqHeaders = { ...headers };
    delete reqHeaders["host"];
    delete reqHeaders["connection"];

    const fetchOptions: RequestInit = {
      method,
      headers: reqHeaders,
      redirect: "manual",
      signal: reqCts.signal,
    };

    if (bodyBase64 && method !== "GET" && method !== "HEAD") {
      fetchOptions.body = Buffer.from(bodyBase64, "base64");
    }

    return fetchOptions;
  }

  private _handleForwardError(
    err: unknown,
    requestId: string,
    method: string,
    path: string,
    reqCts: AbortController,
    signal: AbortSignal,
    ws: any,
  ): void {
    if (reqCts.signal.aborted || signal.aborted) {
      try {
        const abortFrame = TunnelFrameSerializer.serializeAbort(requestId);
        this._sendFrame(abortFrame, ws);
      } catch {}
      return;
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    this.addLog("WARN", `转发本地请求失败 [${method} ${path}]: ${errMsg}`);
    const errFrame = TunnelFrameSerializer.serializeHttpResponse(
      requestId,
      502,
      { "content-type": "application/json; charset=utf-8" },
      Buffer.from(JSON.stringify({ error: `Bad Gateway: ${errMsg}` })).toString("base64"),
    );
    this._sendFrame(errFrame, ws);
  }

  /**
   * 执行本地请求转发与流媒体协议加速
   */
  private async _forwardHttpRequest(
    frame: TunnelRequestFrame,
    ws: any,
    signal: AbortSignal,
  ): Promise<void> {
    const { requestId, method, path, headers, bodyBase64 } = frame;
    const reqCts = new AbortController();

    const session: InFlightSession = {
      requestId,
      abortController: reqCts,
      credit: INITIAL_CREDIT_BYTES,
      totalSent: 0,
    };
    this._inFlight.set(requestId, session);

    this._checkAndPreemptStream(requestId, headers, method, path, reqCts);

    try {
      const targetUrl = this._buildTargetUrl(path);
      const fetchOptions = this._createFetchOptions(method, headers, bodyBase64, reqCts);
      const res = await fetch(targetUrl, fetchOptions);
      const statusCode = res.status;

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });

      this._apply302Rewriting(res.headers.get("location"), statusCode, resHeaders);

      const contentLengthStr = res.headers.get("content-length");
      const contentLength = contentLengthStr ? Number(contentLengthStr) : null;

      if (isSinglePacketDispatch(statusCode, method, contentLength)) {
        await this._dispatchSinglePacket(res, requestId, statusCode, method, resHeaders, ws);
        return;
      }

      const startFrame = TunnelFrameSerializer.serializeStreamStart(requestId, statusCode, resHeaders);
      this._sendFrame(startFrame, ws);

      await this._streamResponse(res, requestId, session, reqCts, signal, ws);

      const endFrame = TunnelFrameSerializer.serializeStreamEnd(requestId);
      this._sendFrame(endFrame, ws);
    } catch (err: unknown) {
      this._handleForwardError(err, requestId, method, path, reqCts, signal, ws);
    } finally {
      this._inFlight.delete(requestId);
      this._coordinator.removeStream(requestId);
    }
  }

  private _sendFrame(dataStr: string, ws: any): void {
    if (ws && ws.readyState === 1) {
      this._sentBytes += dataStr.length;
      ws.send(dataStr);
    }
  }

  private _computePublicUrl(serverUrl: string, tunnelHost: string): string | null {
    try {
      const url = new URL(serverUrl.startsWith("http") ? serverUrl : `https://${serverUrl}`);
      const scheme = url.protocol.startsWith("http") ? url.protocol : "https:";
      const host = url.hostname;
      const parts = host.split(".");
      if (parts.length >= 2) {
        const domain = parts.slice(-2).join(".");
        return `${scheme}//${tunnelHost}.${domain}${url.port ? `:${url.port}` : ""}/`;
      }
      return `${scheme}//${tunnelHost}.${host}/`;
    } catch {
      return null;
    }
  }
}
