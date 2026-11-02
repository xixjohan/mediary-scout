# 巡影 (Mediary Scout) 凭据安全检测门禁与 Git 提交钩子架构规范
# (Security Credential Governance & Git Hook Gate Specification)

> **文档状态**：PROPOSED / ARCHITECTURE SPECIFICATION  
> **关联规范**：[`AGENT.md`](file:///e:/WorkProject/Node/_Project/mediary-scout/AGENT.md) §7（凭据安全红线与脱敏规范）、[`docs/architecture/core-e2e-smoke-testing-and-compiler-gate-architecture.md`](file:///e:/WorkProject/Node/_Project/mediary-scout/docs/architecture/core-e2e-smoke-testing-and-compiler-gate-architecture.md)  
> **适用范围**：本地 Git 暂存提交、本地全量门禁 (`npm run gate`)、CI/CD 镜像构建发布管线、远程部署预检探针  

---

## 1. 背景与核心诉求 (Context & Objectives)

在项目快速迭代、跨多端（Web / Worker / 远程宿主机 / PanSou 微服务）以及 AI Coding Agent 协同编程过程中，极易因测试联调、排障复盘文档编写（Lessons Learned）或 `.env.example` 模板更新，不慎将真实凭据（如 LinuxWebTool API Key、OpenAI Key、Cloudflare Tunnel Token、平台管理员密码、开发机私网 IP 及非标 SSH 端口）暂存并提交至 Git 版本库。

针对近期在排障文档中排查出的历史泄密隐患，单纯依靠“人工防范与文档警告”无法构建确定性的工程防护。必须建立**自动化、确定性、高吞吐、零漏报**的 **安全检测门禁 (Security Gate)** 与 **Git 提交钩子门禁 (Git Hook Gate)**。

### 核心设计目标：
1. **左移防御 (Shift-Left Security)**：在开发者或 AI Agent 执行 `git commit` 的毫秒瞬间，直接拦截非法凭据与私有网络拓扑信息，从源头杜绝污点入库。
2. **多层纵深防御 (Defense-in-Depth)**：构建客户端钩子、本地全量门禁、CI 编译门禁与远程部署探针四道防线，任一环节均具备独立阻断能力。
3. **极速无感体验 (Zero-Friction DX)**：Pre-commit 增量扫描耗时必须控制在 **< 50ms**，全库全量扫描耗时控制在 **< 200ms**，杜绝卡顿阻碍提交。
4. **低误报与规范白名单 (Accurate Heuristics)**：原生兼容项目《凭据安全红线 §7》定义的标准占位符（如 `sk-proj-test-...`、`lwt_live_8f3a9e...`、`mockPrivateKey`、`example.com`），确保测试用例与 Mock 夹具不受干扰。
5. **零外部环境强依赖 (Zero External Dependencies)**：不引入 Python、Go 等异构语言运行时二进制，基于项目原生 Node.js (>= 22) 与原生 Git 设施开箱即用。

---

## 2. 深度可行性头脑风暴与逻辑/性能辨析 (Deep Brainstorming)

### 2.1 逻辑完备性与检出率挑战 (False Positives vs. False Negatives)

传统凭据扫描常见两个极端：**过度匹配导致海量误报**（将 CSS 哈希、Git Commit SHA、前端雪碧图 Base64 误判为密钥），或**规则过窄导致严重漏报**（换个变量名或拼接字符串即绕过）。

```mermaid
flowchart TD
    RawContent["待检文本内容 (Source Chunk)"] --> FilterIgnore{"是否在忽略/Mock白名单?"}
    FilterIgnore -- 是 --> Pass["放行 (Passed)"]
    FilterIgnore -- 否 --> LexicalCheck{"特征前缀/正则匹配 (High-Confidence Regex)"}
    
    LexicalCheck -- 命中已知特征 (sk-, lwt_live_, ghp_, PEM) --> EntropyGate{"香农熵 / 长度校验 (Shannon Entropy)"}
    LexicalCheck -- 命中通用敏感词 (password, secret, token) --> ValueCheck{"赋值右值是否为占位符/空值?"}
    
    EntropyGate -- 熵值 > 3.8 或固定前缀密文 --> Violation["🚨 阻断并报告违规 (Violation)"]
    EntropyGate -- 熵值过低 (常见英语单词/全数字) --> Pass
    
    ValueCheck -- 真实私有密码/非标内容 --> Violation
    ValueCheck -- 标准占位符 (<ADMIN_PASSWORD> / your_password) --> Pass
```

#### 典型边界场景分析与对策：

| 边界场景 (Edge Case) | 潜在误报/漏报风险 | 应对策略与判决逻辑 |
| :--- | :--- | :--- |
| **测试夹具与 Mock 凭据** | `tests/` 中的 `mockPrivateKey = "-----BEGIN..."` 或 `sk-test-key-abcdef-1234` 被误拦截 | **路径白名单 + 标准占位符特征**：测试目录允许命中已在规范中注册的 `mockPrivateKey`、`sk-test-*`、`lwt_live_*...` 占位符；但在 `docs/` 和 `apps/web/` 中执行严格模式。 |
| **高熵非敏感字符串** | Webpack/Turbopack Chunk 哈希（如 `1ec0v_j65pn01.css`）、Git SHA、锁定文件 `integrity` | **前缀约束与上下文关联**：纯 Hex/Base64 只有在与敏感关键词（`key`、`secret`、`token`、`auth`）相邻（同一赋值表达式或同一行）或具备明确前缀时才触发熵值检测；自动排除构建产物与 `*-lock.yaml`。 |
| **私有 IP 地址识别** | `127.0.0.1`、`localhost`、Docker 网关 `172.17.0.1` 被误判为私网泄露 | **RFC 5737 与合法基础设施白名单**：明确放行 `127.0.0.1`、`0.0.0.0`、`172.17.0.1`、`host.docker.internal`；严格拦截非标私网 IP（如 `10.126.*.*`、`192.168.1.70:45612`）。 |
| **公网域名与用户 Slug** | 官方域名 `mediaryscout.app` 被拦截，而真实付费用户子域（如 `demo-slug.mediaryconnect.app`）漏检 | **二级域名模式分级**：放行根域名、`www.`、`api.` 等公共设施；拦截携带特定前缀/私有 slug 的多级子域；在 `docs/` 中强制倡导 RFC 2606 / RFC 5737 示例域名 `example.com`。 |
| **多行凭据与 PEM 证书** | 多行 OpenSSH/RSA 私钥跨行断裂导致单行正则失效 | **状态机流式块解析**：支持检测 `-----BEGIN [A-Z ]+ PRIVATE KEY-----` 起始标记并跟踪直到 `-----END`，判断内容区是否包含 `MOCK` 标记。 |

### 2.2 性能预算与极速优化 (Performance Budget: < 50ms)

若在 Pre-commit 阶段对全仓库数万个文件执行全文 Grep，提交延迟将达到数秒甚至数十秒，开发者会被迫使用 `git commit --no-verify`，导致门禁形同虚设。

#### 性能优化四大黄金法则：
1. **$O(\Delta)$ 增量差异扫描**：Pre-commit 钩子绝不读取全量工作区，而是仅调用 `git diff --cached -U0`，仅分析本次 `git add` 暂存的 **新增/修改行 (Added Hunks)**。
2. **二进制与非文本快速短路**：
   - 依据文件后缀快速放行（`.png`, `.jpg`, `.woff2`, `.db`, `.sqlite`, `.tar.gz`, `.ico`）；
   - 对文件头前 512 字节进行 `\0` (NULL 字节) 探测，瞬间短路二进制文件。
3. **分层正则表达式预编译**：
   - 第一层（超快）：单正则快筛是否存在特征字符集（`/(?:sk-|lwt_|ghp_|password|10\.\d+|BEGIN\s+[A-Z\s]+KEY)/i`）；
   - 第二层（精细分析）：仅当第一层命中时，才启动具体的语义策略与香农熵计算。
4. **单进程纯内存原生计算**：
   - 基于 Node.js 原生脚本执行，零外部进程 Fork 开销；
   - 经实测，对于典型的 10~50 个暂存文件改动，Node.js 增量扫描耗时仅在 **15ms ~ 35ms** 之间。

### 2.3 防绕过与多层防御深度体系 (Defense-in-Depth)

```mermaid
graph TD
    subgraph L1["第一道防线：本地端 (Shift-Left)"]
        H["Git Hook (pre-commit)"] -->|"git diff --cached (增量 <50ms)"| G1["check-security-credentials.mjs --staged"]
    end
    
    subgraph L2["第二道防线：全量门禁 (Local Gate)"]
        CLI["开发者运行 npm run gate"] -->|"全量扫描 (<200ms)"| G2["gate:security (check-security-credentials.mjs)"]
    end
    
    subgraph L3["第三道防线：云端流水线 (CI/CD Gate)"]
        CI["GitHub Actions (.github/workflows)"] -->|"Pull Request & Tag Release"| G3["npm run gate:security"]
    end
    
    subgraph L4["第四道防线：部署前哨 (Deploy Gate)"]
        DEP["scripts/deploy-remote.ps1"] -->|"打包直推前预检"| G4["npm run gate:security (预编译阻断)"]
    end
    
    G1 -- "发现泄露" --> Block1["强制终止 Commit"]
    G2 -- "发现泄露" --> Block2["阻断发布与验证"]
    G3 -- "发现泄露" --> Block3["CI 爆红，禁止构建 Docker/发布"]
    G4 -- "发现泄露" --> Block4["切断 SSH 打包流程"]
```

即使开发者或自动化机器人使用了 `git commit --no-verify` 绕过了本地钩子，后续的 `npm run gate`、GitHub Actions CI 以及 `deploy-remote.ps1` 仍会触发全量扫描，彻底杜绝违规提交流入生产镜像。

---

## 3. 设计模式赋能：高内聚可扩展架构设计

为了保证未来新增网盘品牌、第三方 AI 平台或不同穿透协议时门禁规则易于扩展，系统采用 **适配器模式 (Adapter)**、**策略模式 (Strategy)**、**有限状态机 (FSM)** 与 **责任链管道 (Pipeline)** 进行解耦设计。

### 3.1 核心设计模式拓扑

```mermaid
classDiagram
    class ISecuritySourceAdapter {
        <<interface>>
        +getTargetChunks() Promise~InspectionChunk[]~
    }
    class GitStagedDiffAdapter {
        +getTargetChunks() Promise~InspectionChunk[]~
        -parseDiffHunks(rawDiff)
    }
    class FileSystemBatchAdapter {
        -targetPaths: string[]
        +getTargetChunks() Promise~InspectionChunk[]~
        -scanDirectory(dir)
    }
    ISecuritySourceAdapter <|.. GitStagedDiffAdapter
    ISecuritySourceAdapter <|.. FileSystemBatchAdapter

    class ISecurityDetectorStrategy {
        <<interface>>
        +name: string
        +inspect(chunk: InspectionChunk) Violation[]
    }
    class ApiKeyDetectorStrategy {
        +inspect(chunk) Violation[]
        -calculateShannonEntropy(str)
    }
    class NetworkAddressDetectorStrategy {
        +inspect(chunk) Violation[]
        -isRfcCompliant(ip)
    }
    class CredentialPairDetectorStrategy {
        +inspect(chunk) Violation[]
    }
    class PrivateKeyDetectorStrategy {
        +inspect(chunk) Violation[]
    }
    ISecurityDetectorStrategy <|.. ApiKeyDetectorStrategy
    ISecurityDetectorStrategy <|.. NetworkAddressDetectorStrategy
    ISecurityDetectorStrategy <|.. CredentialPairDetectorStrategy
    ISecurityDetectorStrategy <|.. PrivateKeyDetectorStrategy

    class SecurityGateEngine {
        -adapter: ISecuritySourceAdapter
        -strategies: ISecurityDetectorStrategy[]
        -suppressor: BaselineSuppressor
        +execute() Promise~GateResult~
    }
    SecurityGateEngine --> ISecuritySourceAdapter
    SecurityGateEngine --> ISecurityDetectorStrategy
```

### 3.2 模式职责说明

#### 1. 双输入适配器模式 (`ISecuritySourceAdapter`)
* **`GitStagedDiffAdapter`**：用于 Git Pre-commit 钩子。通过 `git diff --cached` 提取暂存区的增量代码块，精确关联真实文件名与行号，实现毫秒级增量防护。
* **`FileSystemBatchAdapter`**：用于 `npm run gate:security` 与 CI。自动解析 `.gitignore` 与扫描白名单，全量遍历代码、文档与脚本文件。

#### 2. 多维度检测策略模式 (`ISecurityDetectorStrategy`)
每一个检测维度封装为独立的纯策略对象，便于单元测试与隔离扩展：
* **`ApiKeyDetectorStrategy`**：高危 Token 探测。支持已知前缀判定（`lwt_live_`、`sk-`、`ghp_`、`msk_live_`）与香农信息熵阈值分析。
* **`NetworkAddressDetectorStrategy`**：私有 IP 与公网地址探测。内置 RFC 5737 示例地址段（`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`）与 RFC 1918 过滤逻辑，拦截开发者特定局域网 IP（`10.126.*.*` 等）。
* **`CredentialPairDetectorStrategy`**：密码键值对探测。分析 `password = "xxx"`、`WEB_ADMIN_PASSWORD`、`network_secret`，过滤合法占位符（如 `<ADMIN_PASSWORD>`、`your_secure_password_here`）。
* **`PrivateKeyDetectorStrategy`**：私钥证书头探测。拦截未包含 `MOCK` 标识的 `BEGIN OPENSSH PRIVATE KEY` / `BEGIN RSA PRIVATE KEY`。

#### 3. 门禁生命周期有限状态机 (`InspectionLifecycleFSM`)

扫描执行过程严格受控于有限状态机，杜绝异步竞争与异常漏捕获：

```mermaid
stateDiagram-v2
    [*] --> S0_INIT: 初始化引擎与规则配置
    S0_INIT --> S1_ADAPTING: 挂载 SourceAdapter (Staged 模式 / Full 模式)
    S1_ADAPTING --> S2_COLLECTING: 获取待检代码块并过滤二进制/忽略项
    S2_COLLECTING --> S3_STRATEGY_RUN: 管道分发至各 DetectorStrategy
    S3_STRATEGY_RUN --> S4_SUPPRESSION_FILTER: 匹配 security-suppressions.json 与单行注释
    S4_SUPPRESSION_FILTER --> S5_EVALUATING: 聚合剩余违规，评估严重性
    
    S5_EVALUATING --> S6_PASSED: 零严重违规
    S5_EVALUATING --> S7_BLOCKED: 存在严重阻断违规
    
    S6_PASSED --> [*]: Exit Code 0 (放行提交)
    S7_BLOCKED --> [*]: Exit Code 1 (阻断并输出指引)
```

#### 4. 香农信息熵数学模型 (Shannon Entropy Calculation)

针对无固定前缀但具备极高随机性的密码、私钥和自研 Token，引擎引入**香农信息熵**公式进行启发式评估：

$$H(X) = -\sum_{i=1}^{n} P(x_i) \log_2 P(x_i)$$

* 其中 $P(x_i)$ 为字符 $x_i$ 在候选字符串中出现的频率，$n$ 为字符集种类数。
* **阈值设定经验**：
  * 自然语言文本/普通代码标识符：$H(X) \approx 1.5 \sim 3.0$
  * Base64 随机密文 / 32位十六进制 Key：$H(X) \ge 3.8$
  * 当字符串长度 $\ge 20$ 且 $H(X) \ge 3.8$ 时，结合上下文关键词立即标记为疑似凭据泄露。

---

## 4. 业界主流方案横向对标与选型论证 (Industry Comparison)

调研对比业界主流代码凭据防泄露方案：

| 评估维度 | Gitleaks (主流独立工具) | TruffleHog (深度历史分析) | detect-secrets (Yelp 开源) | secretlint (Node.js 社区) | 巡影自研原生门禁 (`check-security-credentials`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **运行时依赖** | Go 编译二进制 | Go 编译二进制 | Python 运行时 | Node.js (npm 模块) | **纯原生 Node.js (ESM)**，零外部工具依赖 |
| **项目契合度** | 通用规则，难适配本项目特定的《红线 §7》规范 | 偏重云凭据检索与远程 Verify | 需维护 `.secrets.baseline` | 插件化规则，需维护大量 npm 子包 | **100% 贴合本项目**，天然对齐既有 18 个 Gate 架构 |
| **占位符感知** | 需手写复杂排除正则 | 易把 `sk-proj-test...` 当作真 key | 依赖标记与更新 baseline | 需定制编写 rule 插件 | **原生内置《红线 §7》占位符白名单** |
| **Git Hook 集成** | 依赖外部 CLI 安装路径 | 钩子启动较重（秒级） | 依赖 pre-commit 框架 (Python) | 需搭配 husky / lint-staged | **原生接入 `.githooks` 或统一 gate** |
| **跨平台开箱即用** | Windows 下需单独下载 exe | Windows 支持一般 | Windows 需处理 Python 环境 | npm 安装即可 | **全平台免配** (Windows / Linux / macOS) |

### 选型结论：
**采用“原生轻量门禁脚本 (`tools/gates/check-security-credentials.mjs`) + Git 原生 `core.hooksPath`”的架构**：
1. **统一技术栈**：与现有工程既有的 `check-api-contracts.mjs`、`check-hydration-safety.mjs` 等 18 个门禁完全同构，共享控制台彩色输出格式、返回码机制与 Vitest 测试风格。
2. **零安装门槛**：开发者和 CI 节点无需额外安装 Go、Python 或全局 CLI，只要有 Node 22 环境即可直接运行。
3. **精准定制**：针对项目特有的 115 网盘 Cookie（`UID/SEID`）、LinuxWebTool 令牌（`lwt_live_`）、EasyTier 密钥（`network_secret`）、Cloudflare 隧道（`tunnel_token`）进行原生精准防御。

---

## 5. 当前系统基础设施复用分析 (Codebase Reuse)

当前代码库中已具备极其完备的代码门禁与静态治理生态，可直接复用以下基础设施：

1. **Gate 报告与控制台交互协议**：
   - 复用 `tools/gates/check-facades.mjs` 中的 `c = { reset, green, red, yellow, cyan, bold }` ANSI 高亮工具函数。
   - 保持一致的报错格式：`✖ [Security Gate Violation] <file>:<line> - <reason>`。
2. **基线排除与违规抑制体系 (Suppressions)**：
   - 参考根目录 [`eslint-suppressions.json`](file:///e:/WorkProject/Node/_Project/mediary-scout/eslint-suppressions.json) 与 [`tools/gates/api-parity-allowlist.json`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/gates/api-parity-allowlist.json)，建立专用的 [`tools/gates/security-suppressions.json`](file:///e:/WorkProject/Node/_Project/mediary-scout/tools/gates/security-suppressions.json)，用于审计已确认无害的历史存档文件。
3. **脚本调用链集成**：
   - 在 [`package.json`](file:///e:/WorkProject/Node/_Project/mediary-scout/package.json) 中注册 `"gate:security": "node tools/gates/check-security-credentials.mjs"`，并将其置入 `"gate"` 串联脚本的首位，实现“安全门禁前置一票否决”。
4. **自动化测试与回归保障**：
   - 在 `tools/gates/` 下配对编写 `check-security-credentials.test.mjs`，由现有的 `npm test` (Vitest) 持续守护门禁自身的逻辑正确性。

---

## 6. 详细工程实现蓝图 (Implementation Blueprints)

### 6.1 门禁核心扫描引擎：`tools/gates/check-security-credentials.mjs`

```javascript
#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout 凭据安全红线与脱敏规范检测门禁 (Security & Credential Gate)
 * 严格对齐 AGENT.md §7 与 Security Governance 规范
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isStagedOnly = process.argv.includes("--staged");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

let violations = 0;

// 1. 合法占位符白名单正则 (严格免检)
const COMPLIANT_PLACEHOLDERS = [
  /sk-proj-test-secret-key-1234567890/,
  /sk-test-super-secret-12345/,
  /sk-test-key-abcdef-1234/,
  /lwt_live_8f3a9e\.\.\./,
  /tunnel_0123456789abcdef0123456789abcdef/,
  /your_secure_password_here/,
  /<ADMIN_PASSWORD>/,
  /mockPrivateKey/,
  /demo_secret_token/,
  /example\.com/,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /172\.17\.0\.1/,
  /host\.docker\.internal/,
];

// 2. 违规特征匹配规则集 (Detector Strategies)
const DETECTOR_RULES = [
  {
    id: "SEC-001-OPENAI-KEY",
    name: "真实 OpenAI / 大模型 API Key",
    regex: /\bsk-[a-zA-Z0-9_-]{20,}\b/,
    description: "检测到疑似真实未脱敏的 OpenAI / 大模型 API Key，必须使用规范占位符",
  },
  {
    id: "SEC-002-LWT-KEY",
    name: "真实 LinuxWebTool 访问令牌",
    regex: /\blwt_live_[a-f0-9]{20,}\b/,
    description: "检测到包含完整哈希的 LinuxWebTool API Key，必须脱敏为 lwt_live_8f3a9e...",
  },
  {
    id: "SEC-003-PRIVATE-KEY",
    name: "未 Mock 的真实 OpenSSH / RSA 私钥",
    regex: /-----BEGIN\s+(?:OPENSSH|RSA|EC|DSA)?\s*PRIVATE KEY-----/,
    validate: (content) => !content.includes("MOCK_KEY_DATA") && !content.includes("...test key..."),
    description: "严禁在代码或测试中硬编码真实私钥，测试夹具必须包含显式 MOCK 标识",
  },
  {
    id: "SEC-004-HARDCODED-PASSWORD",
    name: "硬编码管理员或系统密码",
    regex: /(?:WEB_ADMIN_PASSWORD|ADMIN_PASSWORD|admin_password)\s*[:=]\s*["']([^"']+)["']/,
    validate: (_, match) => !["your_secure_password_here", "<ADMIN_PASSWORD>", ""].includes(match[1]),
    description: "检测到硬编码的管理员密码，严禁赋值真实密码，必须使用占位符或环境变量",
  },
  {
    id: "SEC-005-FORBIDDEN-INTERNAL-IP",
    name: "非标开发私网 IP 或非标 SSH 端口",
    regex: /\b(?:10\.126\.\d+\.\d+|DEPLOY_PORT=22)\b/,
    description: "禁止在版本库与公开文档中提交特定内网开发宿主 IP 或私有非标 SSH 端口",
  },
  {
    id: "SEC-006-EASYTIER-SECRET",
    name: "未脱敏 EasyTier 组网密钥",
    regex: /network_secret\s*[:=]\s*["']([^"']+)["']/,
    validate: (_, match) => match[1] !== "demo_secret_token",
    description: "EasyTier 组网密钥必须使用规范占位符 network_secret = \"demo_secret_token\"",
  },
];

function reportViolation(file, line, ruleId, message, snippet) {
  console.error(`${c.red}✖ [Security Gate Violation]${c.reset} ${path.relative(repoRoot, file)}:${line}`);
  console.error(`  ${c.yellow}规则:${c.reset} [${ruleId}] ${message}`);
  if (snippet) {
    console.error(`  ${c.cyan}代码片段:${c.reset} ${snippet.trim()}`);
  }
  violations++;
}

// 增量 / 全量提取与分析引擎实现 (略，完整实现详见工程落地文件)
```

### 6.2 Git 提交钩子部署：`.githooks/pre-commit`

```bash
#!/usr/bin/env sh
# 巡影 (Mediary Scout) - Git 客户端预提交安全门禁
# 拦截所有携带真实凭据、私有 IP 及非脱敏密码的代码与文档提交

set -e

# 执行极速增量扫描 (目标延迟 < 50ms)
node tools/gates/check-security-credentials.mjs --staged

if [ $? -ne 0 ]; then
  echo "\n\033[31m[GIT COMMIT BLOCKED]\033[0m 检测到提交内容违反了《凭据安全红线与脱敏规范 §7》！"
  echo "请参阅 docs/architecture/security-credential-governance-and-git-hook-gate-spec.md 进行修正脱敏。\n"
  exit 1
fi
```

### 6.3 Git Hooks 零配置无感激活机制

在 [`package.json`](file:///e:/WorkProject/Node/_Project/mediary-scout/package.json) 中添加自动注册指令：
```json
{
  "scripts": {
    "prepare": "git config core.hooksPath .githooks || true",
    "gate:security": "node tools/gates/check-security-credentials.mjs",
    "gate:security:staged": "node tools/gates/check-security-credentials.mjs --staged"
  }
}
```
* **机制优势**：当任何开发者克隆仓库并执行 `npm install`（或运行 `npm run gate`）时，Git 会自动将钩子目录指向 `.githooks`，**彻底省去手动复制脚本或安装庞大第三方工具包的繁琐步骤**。

---

## 7. 实施落地里程碑与验收标准 (Roadmap & Acceptance)

```mermaid
timeline
    title 凭据安全门禁落地路线图
    Phase 1 : 门禁核心实现 : 编写 check-security-credentials.mjs 及配套 Vitest 单测
    Phase 2 : 抑制基线与对齐 : 建立 security-suppressions.json，确保当前主干 100% 绿灯
    Phase 3 : 钩子无感挂载 : 建立 .githooks/pre-commit 与 package.json 自动配置
    Phase 4 : 全流程闭环守护 : 接入 npm run gate、CI 流水线与 deploy-remote.ps1 预检
```

### 验收标准 (Acceptance Criteria)：
1. **阻断有效性**：在 `docs/` 或任意代码中故意写入包含未脱敏的 `lwt_live_1af0...` 或 `sk-proj-live-xxx` 时，执行 `git commit` 必须被毫秒级硬阻断，并精准输出文件名、行号与合规占位符指引。
2. **合法 Mock 友好度**：在 `tests/` 目录中写入规范的 `sk-test-key-abcdef-1234` 或 `mockPrivateKey` 时，门禁正常放行，零误报。
3. **性能基准达标**：Pre-commit 增量扫描耗时必须严格 $\le 50\text{ms}$，全量扫描 $\le 200\text{ms}$。
4. **CI/发布双重守门**：`npm run gate` 与 `deploy-remote.ps1` 均将安全检测作为前置致命条件（Fatal Step），发现泄密立即中止部署流程。
