import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { MarkdownContent, renderInlineMarkdown } from "./markdown-content";

describe("renderInlineMarkdown — 行内 Markdown 格式化", () => {
  it("解析粗体、斜体与行内代码", () => {
    const nodes = renderInlineMarkdown("这是一段 **重要** 和 *强调* 以及 `code` 内容");
    const html = renderToString(React.createElement("div", null, nodes));
    expect(html).toContain('<strong class="chat-md-bold">重要</strong>');
    expect(html).toContain('<em class="chat-md-italic">强调</em>');
    expect(html).toContain('<code class="chat-md-inline-code">code</code>');
  });

  it("解析标准超链接", () => {
    const nodes = renderInlineMarkdown("点击访问 [巡影官网](https://mediaryscout.app)");
    const html = renderToString(React.createElement("div", null, nodes));
    expect(html).toContain('href="https://mediaryscout.app"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("巡影官网");
  });
});

describe("MarkdownContent — 块级渲染能力", () => {
  it("支持渲染分级标题与普通段落", () => {
    const md = "# 大标题\n\n## 二级说明\n\n这是一段说明文本。";
    const html = renderToString(React.createElement(MarkdownContent, { content: md }));
    expect(html).toContain('<h3 class="chat-md-h3">大标题</h3>');
    expect(html).toContain('<h4 class="chat-md-h4">二级说明</h4>');
    expect(html).toContain('<p class="chat-md-p">这是一段说明文本。</p>');
  });

  it("支持渲染结构化 Markdown 表格", () => {
    const tableMd = [
      "| 影片 | 上映日期 | TMDB 评分 |",
      "|---|---|---|",
      "| 《Le Cerveau De Boltzmann》 | 2026-10-27 | 10.0 |",
      "| 《Tunnel Vision》 | 2026-10-24 | 9.8 |",
    ].join("\n");

    const html = renderToString(React.createElement(MarkdownContent, { content: tableMd }));
    expect(html).toContain('<table class="chat-md-table">');
    expect(html).toContain("<th>影片</th>");
    expect(html).toContain("<th>TMDB 评分</th>");
    expect(html).toContain("<td>《Le Cerveau De Boltzmann》</td>");
    expect(html).toContain("<td>10.0</td>");
    expect(html).toContain("<td>《Tunnel Vision》</td>");
  });

  it("支持代码块与引用块", () => {
    const md = [
      "> 这是一个重要警告提示",
      "",
      "```json",
      '{"status": "ok"}',
      "```",
    ].join("\n");

    const html = renderToString(React.createElement(MarkdownContent, { content: md }));
    expect(html).toContain('<blockquote class="chat-md-quote">');
    expect(html).toContain("这是一个重要警告提示");
    expect(html).toContain('<pre class="chat-md-code-block">');
    expect(html).toContain("status");
  });

  it("支持有序和无序列表", () => {
    const md = [
      "- 电影条目 A",
      "- 电影条目 B",
      "",
      "1. 第一步",
      "2. 第二步",
    ].join("\n");

    const html = renderToString(React.createElement(MarkdownContent, { content: md }));
    expect(html).toContain('<ul class="chat-md-ul">');
    expect(html).toContain("<li>电影条目 A</li>");
    expect(html).toContain('<ol class="chat-md-ol">');
    expect(html).toContain("<li>第一步</li>");
  });
});
