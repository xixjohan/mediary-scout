import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResourceEmptyDiagnostic } from "./title-resource-panel";

describe("ResourceEmptyDiagnostic 智能空状态与诊断组件", () => {
  it("未来公映日期：诊断为 unreleased 并展示上映日期和预定指引", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceEmptyDiagnostic, {
        state: {
          kind: "ready",
          candidates: [],
          cached: false,
          snapshotId: null,
        },
        releaseDate: "2028-08-26",
        baseTitle: "末世行者",
        customKeyword: "末世行者",
      }),
    );

    expect(html).toContain('data-diagnostic="unreleased"');
    expect(html).toContain("尚未公映或尚未发布数字版");
    expect(html).toContain("2028年8月26日");
    expect(html).toContain("建议在页面上方点击「预定」或「追踪」");
  });

  it("检索源不可用：诊断为 source_error 并指引前往设置排查网络与索引器", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceEmptyDiagnostic, {
        state: {
          kind: "ready",
          candidates: [],
          cached: false,
          snapshotId: null,
          sourceHealth: {
            status: "unreachable",
            unhealthySources: ["pansou"],
          },
        },
        releaseDate: "2020-01-01",
        baseTitle: "星际穿越",
        customKeyword: "星际穿越",
      }),
    );

    expect(html).toContain('data-diagnostic="source_error"');
    expect(html).toContain("检索源服务响应异常");
    expect(html).toContain("pansou");
    expect(html).toContain('href="/settings"');
  });

  it("自定义关键词过载过度过滤：诊断为 over_constrained 并提供一键还原按钮", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceEmptyDiagnostic, {
        state: {
          kind: "ready",
          candidates: [],
          cached: false,
          snapshotId: null,
        },
        releaseDate: "2020-01-01",
        baseTitle: "流浪地球",
        customKeyword: "流浪地球 4K 简日内嵌",
        onResetKeyword: () => {},
      }),
    );

    expect(html).toContain('data-diagnostic="over_constrained"');
    expect(html).toContain("未检索到符合条件的资源");
    expect(html).toContain("流浪地球 4K 简日内嵌");
    expect(html).toContain("还原为基础片名「流浪地球」重新检索");
  });

  it("普通无结果：诊断为 none 并展示多渠道指引（网盘离线下载与配置）", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceEmptyDiagnostic, {
        state: {
          kind: "ready",
          candidates: [],
          cached: false,
          snapshotId: null,
        },
        releaseDate: "2020-01-01",
        baseTitle: "冷门纪录片",
        customKeyword: "冷门纪录片",
      }),
    );

    expect(html).toContain('data-diagnostic="none"');
    expect(html).toContain("没有找到可获取的资源");
    expect(html).toContain('href="/storage"');
    expect(html).toContain('href="/settings"');
  });

  it("流式检索中：展示正在检索与进度百分比", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceEmptyDiagnostic, {
        state: {
          kind: "streaming",
          candidates: [],
          progress: { done: 2, total: 5, currentKeyword: "龙珠超" },
        },
        releaseDate: "2020-01-01",
        baseTitle: "龙珠超",
        customKeyword: "龙珠超",
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("正在检索全网资源…");
    expect(html).toContain("2 / 5");
    expect(html).toContain("龙珠超");
  });
});
