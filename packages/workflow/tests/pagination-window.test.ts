import { describe, expect, it } from "vitest";
import {
  calculatePageWindow,
  DEFAULT_PAGE_SIZE,
  normalizePageSize,
  SUPPORTED_PAGE_SIZES,
} from "../src/pagination-window.js";

describe("pagination-window 算法与规格", () => {
  it("默认每页大小为 30 部", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(30);
    expect(SUPPORTED_PAGE_SIZES).toEqual([20, 30, 50]);
  });

  it("normalizePageSize 容错与默认回退", () => {
    expect(normalizePageSize(undefined)).toBe(30);
    expect(normalizePageSize(null)).toBe(30);
    expect(normalizePageSize("")).toBe(30);
    expect(normalizePageSize("abc")).toBe(30);
    expect(normalizePageSize(15)).toBe(30);
    expect(normalizePageSize(20)).toBe(20);
    expect(normalizePageSize("20")).toBe(20);
    expect(normalizePageSize(30)).toBe(30);
    expect(normalizePageSize("30")).toBe(30);
    expect(normalizePageSize(50)).toBe(50);
    expect(normalizePageSize("50")).toBe(50);
  });

  it("calculatePageWindow: 当 pageSize=30, page=1 时正确请求 TMDB 1~2 页并切片前 30 条", () => {
    const res = calculatePageWindow(1, 30, 20);
    expect(res).toEqual({
      startPage: 1,
      endPage: 2,
      sliceStart: 0,
      sliceEnd: 30,
    });
  });

  it("calculatePageWindow: 当 pageSize=30, page=2 时正确请求 TMDB 2~3 页并切片第 31~60 条", () => {
    const res = calculatePageWindow(2, 30, 20);
    expect(res).toEqual({
      startPage: 2,
      endPage: 3,
      sliceStart: 10,
      sliceEnd: 40,
    });
  });

  it("calculatePageWindow: 当 pageSize=20, page=1 时仅请求 TMDB 第 1 页", () => {
    const res = calculatePageWindow(1, 20, 20);
    expect(res).toEqual({
      startPage: 1,
      endPage: 1,
      sliceStart: 0,
      sliceEnd: 20,
    });
  });

  it("calculatePageWindow: 当 pageSize=50, page=1 时并发请求 TMDB 1~3 页", () => {
    const res = calculatePageWindow(1, 50, 20);
    expect(res).toEqual({
      startPage: 1,
      endPage: 3,
      sliceStart: 0,
      sliceEnd: 50,
    });
  });

  it("calculatePageWindow: 异常页码防越界", () => {
    const res = calculatePageWindow(0, 30, 20);
    expect(res.startPage).toBe(1);
    expect(res.endPage).toBe(2);
  });
});
