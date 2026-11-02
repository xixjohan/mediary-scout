import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  calculateShannonEntropy,
  analyzeContent,
  COMPLIANT_PLACEHOLDERS,
  DETECTOR_RULES,
} from "./check-security-credentials.mjs";

describe("Security & Credential Gate Verification", () => {
  it("passes check-security-credentials.mjs on actual repository with 0 violations", () => {
    const scriptPath = join(process.cwd(), "tools/gates/check-security-credentials.mjs");
    const output = execSync(`node "${scriptPath}"`, { encoding: "utf8" });
    expect(output).toContain("[Security Gate]");
    expect(output).toContain("0 项违规");
  });

  describe("Shannon Entropy Calculator", () => {
    it("returns 0 for empty string", () => {
      expect(calculateShannonEntropy("")).toBe(0);
    });

    it("returns low entropy for repetitive text", () => {
      expect(calculateShannonEntropy("aaaaaaaaaaaaaaaaaaaa")).toBe(0);
      expect(calculateShannonEntropy("abcabcabcabcabc")).toBeLessThan(2.0);
    });

    it("returns high entropy (> 3.0) for random high-entropy keys", () => {
      expect(calculateShannonEntropy("4XNDR15LYZPCUbUPbuR6R7")).toBeGreaterThan(3.5);
      expect(calculateShannonEntropy("1af0ae0b8eacf803c73ceeaebc1c7f84")).toBeGreaterThan(3.0);
    });
  });

  describe("Detector Strategies (Rule Verification)", () => {
    it("catches real unmasked OpenAI Key (SEC-001)", () => {
      // Dynamic split string to avoid self-triggering static scanners
      const badSnippet = "const apiKey = " + '"sk-' + "a9F3kL90QxZyWvUtSrQpOnMlKjIhGfEdCb";
      const violations = analyzeContent("apps/web/test.ts", badSnippet);
      expect(violations.some((v) => v.ruleId === "SEC-001-OPENAI-KEY")).toBe(true);
    });

    it("allows standard compliant OpenAI test placeholders (SEC-001)", () => {
      const good1 = 'const key = "sk-proj-test-secret-key-1234567890";';
      const good2 = 'const key = "sk-test-super-secret-12345";';
      const good3 = 'const key = "sk-test-key-abcdef-1234";';
      const good4 = 'const key = "sk-***7f2a";';

      expect(analyzeContent("docs/test.md", good1)).toHaveLength(0);
      expect(analyzeContent("docs/test.md", good2)).toHaveLength(0);
      expect(analyzeContent("apps/web/test.ts", good3)).toHaveLength(0);
      expect(analyzeContent("apps/web/test.ts", good4)).toHaveLength(0);
    });

    it("catches real unmasked LinuxWebTool API Key (SEC-002)", () => {
      const badLwt = "apiKey: " + '"lwt_live_' + "1af0ae0b8eacf803c73ceeaebc1c7f84" + '"';
      const violations = analyzeContent("docs/postmortems/sample.md", badLwt);
      expect(violations.some((v) => v.ruleId === "SEC-002-LWT-KEY")).toBe(true);
    });

    it("allows standard compliant LinuxWebTool placeholder lwt_live_8f3a9e... (SEC-002)", () => {
      const goodLwt = '2. 找到当前 API Key `lwt_live_8f3a9e...`，点击 编辑；';
      expect(analyzeContent("docs/postmortems/sample.md", goodLwt)).toHaveLength(0);
    });

    it("catches real un-mocked private key (SEC-005)", () => {
      const badKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";
      const violations = analyzeContent("tests/bad.test.ts", badKey);
      expect(violations.some((v) => v.ruleId === "SEC-005-PRIVATE-KEY")).toBe(true);
    });

    it("allows mocked private key fixtures containing MOCK_KEY_DATA (SEC-005)", () => {
      const mockKey = 'const mockPrivateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\\nMOCK_KEY_DATA\\n-----END OPENSSH PRIVATE KEY-----";';
      expect(analyzeContent("tests/good.test.ts", mockKey)).toHaveLength(0);
    });

    it("catches hardcoded administrator password (SEC-006)", () => {
      const badPass = 'WEB_ADMIN_PASSWORD = "MySecretSuperPassword2026!"';
      const violations = analyzeContent("scripts/deploy.sh", badPass);
      expect(violations.some((v) => v.ruleId === "SEC-006-HARDCODED-PASSWORD")).toBe(true);
    });

    it("allows placeholder administrator password (SEC-006)", () => {
      const goodPass1 = 'WEB_ADMIN_PASSWORD = "your_secure_password_here"';
      const goodPass2 = 'WEB_ADMIN_PASSWORD = "<ADMIN_PASSWORD>"';
      const goodPass3 = 'WEB_ADMIN_PASSWORD = process.env.WEB_ADMIN_PASSWORD || ""';

      expect(analyzeContent("scripts/deploy.sh", goodPass1)).toHaveLength(0);
      expect(analyzeContent("scripts/deploy.sh", goodPass2)).toHaveLength(0);
      expect(analyzeContent("apps/web/test.ts", goodPass3)).toHaveLength(0);
    });

    it("catches forbidden developer private host IP and SSH port (SEC-007)", () => {
      const badIp = "const url = " + '"http://10.' + '126.1.70:3020/";';
      const badPort = "DEPLOY_" + "PORT=45612";

      expect(analyzeContent("docs/test.md", badIp).some((v) => v.ruleId === "SEC-007-FORBIDDEN-INTERNAL-IP")).toBe(true);
      expect(analyzeContent("env/.env.sample", badPort).some((v) => v.ruleId === "SEC-007-FORBIDDEN-INTERNAL-IP")).toBe(true);
    });

    it("allows RFC 5737 and standard loopback/Docker IPs (SEC-007)", () => {
      const allowed1 = "http://127.0.0.1:3000";
      const allowed2 = "http://172.17.0.1:7890";
      const allowed3 = "http://host.docker.internal:5280";
      const allowed4 = "https://example.com";

      expect(analyzeContent("docs/test.md", allowed1)).toHaveLength(0);
      expect(analyzeContent("docs/test.md", allowed2)).toHaveLength(0);
      expect(analyzeContent("docs/test.md", allowed3)).toHaveLength(0);
      expect(analyzeContent("docs/test.md", allowed4)).toHaveLength(0);
    });

    it("catches real unmasked EasyTier secret (SEC-008)", () => {
      const badSecret = 'network_secret = "my_custom_secret_123456"';
      const violations = analyzeContent("docs/easytier.md", badSecret);
      expect(violations.some((v) => v.ruleId === "SEC-008-EASYTIER-TUNNEL-SECRET")).toBe(true);
    });

    it("allows standard compliant EasyTier placeholder demo_secret_token (SEC-008)", () => {
      const goodSecret = 'network_secret = "demo_secret_token"';
      expect(analyzeContent("docs/easytier.md", goodSecret)).toHaveLength(0);
    });
  });

  describe("Suppression Engine", () => {
    it("respects inline single-line suppression comments", () => {
      const badCodeWithInlineComment =
        "const apiKey = " + '"sk-' + "a9F3kL90QxZyWvUtSrQpOnMlKjIhGfEdCb\"; // security-disable-line";
      expect(analyzeContent("apps/web/test.ts", badCodeWithInlineComment)).toHaveLength(0);
    });

    it("respects next-line suppression comments", () => {
      const badCodeWithNextLineComment = [
        "// security-disable-next-line",
        "const apiKey = " + '"sk-' + "a9F3kL90QxZyWvUtSrQpOnMlKjIhGfEdCb\";",
      ].join("\n");
      expect(analyzeContent("apps/web/test.ts", badCodeWithNextLineComment)).toHaveLength(0);
    });

    it("respects baseline suppressions JSON", () => {
      const badCode = "const apiKey = " + '"sk-' + "a9F3kL90QxZyWvUtSrQpOnMlKjIhGfEdCb\";";
      const suppressions = {
        "apps/web/legacy.ts": {
          "SEC-001-OPENAI-KEY": "Legacy known test string",
        },
      };
      expect(analyzeContent("apps/web/legacy.ts", badCode, suppressions)).toHaveLength(0);
    });
  });
});
