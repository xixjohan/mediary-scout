# 在线更新日志溯源剖析与版本校准方案

## 一、问题背景

在设置页「系统更新」面板中，用户反馈：
> **“为什么看到的还是原仓库更新记录？”**

在更新日志中，最新版本 `v2026.10.29` 显示的内容为：
- *新增 多网盘统一协作获取与统一媒体库*
- *新增 六大网盘实时剩余空间感知与超额保护*
- *新增 支持连接 UC 网盘*
- *新增 光鸭云盘支持手机 App 扫码登录*
- *新增 支持配置海搜（Haisou）官方 API 作为补充搜索源*

上述功能均为原上游仓库（`fancydirty/mediary-scout`）在自身分支上的迭代内容，而非当前仓库 `xixjohan/mediary-scout` 在 `mediary` 分支上实际研发的功能（三层设计令牌、全站样式门禁、网盘文件管理中心、智能影视助手 AI Agent 等）。

---

## 二、深度根因分析（Root Cause Analysis）

```
[Git 拓扑分叉示意图]

           (分叉点)
           v2026.10.22 (d82242c7)
                /            \
               /              \
 (原仓库上游分支)               (当前仓库 mediary 分支)
  f5df3350...                  c79c8c07 (默认分支 mediary 分家)
  34c482b0 (原上游 commit)      70+ commits (令牌/网盘管理/智能助手...)
  [tag: v2026.10.29]           0572967d (当前 HEAD)
  (写着 UC网盘/海搜API)         (尚未被打上属于自己的发布 Tag)
```

1. **Git Tag 的不可变快照属性**：
   - Git Tag 是指向特定提交 SHA 的快照指针。
   - 本地 Git 仓库最初克隆时，同步了上游所有历史标签，其中包括上游作者于 2026-10-29 01:26 提交并打标的 `v2026.10.29`（指向提交 `34c482b0`）。
2. **两路分支的历史分叉（Divergence）**：
   - 本仓库在 `v2026.10.22` 之后，于 `c79c8c07` 开始在 `mediary` 分支独立演进，进行了包括纯 SQLite、API Key 鉴权、设计令牌、网盘文件管理、智能聊天助手的研发；
   - 而原仓库在 `main` 分支演进，两分支在 `v2026.10.22` 之后并无任何交集。
3. **标签推送引发的“旧瓶装旧酒”**：
   - 上一轮为了解决“暂时查不到新版本”问题，执行了 `git push origin --tags`；
   - 本地未做清洗的 `v2026.10.29`（指向原上游提交 `34c482b0`）被直接推送到了 `xixjohan/mediary-scout`；
   - 同时，本地 `mediary` 分支当时并未创建属于自己的 `release-notes/v2026.10.29.md`。
4. **GitHub 内容 API 的拉取链路**：
   - 更新面板通过 `apps/web/lib/release-feed-server.ts` 调用：
     `https://api.github.com/repos/xixjohan/mediary-scout/contents/release-notes/v2026.10.29.md?ref=v2026.10.29`
   - GitHub API 根据 `ref=v2026.10.29` 取出的正是提交 `34c482b0` 中的文件，内容完全是原上游的功能说明。
5. **版本对比状态分歧（Diverged）**：
   - 当前正在运行的提交（HEAD）位于 `mediary` 分支；
   - 而 GitHub 上的 `v2026.10.29` 位于上游分支；
   - GitHub compare API 比较两节点时结果为 `diverged`，导致界面无法识别出“已是最新版本”，而是显示“无法确认是否最新”。

---

## 三、架构优化与解决方案

### 1. 规范化本仓库专属 Release Notes
依据项目规范（每行以 `新增`、`改进`、`修复` 开头），在 `release-notes/v2026.10.29.md` 中真实记录本仓库专属核心功能：
- **新增** 三层设计令牌与全站样式门禁，网盘管理与全系统界面规范统一
- **新增** 网盘文件管理中心，支持目录树文件浏览、增删查改、重命名与批量复制移动
- **新增** 智能影视助手，支持对话交互、思考卡片与工具调用展示、Markdown 渲染与一键入库
- **新增** 订阅与待处理工作流分离，支持无追踪作品资源深度探测与自定搜索关键词
- **改进** 网盘凭据解密失败防雪崩熔断，单盘异常不拖垮设置页与活动流
- **修复** 活动页后台任务可见性与存储范围隔离，任务状态实时可见可取消
- **修复** 影视详情页获取进度弹窗层级遮挡问题
- **改进** 在线更新全链独立解耦，支持多级 Commit 解析与本地优先更新日志

### 2. 双轨策略模式（Strategy Pattern）与优雅降级（Graceful Degradation）
在 `apps/web/lib/release-feed-server.ts` 中实现本地与远端双轨解析机制：
```mermaid
flowchart TD
    A[获取指定 Tag 的 Release Notes] --> B{GitHub API 是否返回内容?}
    B -->|是| C[解析 GitHub 远端 Markdown]
    B -->|否/超时/限流| D{运行环境为服务自身且本地存在文件?}
    D -->|是 (Local Fallback)| E[读取本地 release-notes/v*.md]
    D -->|否| F[安全返回空列表 []]
    C --> G[展示规范更新日志卡片]
    E --> G
```

### 3. Git Tag 拓扑校准
1. 在 `mediary` 分支提交本仓库的 `release-notes/v2026.10.29.md` 与功能代码；
2. 将轻量标签 `v2026.10.29` 强制重新打在当前分支 HEAD 上（`git tag -f v2026.10.29 HEAD`）；
3. 强制推送标签至 `origin`：`git push origin -f refs/tags/v2026.10.29`；
4. 使得 GitHub API 获取到的 Tag 提交 SHA 与当前分支完全一致，Compare 状态收敛为 `identical`（已是最新版本）。

---

## 四、单元测试与门禁验证

1. **单元测试覆盖**：
   - `apps/web/lib/release-feed-server.test.ts` 新增「支持本地发布日志优先/降级读取」用例（26/26 全部通过）。
2. **样式与类型门禁**：
   - `npm run gate`（布局、依赖架构、89 个设计令牌校验、ESLint 0 警告、TypeScript 0 错误）。
