import { describe, expect, it } from "vitest";
import { MediaStreamCoordinator } from "./media-stream-coordinator.js";
import {
  isAllowedLanTarget,
  isSinglePacketDispatch,
  parseVirtualLanRoute,
  rewriteLanLocationToVirtualRoute,
  sanitizeHeaders,
  TunnelFrameSerializer,
} from "./tunnel-frame-serializer.js";
import { FrpTunnelClient } from "./frp-tunnel-client.js";
import { FrpTunnelManager, InMemoryFrpTunnelStorage } from "./tunnel-store.js";
import type { FrpTunnelLineEntity, TunnelRequestFrame, TunnelResponseFrame } from "./tunnel-protocol.js";

describe("ProxyByCF FRP 穿透协议与流媒体协同单元测试", () => {
  describe("1. ByteString 安全标头与单包直发判定", () => {
    it("自动对包含中文字符的标头执行 URL 安全编码 (防 DO 抛 TypeError 挂起)", () => {
      const headers = {
        "content-type": "application/json",
        location: "/video/孤独摇滚_第01话.mp4",
        "content-disposition": "attachment; filename=中文字幕.srt",
      };

      const sanitized = sanitizeHeaders(headers);
      expect(sanitized["content-type"]).toBe("application/json");
      expect(sanitized["location"]).toBe("/video/%E5%AD%A4%E7%8B%AC%E6%91%87%E6%BB%9A_%E7%AC%AC01%E8%AF%9D.mp4");
      expect(sanitized["content-disposition"]).toContain("%");
    });

    it("单包极速直发白名单判定 (3xx, 204, HEAD, <= 1MB)", () => {
      expect(isSinglePacketDispatch(302, "GET", null)).toBe(true);
      expect(isSinglePacketDispatch(301, "GET", null)).toBe(true);
      expect(isSinglePacketDispatch(204, "POST", null)).toBe(true);
      expect(isSinglePacketDispatch(200, "HEAD", null)).toBe(true);
      expect(isSinglePacketDispatch(200, "GET", 500 * 1024)).toBe(true); // 500KB 小文件
      expect(isSinglePacketDispatch(200, "GET", 50 * 1024 * 1024)).toBe(false); // 50MB 大文件走流式
    });
  });

  describe("2. 302 虚拟子路由拦截改写与 SSRF 防护", () => {
    it("白名单局域网目标放行，敏感黑名单端口严格拦截", () => {
      expect(isAllowedLanTarget("192.168.1.60", 5244)).toBe(true); // AList
      expect(isAllowedLanTarget("10.0.0.5", 32400)).toBe(true); // Plex
      expect(isAllowedLanTarget("172.16.0.2", 8096)).toBe(true); // Emby
      expect(isAllowedLanTarget("127.0.0.1", 3000)).toBe(true); // Localhost

      // 危险/敏感端口严格拦截
      expect(isAllowedLanTarget("192.168.1.1", 80)).toBe(false); // 路由器管理端口
      expect(isAllowedLanTarget("192.168.1.60", 22)).toBe(false); // SSH 端口
      expect(isAllowedLanTarget("192.168.1.60", 445)).toBe(false); // SMB 端口
      expect(isAllowedLanTarget("192.168.1.60", 3306)).toBe(false); // MySQL
      expect(isAllowedLanTarget("8.8.8.8", 5244)).toBe(false); // 公网非私有 IP
    });

    it("拦截内网 302 重定向并改写为虚拟路由 (实现公网直链 0 本地上传)", () => {
      const rawLocation = "http://192.168.1.60:5211/api/strm/play/movie.mkv?token=xyz";
      const result = rewriteLanLocationToVirtualRoute(rawLocation, "scout-home");

      expect(result.rewritten).toBe(true);
      expect(result.location).toBe(
        "/tunnel/scout-home/__lan/192.168.1.60_5211/api/strm/play/movie.mkv?token=xyz",
      );
    });

    it("正确解析并还原公网虚拟子路由请求", () => {
      const path = "/tunnel/scout-home/__lan/192.168.1.60_5211/api/strm/play/movie.mkv?token=xyz";
      const parsed = parseVirtualLanRoute(path);

      expect(parsed.isVirtualLan).toBe(true);
      expect(parsed.internalUrl).toBe("http://192.168.1.60:5211/api/strm/play/movie.mkv?token=xyz");
    });
  });

  describe("3. MediaStreamCoordinator 会话隔离与寻轨抢占", () => {
    it("会话提取严格遵循优先级 (Device > Token > Session > IP)", () => {
      const coord = new MediaStreamCoordinator();

      // 设备优先
      expect(
        coord.extractSessionScope({
          "x-plex-client-identifier": "client_abc",
          authorization: "Bearer secret",
        }),
      ).toBe("device:client_abc");

      // Token 优先于 IP
      expect(
        coord.extractSessionScope({
          "x-plex-token": "token_1234567890abcdef",
          "cf-connecting-ip": "1.2.3.4",
        }),
      ).toBe("token:1234567890abcdef");

      // IP 兜底
      expect(
        coord.extractSessionScope({
          "cf-connecting-ip": "114.114.114.114",
        }),
      ).toBe("ip:114.114.114.114");
    });

    it("识别 RFC 9110 后缀 Range 探针 (bytes=-524288) 绝不误杀主视频流", () => {
      const coord = new MediaStreamCoordinator();

      expect(coord.isBoundedRangeProbe("bytes=-524288")).toBe(true); // 512KB MP4 moov 探测
      expect(coord.isBoundedRangeProbe("bytes=0-1048575")).toBe(true); // 1MB 初始探测
      expect(coord.isBoundedRangeProbe("bytes=5000000-")).toBe(false); // 用户拖拽跳转的大流
      expect(coord.isBoundedRangeProbe("")).toBe(false);
    });

    it("用户拖拽进度条时同会话同资源立即抢占取消前序旧流", () => {
      const coord = new MediaStreamCoordinator();
      const scope = "device:iphone_16";
      const resource = "/video/4k.mkv";

      const oldCts = new AbortController();
      coord.registerOrPreempt("req_old", scope, resource, oldCts);
      expect(oldCts.signal.aborted).toBe(false);

      // 用户拖拽进度条，发起新的 Range 请求
      const newCts = new AbortController();
      const preempted = coord.registerOrPreempt("req_new", scope, resource, newCts);

      expect(preempted).toBe("req_old");
      expect(oldCts.signal.aborted).toBe(true); // 旧流已被即刻中止
      expect(newCts.signal.aborted).toBe(false); // 新流正常执行
    });
  });

  describe("4. 协议帧序列化与反序列化", () => {
    it("正确序列化与反序列化 HTTP_REQUEST 与 HTTP_RESPONSE 报文", () => {
      const req: TunnelRequestFrame = {
        type: "HTTP_REQUEST",
        requestId: "req_101",
        method: "GET",
        path: "/api/health",
        headers: { host: "scout.domain.com" },
      };

      const jsonStr = TunnelFrameSerializer.serialize(req);
      const deserialized = TunnelFrameSerializer.deserialize(jsonStr);

      expect(deserialized?.type).toBe("HTTP_REQUEST");
      expect((deserialized as TunnelRequestFrame).requestId).toBe("req_101");
    });

    it("正确构造单包直发 HTTP_RESPONSE 报文", () => {
      const respJson = TunnelFrameSerializer.serializeHttpResponse(
        "req_102",
        302,
        { location: "https://cdn.example.com/play" },
      );
      const obj = JSON.parse(respJson) as TunnelResponseFrame;
      expect(obj.type).toBe("HTTP_RESPONSE");
      expect(obj.statusCode).toBe(302);
      expect(obj.headers["location"]).toBe("https://cdn.example.com/play");
    });
  });

  describe("5. FrpTunnelManager 多线路中枢调度", () => {
    it("支持线路增删改查与状态感知", async () => {
      const storage = new InMemoryFrpTunnelStorage();
      const manager = new FrpTunnelManager(storage);

      const line: FrpTunnelLineEntity = {
        id: "line_01",
        name: "主线路-CF",
        serverUrl: "https://proxy.example.com",
        tunnelHost: "scout-test",
        apiKey: "test_key",
        localTargetUrl: "http://127.0.0.1:3000",
        autoStart: false,
        heartbeatIntervalSec: 15,
        enableLan302Proxy: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await manager.saveLine(line);
      const list = await manager.listLines();
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe("line_01");

      const fetched = await manager.getLine("line_01");
      expect(fetched?.tunnelHost).toBe("scout-test");

      const deleted = await manager.deleteLine("line_01");
      expect(deleted).toBe(true);
      expect((await manager.listLines()).length).toBe(0);
    });

    it("客户端可正确构造带 Host 与 Token 的 WebSocket 连接 URI", () => {
      const client = new FrpTunnelClient({
        id: "l1",
        name: "test",
        serverUrl: "https://gateway.example.com/my-prefix",
        tunnelHost: "myscout",
        apiKey: "sec123",
        localTargetUrl: "http://127.0.0.1:3000",
        autoStart: false,
        heartbeatIntervalSec: 15,
        enableLan302Proxy: true,
        createdAt: "",
        updatedAt: "",
      });

      const uri = client.buildConnectUri("https://gateway.example.com", "myscout", "sec123");
      expect(uri).toContain("wss://gateway.example.com/tunnel/connect");
      expect(uri).toContain("host=myscout");
      expect(uri).toContain("token=sec123");
    });
  });
});
