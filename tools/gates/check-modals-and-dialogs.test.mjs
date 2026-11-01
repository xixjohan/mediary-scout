import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { checkFileModalCompliance, stripCommentsPreservingLines } from "./check-modals-and-dialogs.mjs";

describe("Modals & Dialogs Architecture Gate", () => {
  it("passes check-modals-and-dialogs.mjs across all web components with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-modals-and-dialogs.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Modals Gate] 门禁质检通过");
    expect(output).toContain("0 原生阻塞调用");
  });

  describe("stripCommentsPreservingLines", () => {
    it("strips block comments and single-line comments while preserving newlines", () => {
      const code = `
        const a = 1;
        /* multi
           line
           comment with alert('blocked') */
        const b = 2; // inline comment with confirm('foo')
      `;
      const stripped = stripCommentsPreservingLines(code);
      expect(stripped).not.toContain("alert('blocked')");
      expect(stripped).not.toContain("confirm('foo')");
      expect(stripped.split("\n").length).toBe(code.split("\n").length);
    });
  });

  describe("checkFileModalCompliance unit tests", () => {
    it("detects native confirm() call", () => {
      const badCode = `export function Foo() { if (confirm("Are you sure?")) { doSomething(); } }`;
      const violations = checkFileModalCompliance("test.tsx", badCode);
      expect(violations.some((v) => v.rule === "no-native-confirm")).toBe(true);
    });

    it("detects native alert() call", () => {
      const badCode = `export function Foo() { alert("Something happened"); }`;
      const violations = checkFileModalCompliance("test.tsx", badCode);
      expect(violations.some((v) => v.rule === "no-native-alert")).toBe(true);
    });

    it("detects un-portaled fixed modal backdrop", () => {
      const badModal = `
        export function MyModal() {
          return (
            <div style={{ position: "fixed", inset: 0, zIndex: 9999 }}>
              <div>Modal Content</div>
            </div>
          );
        }
      `;
      const violations = checkFileModalCompliance("test.tsx", badModal);
      expect(violations.some((v) => v.rule === "modal-portal-required")).toBe(true);
    });

    it("detects modal with low zIndex (< 9000)", () => {
      const lowZModal = `
        import { createPortal } from "react-dom";
        export function MyModal() {
          return createPortal(
            <div style={{ position: "fixed", inset: 0, zIndex: 1000 }}>
              <div>Modal Content</div>
            </div>,
            document.body
          );
        }
      `;
      const violations = checkFileModalCompliance("test.tsx", lowZModal);
      expect(violations.some((v) => v.rule === "modal-low-zindex")).toBe(true);
    });

    it("accepts compliant modal with createPortal and high zIndex", () => {
      const goodModal = `
        import { createPortal } from "react-dom";
        export function MyModal() {
          return createPortal(
            <div style={{ position: "fixed", inset: 0, zIndex: 9999 }}>
              <div>Modal Content</div>
            </div>,
            document.body
          );
        }
      `;
      const violations = checkFileModalCompliance("test.tsx", goodModal);
      expect(violations).toHaveLength(0);
    });
  });
});
