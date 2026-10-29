"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../lib/use-router";
import { buildGuangYaQrContent } from "../lib/guangya-qr-content";

type Session = { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number };

function qrContent(session: Session): string {
  return buildGuangYaQrContent({ verificationUrl: session.verificationUrl, userCode: session.userCode });
}
type Phase = "idle" | "loading" | "waiting" | "done" | "expired" | "error";

const API = "/api/guangya/qrcode";

function buttonIcon(phase: Phase) {
  if (phase === "loading") return <LoaderCircle size={14} className="spin" aria-hidden />;
  if (phase === "waiting" || phase === "expired") return <RefreshCw size={14} aria-hidden />;
  return <QrCode size={14} aria-hidden />;
}

export function GuangYaQrConnect() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string>("");
  const generation = useRef(0);

  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, []);

  async function start() {
    const myGen = ++generation.current;
    setPhase("loading");
    setMessage("");
    try {
      const res = await fetch(API, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string } & Partial<Session>;
      if (!data.ok || !data.deviceCode || !data.userCode || !data.verificationUrl) {
        throw new Error(data.error ?? "无法获取二维码");
      }
      if (generation.current !== myGen) return;
      const next: Session = {
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        expiresIn: data.expiresIn ?? 120,
        interval: data.interval ?? 2,
      };
      setSession(next);
      setPhase("waiting");
      await pollLoop(next, myGen);
    } catch (error) {
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function pollLoop(s: Session, myGen: number) {
    const deadline = Date.now() + (s.expiresIn + 5) * 1000;
    const waitMs = Math.max(1, s.interval) * 1000;
    while (Date.now() < deadline && generation.current === myGen) {
      await new Promise((r) => setTimeout(r, waitMs));
      if (generation.current !== myGen) return;

      let status = "pending";
      let error: string | undefined;
      try {
        const res = await fetch(`${API}/status?deviceCode=${encodeURIComponent(s.deviceCode)}`);
        const data = (await res.json()) as { ok: boolean; status?: string; error?: string };
        if (data.ok && data.status) {
          status = data.status;
        } else if (!data.ok) {
          error = data.error || "登录失败，请重新生成二维码";
        }
      } catch {
        // network blip
      }
      if (generation.current !== myGen) return;

      if (error) {
        setPhase("error");
        setMessage(error);
        return;
      }
      if (status === "expired") {
        setPhase("expired");
        setMessage("二维码已过期，请重新生成。");
        return;
      }
      if (status === "confirmed") {
        setPhase("done");
        setMessage("光鸭云盘已连接。");
        router.refresh();
        return;
      }
    }
    if (generation.current === myGen) {
      setPhase("expired");
      setMessage("等待超时，请重新生成二维码。");
    }
  }

  return (
    <div className="qr-connect">
      <div className="qr-connect-controls">
        <button
          className="primary-button"
          type="button"
          onClick={start}
          disabled={phase === "loading"}
        >
          {buttonIcon(phase)}
          {phase === "idle" || phase === "done" ? "生成二维码" : "重新生成"}
        </button>
      </div>
      <p className="qr-hint">
        用光鸭 App 扫码登录；token 持久化到数据库，过期时自动续期（续期后自动保存）。
      </p>
      {session && phase === "waiting" ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${API}/image?content=${encodeURIComponent(qrContent(session))}`}
            alt="光鸭云盘登录二维码"
          />
          <span className={`qr-status ${phase}`}>用光鸭 App 扫码</span>
        </div>
      ) : null}
      {message ? (
        <p className="panel-note" style={{ marginTop: "var(--mt-space-2, 8px)" }}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
