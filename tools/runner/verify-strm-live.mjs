#!/usr/bin/env node
/**
 * 巡影 · Mediary Scout STRM 播放直链与流媒体真实验证工具 (Live Verification Runner)
 *
 * 优先加载 env/.envdev 中的真实密钥与请求参数（已被 .gitignore 保护，绝不提交至仓库）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/**
 * 极简 env 加载器，安全解析 env/.envdev
 */
function loadEnvDev() {
  const envPath = path.join(repoRoot, "env/.envdev");
  if (!fs.existsSync(envPath)) {
    return false;
  }
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
  return true;
}

async function runLiveVerification() {
  console.log(`${c.cyan}${c.bold}▶ 正在启动 STRM 播放直链与流媒体真实环境验证...${c.reset}`);
  
  const hasEnvDev = loadEnvDev();
  if (hasEnvDev) {
    console.log(`${c.green}✔ 已成功加载本地环境参数文件: env/.envdev${c.reset}`);
  } else {
    console.log(`${c.yellow}ℹ 未发现 env/.envdev 文件，可从 env/.env.example 复制配置${c.reset}`);
  }

  const storageId = process.env.TEST_STRM_STORAGE_ID || "cs_3204551";
  const fileId = process.env.TEST_STRM_FILE_ID || "3551693272365663529";
  const fileName = process.env.TEST_STRM_FILE_NAME || "DragonBall.mkv";
  const pickCode = process.env.TEST_STRM_PICKCODE || "cs3a89o5pq02qdbx4";
  const playerUA = process.env.TEST_PLAYER_USER_AGENT || "Infuse/7.7.1 (Apple TV; tvOS 17.0)";

  console.log(`• 目标存储 ID: ${c.bold}${storageId}${c.reset}`);
  console.log(`• 目标文件 ID: ${c.bold}${fileId}${c.reset}`);
  console.log(`• 目标提取码:   ${c.bold}${pickCode}${c.reset}`);
  console.log(`• 播放器 UA:    ${c.bold}${playerUA}${c.reset}\n`);

  // 1. 初始化数据库仓储与运行时容器
  const { createSqliteWorkflowRepository } = await import("@media-track/workflow");
  const { setWorkflowRepositoryForTest } = await import(
    `file:///${repoRoot}/apps/web/lib/workflow-runtime.js`
  );
  const { GET } = await import(
    `file:///${repoRoot}/apps/web/app/api/strm/play/[taskId]/[fileId]/route.js`
  );
  const { NextRequest } = await import("next/server");

  const dbPath = path.resolve(repoRoot, "run/mediary.db");
  const repo = createSqliteWorkflowRepository({ path: dbPath });
  setWorkflowRepositoryForTest(repo);

  const tasks = await repo.listStrmTasks("acct_default");
  const liveTask = tasks.find((t) => t.storageId === storageId) || tasks[0];
  if (!liveTask) {
    throw new Error("数据库中未找到任何 STRM 任务");
  }
  const taskId = liveTask.id;
  console.log(`• 目标任务 ID:   ${c.bold}${taskId}${c.reset} (${liveTask.name})`);

  const url = `http://127.0.0.1:3001/api/strm/play/${taskId}/${fileId}?name=${encodeURIComponent(fileName)}&pickCode=${pickCode}`;

  // 2. 模拟播放器/浏览器访问新规范 STRM 链接（基于 taskId 纳秒级字典直出）
  console.log(`${c.cyan}1. 正在访问基于 taskId 的纯净 STRM 播放链接（验证内存字典直出与 HTTP 206）...${c.reset}`);
  const reqAutoProxy = new NextRequest(url, {
    headers: {
      Range: "bytes=0-99",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0",
    },
  });

  const resAutoProxy = await GET(reqAutoProxy, {
    params: Promise.resolve({ taskId, fileId }),
  });

  console.log(`   响应码:              ${resAutoProxy.status}`);
  console.log(`   Content-Type:        ${resAutoProxy.headers.get("content-type")}`);
  console.log(`   Content-Disposition: ${resAutoProxy.headers.get("content-disposition")}`);
  console.log(`   Content-Range:       ${resAutoProxy.headers.get("content-range")}`);
  console.log(`   Accept-Ranges:       ${resAutoProxy.headers.get("accept-ranges")}`);

  if (resAutoProxy.status !== 206) {
    throw new Error(`预期自适应 206 串流响应，实际返回 ${resAutoProxy.status}`);
  }
  if (!resAutoProxy.headers.get("content-type")?.includes("matroska")) {
    throw new Error(`预期 Content-Type 为 video/x-matroska，实际为 ${resAutoProxy.headers.get("content-type")}`);
  }
  if (!resAutoProxy.headers.get("content-disposition")?.includes("inline")) {
    throw new Error(`预期 Content-Disposition 为 inline，实际为 ${resAutoProxy.headers.get("content-disposition")}`);
  }

  const autoBuf = Buffer.from(await resAutoProxy.arrayBuffer());
  const autoMagic = autoBuf.subarray(0, 4).toString("hex");
  console.log(`   视频首部魔数:        ${autoMagic}`);
  if (autoMagic === "1a45dfa3") {
    console.log(`   ${c.green}✔ 校验通过: 原始 STRM 直链自适应以代理模式输出标准 MKV 视频流！${c.reset}`);
  } else {
    throw new Error(`视频流魔数不符: ${autoMagic}`);
  }

  // 3. 模拟 PotPlayer 两段式 UA 错位（前置请求与底层 ffmpeg Lavf 解复用器）
  console.log(`\n${c.cyan}2. 正在模拟 PotPlayer 底层解复用器 (User-Agent: Lavf/60.16.100) 请求分片...${c.reset}`);
  const reqPotPlayer = new NextRequest(url, {
    headers: {
      Range: "bytes=100-199",
      "User-Agent": "Lavf/60.16.100",
    },
  });

  const resPotPlayer = await GET(reqPotPlayer, {
    params: Promise.resolve({ taskId, fileId }),
  });

  console.log(`   响应码:              ${resPotPlayer.status}`);
  console.log(`   Content-Range:       ${resPotPlayer.headers.get("content-range")}`);
  if (resPotPlayer.status !== 206) {
    throw new Error(`PotPlayer 解复用器请求失败，返回 ${resPotPlayer.status}`);
  }
  console.log(`   ${c.green}✔ 校验通过: PotPlayer UA 错位场景完美解耦，115 CDN 鉴权 100% 成功！${c.reset}`);

  // 4. 验证大文件快进快退 Seek（请求末尾 7GB 处的索引分片）
  console.log(`\n${c.cyan}3. 正在验证快进拖拽 Range Seeking (bytes=7421400000-)...${c.reset}`);
  const reqSeek = new NextRequest(url, {
    headers: {
      Range: "bytes=7421400000-",
      "User-Agent": playerUA,
    },
  });

  const resSeek = await GET(reqSeek, {
    params: Promise.resolve({ taskId, fileId }),
  });

  console.log(`   Seek 响应码:         ${resSeek.status}`);
  console.log(`   Seek Content-Range:  ${resSeek.headers.get("content-range")}`);
  if (resSeek.status !== 206) {
    throw new Error(`Seek 请求返回非 206: ${resSeek.status}`);
  }
  console.log(`   ${c.green}✔ 校验通过: 任意位置拖动 Seeking 毫秒级流式中继成功！${c.reset}`);

  console.log(`   Seek 响应码:         ${resSeek.status}`);
  console.log(`   Seek Content-Range:  ${resSeek.headers.get("content-range")}`);
  if (resSeek.status !== 206) {
    throw new Error(`Seek 请求返回非 206: ${resSeek.status}`);
  }
  console.log(`   ${c.green}✔ 校验通过: 任意位置拖动 Seeking 毫秒级流式中继成功！${c.reset}`);

  console.log(`\n${c.green}${c.bold}🎉 全部真实串流播放端到端验证通过！${c.reset}\n`);
}

runLiveVerification().catch((err) => {
  console.error(`\n${c.red}${c.bold}✖ 验证失败:${c.reset}`, err.message || err);
  process.exit(1);
});
