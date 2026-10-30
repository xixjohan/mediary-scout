"use client";

import React, { type ReactNode } from "react";

/**
 * 纯 React 轻量级 Markdown 词法与渲染器（零外部依赖、100% XSS 安全）。
 *
 * 针对影视 Agent 输出的高频格式优化：
 *  - 结构化表格（| 影片 | 评分 | 状态 |）
 *  - 分级标题（# / ## / ###）
 *  - 行内强调（**粗体**、*斜体*、`行内代码`）
 *  - 有序/无序列表（1. / -）
 *  - 引用块（> 提示）
 *  - 围栏代码块（``` ... ```）
 */

function parseSingleInlineToken(token: string, key: string): ReactNode {
  if (token.startsWith("**") && token.endsWith("**")) {
    return (
      <strong key={key} className="chat-md-bold">
        {token.slice(2, -2)}
      </strong>
    );
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    return (
      <code key={key} className="chat-md-inline-code">
        {token.slice(1, -1)}
      </code>
    );
  }
  if (token.startsWith("*") && token.endsWith("*")) {
    return (
      <em key={key} className="chat-md-italic">
        {token.slice(1, -1)}
      </em>
    );
  }
  if (token.startsWith("[") && token.includes("](")) {
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      return (
        <a
          key={key}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-md-link"
        >
          {linkMatch[1]}
        </a>
      );
    }
  }
  return token;
}

export function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${match.index}-${token.slice(0, 10)}`;
    nodes.push(parseSingleInlineToken(token, key));
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

function parseTableRows(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const sepLine = lines[1];
  if (!headerLine || !sepLine) return null;

  if (!headerLine.includes("|") || !sepLine.includes("|") || !sepLine.includes("-")) {
    return null;
  }

  const cleanCells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = cleanCells(headerLine);
  const rows: string[][] = [];

  for (let i = 2; i < lines.length; i += 1) {
    const cur = lines[i]?.trim();
    if (cur && cur.includes("|")) {
      rows.push(cleanCells(cur));
    }
  }

  return { headers, rows };
}

type BlockToken =
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang?: string | undefined; code: string }
  | { type: "quote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

function tryConsumeCode(lines: string[], i: number): { token: BlockToken; nextIndex: number } | null {
  const line = lines[i]?.trim() ?? "";
  if (!line.startsWith("```")) return null;
  const lang = line.slice(3).trim();
  const codeLines: string[] = [];
  let cur = i + 1;
  while (cur < lines.length && !lines[cur]?.trim().startsWith("```")) {
    codeLines.push(lines[cur] ?? "");
    cur += 1;
  }
  return {
    token: { type: "code", lang: lang || undefined, code: codeLines.join("\n") },
    nextIndex: cur + 1,
  };
}

function tryConsumeHeading(line: string): BlockToken | null {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  if (!match || !match[1] || !match[2]) return null;
  return { type: "heading", level: match[1].length, text: match[2].trim() };
}

function tryConsumeQuote(lines: string[], i: number): { token: BlockToken; nextIndex: number } | null {
  const first = lines[i]?.trim() ?? "";
  if (!first.startsWith(">")) return null;
  const quoteLines: string[] = [];
  let cur = i;
  while (
    cur < lines.length &&
    (lines[cur]?.trim().startsWith(">") || (quoteLines.length > 0 && lines[cur]?.trim() !== ""))
  ) {
    const line = lines[cur]?.trim() ?? "";
    quoteLines.push(line.startsWith(">") ? line.replace(/^>\s?/, "") : line);
    cur += 1;
  }
  return { token: { type: "quote", lines: quoteLines }, nextIndex: cur };
}

function tryConsumeTable(lines: string[], i: number): { token: BlockToken; nextIndex: number } | null {
  const line = lines[i]?.trim() ?? "";
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const tableLines: string[] = [];
  let cur = i;
  while (cur < lines.length && lines[cur]?.trim().startsWith("|")) {
    tableLines.push(lines[cur]?.trim() ?? "");
    cur += 1;
  }
  const parsed = parseTableRows(tableLines);
  if (!parsed) return null;
  return { token: { type: "table", headers: parsed.headers, rows: parsed.rows }, nextIndex: cur };
}

function tryConsumeList(lines: string[], i: number): { token: BlockToken; nextIndex: number } | null {
  const line = lines[i]?.trim() ?? "";
  const isBullet = line.startsWith("- ") || line.startsWith("* ");
  const isNumbered = /^\d+\.\s+/.test(line);
  if (!isBullet && !isNumbered) return null;
  const items: string[] = [];
  const ordered = isNumbered;
  let cur = i;
  while (cur < lines.length) {
    const l = lines[cur]?.trim() ?? "";
    const matches = ordered ? /^\d+\.\s+/.test(l) : l.startsWith("- ") || l.startsWith("* ");
    if (!matches) break;
    items.push(l.replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, ""));
    cur += 1;
  }
  return { token: { type: "list", ordered, items }, nextIndex: cur };
}

function consumeParagraph(lines: string[], i: number): { token: BlockToken; nextIndex: number } {
  const pLines: string[] = [];
  let cur = i;
  while (cur < lines.length) {
    const l = lines[cur]?.trim() ?? "";
    if (
      !l ||
      l.startsWith("#") ||
      l.startsWith("```") ||
      l.startsWith(">") ||
      l.startsWith("|") ||
      l.startsWith("- ") ||
      l.startsWith("* ") ||
      /^\d+\.\s+/.test(l)
    ) {
      break;
    }
    pLines.push(l);
    cur += 1;
  }
  return { token: { type: "paragraph", text: pLines.join(" ") }, nextIndex: cur };
}

function tokenizeBlocks(markdown: string): BlockToken[] {
  const lines = markdown.split(/\r?\n/);
  const tokens: BlockToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]?.trim() ?? "";
    if (!line) {
      i += 1;
      continue;
    }

    const code = tryConsumeCode(lines, i);
    if (code) {
      tokens.push(code.token);
      i = code.nextIndex;
      continue;
    }

    const head = tryConsumeHeading(line);
    if (head) {
      tokens.push(head);
      i += 1;
      continue;
    }

    const quote = tryConsumeQuote(lines, i);
    if (quote) {
      tokens.push(quote.token);
      i = quote.nextIndex;
      continue;
    }

    const table = tryConsumeTable(lines, i);
    if (table) {
      tokens.push(table.token);
      i = table.nextIndex;
      continue;
    }

    const list = tryConsumeList(lines, i);
    if (list) {
      tokens.push(list.token);
      i = list.nextIndex;
      continue;
    }

    const p = consumeParagraph(lines, i);
    tokens.push(p.token);
    i = p.nextIndex;
  }

  return tokens;
}

export function MarkdownContent({ content }: { content: string }) {
  const blocks = tokenizeBlocks(content);

  return (
    <div className="chat-markdown-root">
      {blocks.map((block, idx) => {
        const key = `blk-${idx}`;
        switch (block.type) {
          case "heading": {
            if (block.level === 1) {
              return (
                <h3 key={key} className="chat-md-h3">
                  {renderInlineMarkdown(block.text)}
                </h3>
              );
            }
            if (block.level === 2) {
              return (
                <h4 key={key} className="chat-md-h4">
                  {renderInlineMarkdown(block.text)}
                </h4>
              );
            }
            return (
              <h5 key={key} className="chat-md-h5">
                {renderInlineMarkdown(block.text)}
              </h5>
            );
          }
          case "code":
            return (
              <pre key={key} className="chat-md-code-block">
                <code>{block.code}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={key} className="chat-md-quote">
                {block.lines.map((l, lIdx) => (
                  <p key={`ql-${lIdx}`}>{renderInlineMarkdown(l)}</p>
                ))}
              </blockquote>
            );
          case "table":
            return (
              <div key={key} className="chat-md-table-wrap">
                <table className="chat-md-table">
                  <thead>
                    <tr>
                      {block.headers.map((h, hIdx) => (
                        <th key={`th-${hIdx}`}>{renderInlineMarkdown(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={`tr-${rIdx}`}>
                        {row.map((cell, cIdx) => (
                          <td key={`td-${cIdx}`}>{renderInlineMarkdown(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list": {
            const listItems = block.items.map((item, itemIdx) => (
              <li key={`li-${itemIdx}`}>{renderInlineMarkdown(item)}</li>
            ));
            return block.ordered ? (
              <ol key={key} className="chat-md-ol">
                {listItems}
              </ol>
            ) : (
              <ul key={key} className="chat-md-ul">
                {listItems}
              </ul>
            );
          }
          case "paragraph":
          default:
            return (
              <p key={key} className="chat-md-p">
                {renderInlineMarkdown(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
