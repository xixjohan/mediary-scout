# 自部署:docker compose 一把拉起

一行命令起整套:**web(Next + 进程内 worker)+ Postgres + 自带 PanSou**。

## 快速开始

```bash
git clone <repo> && cd media-track
docker compose up -d        # 首次会构建 web 镜像,几分钟
```

打开 `http://<你的主机>:3000`:
1. **设置 → 115 网盘**:扫码登录,cookie 持久化到数据库,后续自动转存。
2. 就这样。**TMDB 元数据经作者 CF Worker 开箱即用**(想用自己额度可在设置填 TMDB key);**PanSou 网盘搜索源已自带**。

## 想跑真实获取还需要

- **AI 模型**(设置 → AI 模型):填一个 OpenAI 兼容的 `baseURL / apiKey / modelId`——agent 靠它决策。不填则获取流程无法规划。
- **115 目录 CID**(`.env` 或环境变量):`TV_SHOWS_CID` / `MOVIES_CID` / `ANIME_CID` 等落盘父目录。

## 可选增强

- **自己的 TMDB key**(设置 → TMDB 元数据):直连你自己的额度,调不通自动回退作者代理。
- **Prowlarr**(设置 → 资源提供商):接入索引器聚合,磁力与 PanSou 结果合并、走 115 秒传。
- **换 PanSou 实例**(设置 → 资源提供商):默认用 compose 自带的;想指向别的实例/公共域名在此手填。

## 组成 / 端口

| 服务 | 镜像 | 说明 |
|---|---|---|
| `web` | 本仓库 `Dockerfile` | Next.js + 进程内 worker(`instrumentation.ts` 自启),`:3000` |
| `postgres` | `postgres:16-alpine` | 持久卷 `pgdata`;表首次查询自建,无需迁移 |
| `pansou` | `ghcr.io/fish2018/pansou-web` | 网盘搜索源,compose 内经服务名 `http://pansou` 调用 |

## 覆盖配置

`docker-compose.yml` 的 `environment:` 已设好库连接、PanSou 地址、adapters。要覆盖额外项(TMDB/115 cookie/LLM/Prowlarr/CID),在仓库根放 `.env`(参照 `.env.example`)——compose 会自动加载(缺失也无妨)。

## 注意

- 本项目只走**自部署**,作者不托管(见 `docs/distribution-and-legal-positioning.md`)。别在公网裸暴露 `:3000`(无鉴权;多用户/登录是 roadmap §7)。
- 升级:`git pull && docker compose up -d --build`。
