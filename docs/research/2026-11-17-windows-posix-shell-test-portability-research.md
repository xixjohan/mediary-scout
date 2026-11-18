# Windows 下 `apps/updater` 的 12 条测试失败：根因、跨平台适配与同类门禁

- 日期：2026-11-17
- 状态：**已修复**（`apps/updater` 4 个测试文件，57 + 13 + 7 用例全绿；CI 仍跑 ubuntu，不降覆盖）
- 触发：`npx vitest run` 在 Windows 上 12 条红（`tunnel-env.test.mjs` 5 条、`run-update.test.mjs` 7 条），
  单跑 `apps/updater` 复现，耗时 555 秒。
- 附加要求：头脑风暴可行性/逻辑/性能欠缺；评估适配器策略与状态机；查现成库与业界方案；确认本仓已有基础设施可复用；写入 docs。

---

## 1. 结论先行

**这 12 条红不是「Windows 上不该跑」，而是「测试自己在 Windows 上跑错了对象」。**

| # | 现象 | 本质 | 定位 |
| --- | --- | --- | --- |
| 1 | `expected 438 to be 384`（5 条，全部是 `.mode & 0o777` 断言） | Windows **没有 POSIX 权限位**：`chmod 0600/0640` 实测都落成 `0o666`，`0000` 仍可读 | 平台不可验证，非缺陷 |
| 2 | 12 条中的 7 条随机退出码 / 60s 超时 | 桩目录用 `${bin}:${PATH}` 拼，`bin` 是 `E:\...` → shell 按 `:` 切分拿到 `E`、`\Work...` 碎片 → **桩目录不可见，测试实际调宿主机真 `docker`/`git`** | **真实缺陷（测试基础设施）** |
| 3 | H1 探针 `Cannot read properties of undefined (reading 'trim')` | 探针脚本没有 `.sh` 后缀，`spawnSync(probe)` 在 Windows 报 `EFTYPE`（无 shebang 执行关联） | 启动方式错误 |
| 4 | `v2026.10.02\nx` 被当成合法 tag（`code: 0` 而非 `2`） | Windows 的 argv 编码在换行处**截断**，shell 只收到 `v2026.10.02` —— 输入根本没送达 | OS 限制，构造不出输入 |
| 5 | 修 PATH 后仍有 60s 超时 | 超时是按 Linux 派生成本定的；Windows 每次派生 ~35ms，「180 次健康轮询」用例实测 100–165 秒 | 阈值不匹配，非语义问题 |

**一句话根因**：`apps/updater` 的测试是**为 POSIX 写的**（真跑 `.sh`、断言权限位、直接 exec 脚本），
而此前没有任何一层把「哪些是平台不可验证、哪些是测试自己写错了」分开——于是两种红混在一起，
看起来像「Windows 不支持这个模块」。

---

## 2. 逐条根因（实测证据）

### 2.1 PATH 拼接（最隐蔽的一条）

```js
// 修复前
PATH: `${bin}:${process.env.PATH ?? ""}`,   // bin = E:\Users\hlr\AppData\Local\Temp\run-update-X\bin
```

Git-Bash 的 `sh` 按 `:` 切分 PATH，`E:\Work...` 被切成 `E`、`\Work...` 两段 → 桩目录里的
`docker`/`git`/`wget` 全部不可见。实测：

```
current (win path + :) -> 0 | ... 跑的是宿主机真实 docker
patched (posix path + :) -> 0 | /c/Users/hlr/.../bin/docker STUB_DOCKER
```

**这才是 7 条随机失败的真正原因**——不是「Windows 不支持」，而是「打桩的测试跑到了真命令上」，
所以有时恰好成功、有时撞上真 docker 的退出码或超时。

### 2.2 shell 可执行文件的选择（修了 2.1 之后才暴露的第二层）

自然的第一反应是「Windows 就显式用 `C:\Program Files\Git\bin\sh.exe`」。**这是错的**：

```
===  C:\Program Files\Git\bin\sh.exe
PATH_HEAD=/mingw64/bin          ← 它把 mingw64 插到 PATH 最前面
/mingw64/bin/git                ← 真实的 git 压过桩
===  sh（走 PATH）
PATH_HEAD=/c/Users/.../bin      ← 我们前置的桩目录保住了
/c/Users/.../bin/git            ← 桩生效
```

所以适配层**故意只给裸 `"sh"`**，并把这条写成断言（`SH_BIN` 必须是裸命令名）。

### 2.3 直接执行 `.sh`

```
direct .sh exec -> status null err EFTYPE     ← Windows 没有 shebang 执行关联
via sh          -> status 0 stdout "ok"
```

同一写法在 `tools/parity/update-source-parity.test.mjs` 里已经是对的（它显式走 `shBin`），
`apps/updater` 的 H1 探针漏了——**同一个仓里两处同题写法不一致，其中一处必错**。

### 2.4 argv 换行

```
node: spawnSync('sh', ['-c','printf %s "$1"','sh','v2026.10.02\nx'])
argv carried: "v2026.10.02"     ← 换行之后的 x 丢了
```

脚本本身的换行拒绝分支是**正确的**（`case "$1" in *"<换行>"*) return 1`，单独探针验证通过）。
所以这不是脚本缺陷，而是「测试构造不出这个输入」。

### 2.5 超时阈值

| 用例 | Linux（CI） | Windows（实测） |
| --- | --- | --- |
| `exits 20 when the rollback never verifies either`（180 次轮询） | 秒级 | 102–165 秒 |
| `reaches the rollback-failed state…` | 秒级 | 52 秒 |
| 整个 `run-update.test.mjs` | 秒级 | 578 秒 |

Windows 上 `sh` 每次派生 ~35ms，而该脚本一轮要派生 compose/cat/git 多次。60_000 的套件超时
是给 Linux 的，**不是语义**——所以按平台给：Windows 300s，Linux 保持 60s。

### 2.6 POSIX 权限位

```
writeFileSync(f, { mode: 0o600 }) -> 666
chmodSync(f, 0o640)              -> 666
chmodSync(f, 0o000)              -> 444，且仍可读
```

Windows 的 ACL 与 POSIX 位不是一一映射；`chmod` 只影响只读属性。**这些断言在 Windows 上不可验证**，
删掉是丢防线（Linux/CI 上它们真的在守「备份不能带 group/other 位」这条安全红线）。

---

## 3. 业界主流做法对比

| 方案 | 做法 | 适用性判断 |
| --- | --- | --- |
| **Vitest `describe.skipIf` / `it.skipIf`** | 条件为真时整块跳过 | 官方推荐做法，但**粒度太粗**：这里 12 条里只有 6 条属于「平台不可验证」，另 6 条是真缺陷。整块跳过会把真缺陷也藏起来 |
| **`test.skip` + 注释** | 逐条跳过 | 同上的粗粒度问题；且注释会腐烂（「为什么跳过」半年后就没人知道） |
| **Jest `testPathIgnorePatterns`** | 整个目录排除 | 等于「Windows 不测 updater」，**CI 之外零覆盖**，最差选项 |
| **`.gitattributes` `eol=lf`** | 保证检出的 `.sh` 是 LF | **本仓已有**，但只影响 git 操作；本次观察到的 `w/crlf` 是本地工作区状态（`core.autocrlf=true`），不是提交进去的 |
| **CI 只在 Linux 跑** | 把平台差异留给 CI | 本次已如此（`runs-on: ubuntu-latest`），但**本地开发需要能跑**，否则每次改 updater 都要等 CI |
| **平台无关的测试适配层**（本次采用） | 一个 `test-support/posix-shell.mjs`：PATH 形态、shell 选择、超时、两个「不可验证」谓词；测试文件只消费它 | 粒度正确：真缺陷修掉、不可验证的显式裁决、**每条都要说清为什么** |

**结论**：业界常见的「Windows 就 skip」在**本例不成立**——12 条里有 6 条是真缺陷（桩根本没生效），
skip 掉等于把「测试一直在跑真 docker」这个事实永久藏起来。正确做法是**先修基础设施，再对剩下真正
不可验证的 6 条做显式裁决**。

参考：[Vitest `describe.skipIf`](https://vitest.dev/api/describe)（官方 API）、
[Node `fs` 文档](https://nodejs.org/api/fs.html)（`mode` 在 Windows 上的限制）、
[cross-platform-node-guide: permissions](https://github.com/ehmicky/cross-platform-node-guide/blob/main/docs/5_security/permissions.md)
（Windows 用 ACL 而非 POSIX 位）。

---

## 4. 现有库与基础设施复用（零新依赖）

| 需要 | 复用什么 | 新增依赖 |
| --- | --- | --- |
| 条件跳过 | `vitest` 已有；本次改用「谓词函数 + if」，粒度更细 | 无 |
| shell 启动 | 仓内已有先例：`tools/parity/update-source-parity.test.mjs` 的 `shBin` 解析 | 无 |
| LF 约束 | 已有 `.gitattributes`（`*.sh text eol=lf`） | 无 |
| CI 平台 | 已有 `ubuntu-latest`（`check-api-contracts` 等门禁也在那儿跑） | 无 |
| 平台判定 | 仓内已有先例：`credential-crypto.test.ts`、`sqlite-file-integration.test.ts` 的 `process.platform !== "win32"` | 无 |

**结论：零新依赖，只新增一个测试支撑模块。**

---

## 5. 具体方案

### 5.1 `apps/updater/test-support/posix-shell.mjs`（新增，唯一新增文件）

导出六个东西，每个都带「为什么」：

| 导出 | 作用 |
| --- | --- |
| `SH_BIN = "sh"` | **故意不用 Git 绝对路径**（它会重置 PATH 头部让桩失效，见 §2.2） |
| `pathWithStubs(bin, base)` | Windows 上把桩目录转 `/e/...` 形态再前置；基础 PATH 原样（shell 自己翻译 `;`） |
| `toPosixPath(p)` | `E:\a\b` → `/e/a/b` |
| `SHELL_SUITE_TIMEOUT_MS` | Windows 300s / 其它 60s（派生成本差异，不是语义） |
| `posixModeAssertable()` | Windows 上 `false`（chmod 被忽略） |
| `argvCarriesNewlines()` | Windows 上 `false`（argv 在换行处截断） |

### 5.2 测试文件的三处改动（不删任何断言语义）

1. **PATH**：`PATH: pathWithStubs(bin)`（原来手拼 `${bin}:${...}`）。
2. **启动**：`spawn(SH_BIN, [SCRIPT, ...])`、H1 探针 `spawnSync(SH_BIN, [probe])`。
3. **不可验证断言显式裁决**：
   - `tunnel-env.test.mjs` 新增 `expectMode(path, mode)` 小助手——Windows 上直接 return，
     Linux 上照旧断言；并把「为什么」写在文件头。
   - `run-update.test.mjs` 的备份权限位断言改成 `if (posixModeAssertable()) { 原断言 } else { 断言文件非空 }`；
     带换行的 tag 枚举项在 Windows 上 `continue`（输入构造不出来，脚本分支由 CI 覆盖）。

### 5.3 为什么不改脚本

`run-update.sh` 一个字节都没改（工作区只是把 CRLF 规范成 LF，与索引内容一致）。
脚本的换行拒绝分支实测是正确的，问题全在测试侧。

---

## 6. 同类门禁（防止这类缺陷换处复发）

新增 `apps/updater/test-support/posix-shell.test.mjs`，三条**静态扫描**：

| 门禁 | 守什么 |
| --- | --- |
| 不得再用 `` `${bin}:${process.env.PATH}` `` | 桩目录前缀只能经 `pathWithStubs`；手拼就是 §2.1 复发 |
| 不得直接 `spawn/spawnSync(<变量>, [...])` | 第一参数必须是 `SH_BIN` 或字面 `"sh"`；否则 Windows `EFTYPE` |
| `statSync(...).mode & 0o777` 裸断言必须伴随 `posixModeAssertable` | 否则 Windows 上报的是「平台差异」而不是「逻辑缺陷」 |

外加一条自检：`SH_BIN` **必须**是裸 `"sh"`（绝对路径的 Git sh 会重置 PATH 头部）。

---

## 7. 验证结果（Windows 11，Node 26，vitest 4.1.8）

| 套件 | 修复前 | 修复后 |
| --- | --- | --- |
| `apps/updater/tunnel-env.test.mjs` | 5 failed / 8 passed | **13 passed** |
| `apps/updater/run-update.test.mjs` | 7 failed（含 1 条 60s 超时） | **57 passed**（578s，全绿） |
| `apps/updater/test-support/posix-shell.test.mjs` | —（新增） | **7 passed** |
| `apps/updater/server.test.mjs` | 一直绿 | 未触碰 |

**CI 不受影响**：`ubuntu-latest` 上 `SHELL_SUITE_TIMEOUT_MS = 60_000`、`posixModeAssertable() = true`、
`argvCarriesNewlines() = true` —— 所有断言语义与修复前**逐条相同**，没有一条被放宽。

---

## 8. 明确不做

- **不在 Windows 上整块跳过**：12 条里有 6 条是真缺陷（桩未生效），skip 会把事实藏起来。
- **不为 Windows 改脚本行为**：脚本跑在 Linux 容器里，Windows 只是测试宿主。
- **不删 POSIX 权限断言**：那是「备份不得带 group/other 位」的安全红线，删掉等于在 Linux/CI 上少一道防线。
- **不引入 `cross-env` / `shx` / `shelljs` 等依赖**：一个 30 行的适配模块足够，且能带门禁。
- **不把可验证的部分也 skip**：标签校验、备份、锁、回滚顺序、更新源推导在 Windows 上全部真实通过（57 条）。
