import { describe, expect, it } from "vitest";
import { PaginationBar, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE_OPTIONS } from "./pagination-bar";

describe("PaginationBar component", () => {
  it("默认分页大小规格为 30 部，可选 20/30/50 部", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(30);
    expect(DEFAULT_PAGE_SIZE_OPTIONS).toEqual([20, 30, 50]);
  });

  it("totalPages <= 1 且结果很少时静默不渲染", () => {
    const res = PaginationBar({
      currentPage: 1,
      totalPages: 1,
      totalResults: 15,
      basePath: "/",
    });
    expect(res).toBeNull();
  });

  it("totalPages > 1 时正确渲染分页条与每页条数切换器", () => {
    const res = PaginationBar({
      currentPage: 2,
      totalPages: 5,
      totalResults: 135,
      pageSize: 30,
      basePath: "/w/cs_test",
      queryParams: { q: "流浪地球", type: "movie" },
    });

    expect(res).not.toBeNull();
    expect(res?.props["className"]).toBe("pagination-bar");
    expect(res?.props["aria-label"]).toBe("分页导航");

    const children = res?.props?.children;
    expect(Array.isArray(children)).toBe(true);
  });

  it("支持自定义 pageSize（如 20 或 50 部）且正确透传", () => {
    const res20 = PaginationBar({
      currentPage: 1,
      totalPages: 3,
      totalResults: 55,
      pageSize: 20,
      basePath: "/",
    });
    expect(res20).not.toBeNull();

    const res50 = PaginationBar({
      currentPage: 1,
      totalPages: 2,
      totalResults: 80,
      pageSize: 50,
      basePath: "/",
    });
    expect(res50).not.toBeNull();
  });
});
