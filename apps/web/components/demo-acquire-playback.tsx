"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { playbackStateAt, DEMO_PLAYBACK_TOTAL_MS } from "../lib/demo-playback-timeline";

/**
 * Read-only demo: a scripted, client-only playback of an agent acquisition. Drives
 * a progress bar + action ticker from the canned timeline — NO network request, no
 * DB write — so multiple visitors never collide and nothing persists.
 */
export function DemoAcquirePlayback() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const t = Date.now() - start;
      setElapsed(t);
      if (t >= DEMO_PLAYBACK_TOTAL_MS) {
        clearInterval(id);
      }
    }, 400);
    return () => clearInterval(id);
  }, []);

  const state = playbackStateAt(elapsed);
  const done = state.progress >= 100;

  return (
    <div className="demo-playback" role="status" aria-live="polite">
      <div className="demo-playback-bar">
        <div className="demo-playback-fill" style={{ width: `${state.progress}%` }} />
      </div>
      <div className="demo-playback-step">
        {done ? <Check size={14} aria-hidden /> : <LoaderCircle size={14} className="spin" aria-hidden />}
        <span>{state.label}</span>
      </div>
      {done ? <p className="demo-playback-note">演示完成 · 真实获取请自部署后使用</p> : null}
    </div>
  );
}
