# free-model-gateway 设计规格

日期：2026-10-11
状态：已与用户确认（对话内逐项决策已获批准）

## 1. 目标

把 GitHub 项目 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（下称 OFM）里可用的免费模型提出来，集在一个统一 API 里，对外可访问：

- 匿名免费车道（OpenCode Zen 网关，零登录）
- Kilo 免费池（kilo.ai，零登录）
- 13 个账号渠道（CodeArts / CodeBuddy / WorkBuddy / LobsterAI / Qoder / Qoder 中国版 /
  TRAE / Cline / Loomy / Raccoon / MiniMax Code / ZCode / Gemini）+ EAC 渠道
- 全部通过一个 OpenAI 兼容端点（`/v1/models`、`/v1/chat/completions`、`/v1/responses`）暴露

不是做 dsh 插件——产品形态是**独立 API 服务 + 反向代理**。

## 2. 已确认的决策

| 决策点 | 选择 |
|---|---|
| GitHub 仓库 | `A12384327/free-model-gateway`（Private） |
| 渠道范围 | 全渠道聚合（匿名 + Kilo + 13 账号渠道 + EAC） |
| 对外端口 | 8123 |
| 部署目标 | 腾讯云轻量应用服务器（OrcaTerm 网页终端操作，不使用 SSH） |
| 部署方式 | Docker |

## 3. 关键事实（全部实测验证）

1. OFM 仓库自带 `packages/standalone` 独立服务：无需 DSH，提供 OpenAI 兼容 API + 中文网页管理端。
2. standalone 强制绑定回环地址（`service.mjs` 中 `isLoopbackHost` 检查），运行时不可配置为 0.0.0.0。
3. `/v1/*` API 面只验 Bearer Key，无 Host/Origin 围栏——反代友好。
4. 管理面（`/` 与 `/api/management/*`）有结构化围栏：Host 必须回环 + Origin/Referer 忁须同源匹配，直接反代会 403。
5. 运行时零 npm 依赖（`web/` 是预构建产物）；渠道隔离用 Node 原生 worker_threads。
6. 强制从完整仓库运行（standalone 的 `service.mjs` 通过相对路径 `import '../../src/*'`）——不能只复制 standalone 目录。
7. 本机实测（2026-10-11）：28 个免费模型列出，非流式 + 流式（含 reasoning 帧）真实推理成功，零登录。
8. GitHub 凭据：账号 A12384327（PAT 可建仓、可推送、可删除仓库内容）。
9. 本机无 Docker CLI——镜像构建只能在服务器端完成（服务器上装 Docker）。

## 4. 架构

```
外网浏览器 / 任意 OpenAI 客户端
        │  http://<公网IP>:8123
        ▼
┌─ Docker 容器（单容器双进程，共享网络命名空间）─────┐
│                                                    │
│  nginx (0.0.0.0:8123)                              │
│   ├── /v1/*             → 直通（不改头，Bearer Key）│
│   ├── /api/management/* → 改写 Host→127.0.0.1:18900 │
│   └── /                → 管理页（头部改写，防 403）  │
│       proxy_pass → http://127.0.0.1:18900          │
│                                                    │
│  ofm standalone (127.0.0.1:18900，回环绑定)         │
│   ├── 匿名免费车道（OpenCode Zen，零登录）          │
│   ├── Kilo 免费池（零登录）                         │
│   ├── 13 账号渠道 + EAC（管理页登录后解锁）         │
│   └── OFM_HOME=/data（数据卷持久化）                │
│                                                    │
│  volume: /data → API Key、渠道凭据、统计            │
└────────────────────────────────────────────────────┘
```

### 组件

**单容器双进程**（基于 `node:22-alpine`，包管理器安装 nginx）：

- 入口：`node packages/standalone/cli.mjs --port 18900 --data-dir /data`
- `OFM_HOME=/data`，数据卷持久化（API Key、渠道凭据、统计）
- 不修改上游代码——`isLoopbackHost` 强制回环是这个服务的安全设计，我们用反代解决暴露问题
- 健康检查：`GET /health`
- restart: unless-stopped

**nginx 进程**（同一容器内）：

- 监听 `0.0.0.0:8123`
- `/v1/*` 直通：不改写任何头（API 面无围栏，Bearer Key 鉴权）
- 管理面改写：`Host: 127.0.0.1:18900`，删除 `Origin`/`Referer`/`sec-fetch-site`
  （管理面围栏要求 Host 回环 + Origin/Referer 同源匹配；删除后 structurally 豁免空值）
- SSE 关键配置：`proxy_buffering off` + `proxy_read_timeout 3600s`
- 文件 `nginx.conf`
- restart: unless-stopped（entrypoint 负责进程守护与退出清理）

### 数据流

1. 客户端从公网以 Bearer Key 访问 `http://IP:8123/v1/chat/completions`
2. nginx 转发到同容器网络命名空间的 `127.0.0.1:18900`（ofm 绑定回环，符合其安全模型）
3. ofm 收到请求 → Bearer Key 校验 → 路由到对应车道
4. ofm 出网到上游（opencode.ai / kilo.ai / 渠道端点），流式回传
5. nginx 关闭缓冲直通 SSE

管理页面的访问路径：浏览器打开 `http://IP:8123/` → nginx 改写 Host 头并剥离 Origin/Referer → ofm 管理围栏放行 → 登录页加载，用启动日志里的一次性链接或 forwardKey 登录。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| ofm 未启动完成 | nginx 502；`/health` 可探测；docker restart 策略自动拉起 |
| 上游 429 限流 | ofm 原生处理（退避 + 标记限额）|
| 上游 SSE 静默期 | ofm 内置 15s 心跳注释帧，nginx 不缓冲 |
| Key 轮换 | 网页管理端可轮换；旧 Key 立即失效 |
| 容器重启 | 数据卷持久化 Key 与凭据，Key 不变 |
| 管理面误公网暴露 | Nginx 对管理路径的头部改写是“让它能用”，不是“安全边界”——管理面本身有 Key/会话鉴权；如需更强，可在 nginx 层加 Basic Auth（本期不做） |

## 6. 测试与验收标准

服务器部署后逐项验收：

1. `docker compose ps` 单容器 running（healthy）
2. `curl http://127.0.0.1:8123/health` → 200
3. `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:8123/v1/models` → 28+ 模型
4. 非流式对话：`POST /v1/chat/completions`（mimo-v2.6-flash-free）→ 200 + content
5. 流式对话：同上 + `"stream": true` → SSE 帧正常到达
6. 公网访问：外网浏览器打开 `http://<公网IP>:8123/` → 登录页正常加载（管理页头部改写生效，无 403）
7. 公网 API：外网 curl 对话成功
8. `docker compose logs` 无异常
9. Restart 容器 → Key 与渠道凭据保留（数据卷生效）

## 7. 交付物清单

| 交付物 | 位置 |
|---|---|
| GitHub 仓库 | `https://github.com/A12384327/free-model-gateway`（Private）|
| Dockerfile（单容器双进程）| 仓库根 `Dockerfile` |
| docker-compose.yml | 仓库根 |
| nginx.conf | 仓库根 `nginx/` |
| 部署文档 | `README.md`（部署步骤、防火墙放行说明、Key 获取方式）|
| 部署脚本 | `scripts/deploy.sh`（服务器端一键执行）|
| 设计文档 | `docs/specs/2026-10-11-free-model-gateway-design.md`（本文件）|

## 8. 服务器端部署流程（OrcaTerm）

1. 用户打开 OrcaTerm 链接，我通过浏览器工具驱动网页终端
2. 检查 Linux 发行版、Docker 是否安装 → 未安装则先安装 Docker（服务器在首尔 region，用腾讯云海外内网镜像源加速）
3. 获取项目代码：私有仓库 → 优先用 GitHub API 临时嵌入 PAT 的方式一次性下载 release tarball，不在服务器上持久化任何凭据
4. `docker compose up -d --build`
5. `docker compose logs` 观察启动
6. 验收测试（见第 6 节）
7. 腾讯云控制台防火墙放行 8123/TCP
8. 外网验证

## 9. 策略说明与边界

- 上游免费车道按 session 限流，短时打满会 429；服务会如实标注“已达限额”
- Kilo 免费池声明 prompt 可能被记录——请勿发送敏感内容
- 管理面公网暴露 = 任何人都能访问登录页；登录需要 bootstrap token（10 分钟一次性）或 forwardKey。建议部署后立即登录管理页确认 Key 轮换一次
- 部分模型上游延迟高（如 nemotron-3.5-lightning-free 实测首字 > 30s）
- 私有仓库部署：服务器通过 GitHub API 下载 release tarball（PAT 仅在单次 curl 的 URL/query 中使用，不落盘、不进 shell history 的环境变量持久化）；后续更新走同一流程
