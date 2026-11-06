"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../../../lib/use-router";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import {
  savePanSouConfigAction,
} from "../../../app/actions/settings-pansou-actions";
import type { PanSouConfigSaveMode } from "../contracts/pansou-config";
import { runAction } from "../../../lib/run-action";

/** 已保存的凭据状态，只用于决定输入框是「显示占位符」还是「显示已保存」——
 *  绝不在客户端渲染里回显密码或令牌本身。 */
export interface PanSouCredentialsState {
  username: string;
  /** 是否已保存一个密码（值为真与否，不是值本身）。 */
  hasPassword: boolean;
  /** 是否已保存一个令牌。 */
  hasToken: boolean;
}

function sourceLabel(source: "database" | "environment" | "default"): string {
  const labels = {
    database: "数据库地址覆盖",
    environment: "环境变量",
    default: "公共默认实例",
  };
  return labels[source];
}

function saveResultMessage(
  mode: PanSouConfigSaveMode,
  success: boolean,
  message?: string,
): string {
  if (!success) return `❌ ${message ?? "保存失败"}`;
  if (mode === "credentials") return "✅ 当前生效地址的认证已验证并保存";
  if (mode === "clear") return "✅ 已恢复环境变量 / 默认地址，并清除旧源凭据";
  return "✅ 地址与认证已验证并保存";
}

export function PanSouConfigForm({
  baseURL: initialBaseURL,
  source,
  credentials,
}: {
  baseURL: string;
  source: "database" | "environment" | "default";
  credentials?: PanSouCredentialsState;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [baseURL, setBaseURL] = useState(initialBaseURL);
  // 密码/令牌默认留空：它们只在保存时提交，界面上不预填（预填等于把秘密
  // 放进 DOM 和浏览器自动填充的射程里）。
  const [username, setUsername] = useState(credentials?.username ?? "");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const handleSave = (mode: PanSouConfigSaveMode) => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () =>
          savePanSouConfigAction(baseURL, {
            username,
            password,
            token,
          }, mode),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(saveResultMessage(mode, res.success, res.message));
      if (res.success) {
        // 保存成功后把密码/令牌输入框清掉：留着已提交的秘密没有意义，
        // 还会让「已保存」与「框里还有一个值」两种状态混淆。
        setPassword("");
        setToken("");
        if (mode === "clear") {
          setBaseURL("");
          setUsername("");
        }
        router.refresh();
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">服务地址（网盘搜索源）</label>
        <div className="setting-row">
          <input
            type="text"
            className="setting-control"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="形如 http://host:port"
            aria-label="PanSou Base URL"
          />
        </div>
        <p className="panel-note">
          当前生效来源：{sourceLabel(source)}。
          保存地址会创建数据库覆盖；保存认证只作用于当前生效地址。
        </p>
        <div className="setting-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="primary-button"
            onClick={() => handleSave("override")}
            disabled={isPending || !baseURL.trim()}
          >
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            保存地址覆盖
          </button>
          {source === "database" ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => handleSave("clear")}
              disabled={isPending}
            >
              {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
              恢复环境 / 默认
            </button>
          ) : null}
        </div>
      </div>
      <div className="push-field">
        <label className="push-label">
          认证凭据（选填）
          <span className="panel-note" style={{ marginLeft: 6, fontWeight: 400 }}>
            仅当你这台搜索源开启了认证时才需要
          </span>
        </label>
        <div className="setting-row">
          <input
            type="text"
            className="setting-control"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={credentials?.username ? `已保存：${credentials.username}` : "用户名"}
            aria-label="PanSou 用户名"
          />
          <input
            type="password"
            className="setting-control"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={credentials?.hasPassword ? "已保存，输入可替换" : "密码"}
            aria-label="PanSou 密码"
          />
        </div>
        <div className="setting-row">
          <input
            type="password"
            className="setting-control"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={credentials?.hasToken ? "已保存，输入可替换" : "或直接粘贴 JWT 令牌"}
            aria-label="PanSou 令牌"
          />
        </div>
        <p className="panel-note">
          用户名密码与令牌二选一即可；两者都填时以令牌为准。密码与令牌加密后存入本机数据库，不会发送到除该搜索源以外的任何地方。
        </p>
        <div className="setting-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={() => handleSave("credentials")}
            disabled={isPending}
          >
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            仅验证并保存认证
          </button>
        </div>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
