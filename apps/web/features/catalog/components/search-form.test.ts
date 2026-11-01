import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => {
  const focus = vi.fn();
  return {
    query: "" as string,
    push: vi.fn(),
    focus,
    inputRef: { current: { focus } },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      h.query || (typeof initial === "string" ? initial : ""),
      (next: string | ((prev: string) => string)) => {
        h.query = typeof next === "function" ? next(h.query) : next;
      },
    ],
    useRef: () => h.inputRef,
    useEffect: (fn: () => void) => fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
}));

import { SearchForm } from "./search-form";

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (match(element)) return element;
  return find(element.props.children, match);
}

describe("SearchForm 搜索表单组件与清空按钮交互", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query = "";
  });

  it("空查询时不渲染清空按钮", () => {
    h.query = "";
    const html = renderToStaticMarkup(createElement(SearchForm, { basePath: "/", defaultQuery: "" }));
    expect(html).not.toContain("search-box-clear");
    expect(html).not.toContain("清空关键词");
  });

  it("纯空白字符也不渲染清空按钮", () => {
    h.query = "   ";
    const html = renderToStaticMarkup(createElement(SearchForm, { basePath: "/", defaultQuery: "   " }));
    expect(html).not.toContain("search-box-clear");
    expect(html).not.toContain("清空关键词");
  });

  it("有查询词时渲染类似资源搜索框方案的清空按钮", () => {
    h.query = "流浪地球";
    const html = renderToStaticMarkup(createElement(SearchForm, { basePath: "/", defaultQuery: "流浪地球" }));
    expect(html).toContain("search-box-clear");
    expect(html).toContain('aria-label="清空关键词"');
    expect(html).toContain('title="清空关键词"');
    expect(html).toContain('type="button"');
  });

  it("点击清空按钮会重置 query 为空并将焦点归还至输入框", () => {
    h.query = "奥本海默";
    const tree = SearchForm({ basePath: "/", defaultQuery: "奥本海默" });
    const clearBtn = find(
      tree,
      (el) =>
        el.type === "button" &&
        (el.props as { "aria-label"?: string })["aria-label"] === "清空关键词",
    );
    expect(clearBtn).not.toBeNull();

    (clearBtn!.props as { onClick: () => void }).onClick();
    expect(h.query).toBe("");
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it("在输入框中按下 Escape 键会触发清空与聚焦", () => {
    h.query = "星际穿越";
    const tree = SearchForm({ basePath: "/", defaultQuery: "星际穿越" });
    const input = find(tree, (el) => el.type === "input" && (el.props as { name?: string }).name === "q");
    expect(input).not.toBeNull();

    (input!.props as {
      onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }) => void;
    }).onKeyDown({
      key: "Escape",
      nativeEvent: { isComposing: false, keyCode: 27 },
    });

    expect(h.query).toBe("");
    expect(h.focus).toHaveBeenCalledTimes(1);
  });

  it("输入法合成中 (isComposing) 按键不误触发清空", () => {
    h.query = "测试";
    const tree = SearchForm({ basePath: "/", defaultQuery: "测试" });
    const input = find(tree, (el) => el.type === "input" && (el.props as { name?: string }).name === "q");
    expect(input).not.toBeNull();

    (input!.props as {
      onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }) => void;
    }).onKeyDown({
      key: "Escape",
      nativeEvent: { isComposing: true, keyCode: 229 },
    });

    expect(h.query).toBe("测试");
    expect(h.focus).not.toHaveBeenCalled();
  });

  it("表单提交时触发软导航至对应查询路径", () => {
    h.query = "  阿凡达  ";
    const tree = SearchForm({ basePath: "/w/drive-1", defaultQuery: "  阿凡达  " });
    const form = find(tree, (el) => el.type === "form");
    expect(form).not.toBeNull();

    const preventDefault = vi.fn();
    (form!.props as { onSubmit: (e: { preventDefault: () => void }) => void }).onSubmit({
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith("/w/drive-1?tab=search&q=%E9%98%BF%E5%87%A1%E8%BE%BE");
  });
});
