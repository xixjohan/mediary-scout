"use client";

import { useEffect, useState } from "react";
import { mapSavedPolicy, type PolicyDraft } from "../core/policy-draft";

/**
 * 订阅策略模板的读取/新建/更新/删除/应用。
 *
 * 这个组件此前只存在于作品详情页的「订阅策略」面板里，向导第 2 步只有下拉 +
 * 应用按钮 —— 新用户（模板库为空）进入的是一个「只能选、不能建」的死区。
 * 抽成共享组件后，向导与详情页面板都挂它，模板只有一份实现（也只有一个行为）。
 */

type PolicyTemplate = { id: string; name: string; policy: unknown };

export interface PolicyTemplateToolsProps {
  draft: PolicyDraft;
  onApply: (loaded: PolicyDraft) => void;
  /** 保存/更新前把草稿转成线上形状（由调用方提供，保证与保存路径一致）。 */
  toPolicy: (draft: PolicyDraft) => unknown;
}

async function readTemplateResponse(response: Response, fallback: string): Promise<{ template: PolicyTemplate | null; error: string }> {
  const body: unknown = await response.json().catch(() => null);
  const candidate = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["template"] : null;
  if (response.ok && typeof candidate === "object" && candidate !== null) {
    return { template: candidate as PolicyTemplate, error: "" };
  }
  const error = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["error"] : null;
  return { template: null, error: typeof error === "string" ? error : fallback };
}

export function PolicyTemplateTools({ draft, onApply, toPolicy }: PolicyTemplateToolsProps) {
  const [templates, setTemplates] = useState<PolicyTemplate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<"load" | "save" | "update" | "delete" | null>("load");
  const busy = action !== null && action !== "load";

  useEffect(() => {
    let alive = true;
    fetch("/api/titles/subscription-policy/templates")
      .then((response) => response.json())
      .then((body: unknown) => {
        if (!alive) return;
        if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>)["templates"])) {
          setTemplates([]);
          return;
        }
        setTemplates((body as { templates: PolicyTemplate[] }).templates);
      })
      .catch(() => { if (alive) setMessage("模板列表暂时不可用"); })
      .finally(() => { if (alive) setAction(null); });
    return () => { alive = false; };
  }, []);

  const applySelected = () => {
    const template = templates.find((item) => item.id === selectedId);
    const loaded = template ? mapSavedPolicy(template.policy) : null;
    if (!template || !loaded) {
      setMessage("模板内容无法读取");
      return;
    }
    onApply(loaded);
    setMessage(`已套用「${template.name}」，保存订阅后才会生效`);
  };

  const create = async () => {
    const trimmed = name.trim();
    if (busy) return;
    if (!trimmed) { setMessage("请先填写模板名称"); return; }
    setAction("save");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, policy: toPolicy(draft) }),
      });
      const result = await readTemplateResponse(response, "模板保存失败");
      if (!result.template) { setMessage(result.error); return; }
      setTemplates((current) => [...current.filter((item) => item.id !== result.template!.id), result.template!]);
      setSelectedId(result.template.id);
      setName("");
      setMessage("模板已保存");
    } catch { setMessage("网络错误，模板未保存"); }
    finally { setAction(null); }
  };

  const update = async () => {
    const trimmed = name.trim();
    if (busy || !selectedId) return;
    if (!trimmed) { setMessage("请先填写模板名称"); return; }
    setAction("update");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selectedId, name: trimmed, policy: toPolicy(draft) }),
      });
      const result = await readTemplateResponse(response, "模板更新失败");
      if (!result.template) { setMessage(result.error); return; }
      setTemplates((current) => [...current.filter((item) => item.id !== result.template!.id), result.template!]);
      setMessage("模板已更新；已应用的规则与已排队任务不受影响");
    } catch { setMessage("网络错误，模板未更新"); }
    finally { setAction(null); }
  };

  const remove = async () => {
    if (busy || !selectedId) return;
    setAction("delete");
    try {
      const response = await fetch("/api/titles/subscription-policy/templates", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: selectedId }),
      });
      if (!response.ok) { setMessage("模板删除失败"); return; }
      setTemplates((current) => current.filter((item) => item.id !== selectedId));
      setSelectedId("");
      setMessage("模板已删除；已应用的规则不受影响");
    } catch { setMessage("网络错误，模板未删除"); }
    finally { setAction(null); }
  };

  const loading = action === "load";

  return (
    <div className="sub-policy-template-tools" aria-label="订阅策略模板">
      <label>
        规则模板
        <select
          value={selectedId}
          disabled={busy || loading}
          onChange={(event) => {
            const id = event.target.value;
            setSelectedId(id);
            setName(templates.find((item) => item.id === id)?.name ?? "");
            setMessage("");
          }}
        >
          <option value="">{loading ? "读取中…" : templates.length === 0 ? "还没有模板" : "选择已保存模板"}</option>
          {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
      <div className="sub-policy-template-actions">
        <button type="button" disabled={!selectedId || busy} onClick={applySelected}>应用模板</button>
        <button type="button" disabled={!selectedId || busy} onClick={update}>{action === "update" ? "更新中…" : "用当前规则更新模板"}</button>
        <button type="button" disabled={!selectedId || busy} onClick={remove}>{action === "delete" ? "删除中…" : "删除模板"}</button>
      </div>
      <label>
        另存为模板
        <input
          value={name}
          maxLength={40}
          disabled={busy}
          onChange={(event) => { setName(event.target.value); setMessage(""); }}
          placeholder="例如：动漫 1080p 字幕组"
        />
      </label>
      <button type="button" disabled={busy} onClick={create}>{action === "save" ? "保存中…" : "保存当前规则为模板"}</button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}
