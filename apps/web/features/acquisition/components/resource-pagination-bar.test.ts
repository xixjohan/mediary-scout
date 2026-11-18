import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { paginateCandidates } from "../contracts/resource-filter-model";
import { ResourcePaginationBar } from "./resource-pagination-bar";

/**
 * 计数指示的 1 基语义。
 *
 * 缺陷原型（2026-11-18 Dev 3020 实测）：候选 36 条、筛选后 23 条、每页 20，
 * 分页条显示「显示第 0 - 20 项，共 23 项」——`startIndex/endIndex` 是数组 0 基
 * 偏移，直接被当成「第几项」渲染，用户看到的是不存在的「第 0 项」。
 * 断言：首项展示偏移 +1，末项与总数保持闭区间；空结果整条不渲染。
 */
describe("ResourcePaginationBar 计数指示", () => {
  const items = Array.from({ length: 23 }, (_, index) => ({ id: index }));
  const render = (page: number) =>
    renderToStaticMarkup(
      createElement(ResourcePaginationBar, {
        pagination: paginateCandidates(items, page, 20),
        onPageChange: () => {},
        onPageSizeChange: () => {},
      }),
    );

  it("首页显示「第 1 - 20 项，共 23 项」", () => {
    const html = render(1);
    expect(html).toContain("显示第 <strong>1</strong> - <strong>20</strong> 项，共 <strong>23</strong> 项");
    expect(html).not.toContain("第 <strong>0</strong>");
  });

  it("第二页显示「第 21 - 23 项」", () => {
    const html = render(2);
    expect(html).toContain("显示第 <strong>21</strong> - <strong>23</strong> 项，共 <strong>23</strong> 项");
  });

  it("空结果不渲染计数条（避免「第 1 - 0 项」这种不可能区间）", () => {
    const html = renderToStaticMarkup(
      createElement(ResourcePaginationBar, {
        pagination: paginateCandidates([], 1, 20),
        onPageChange: () => {},
        onPageSizeChange: () => {},
      }),
    );
    expect(html).toBe("");
  });
});
