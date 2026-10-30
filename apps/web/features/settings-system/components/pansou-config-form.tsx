"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../../../lib/use-router";
import { Check, LoaderCircle } from "lucide-react";
import { savePanSouConfigAction } from "../../../app/actions";
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

export function PanSouConfigForm({
  baseURL: initialBaseURL,
  credentials,
}: {
  baseURL: string;
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

  const handleSave = () => {
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
          }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) {
        // 保存成功后把密码/令牌输入框清掉：留着已提交的秘密没有意义，
        // 还会让「已保存」与「框里还有一个值」两种状态混淆。
        setPassword("");
        setToken("");
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
            placeholder="形如 http://host:port，留空用默认实例"
            aria-label="PanSou Base URL"
          />
          <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            保存
          </button>
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
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
