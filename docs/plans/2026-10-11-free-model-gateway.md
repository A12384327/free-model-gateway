# free-model-gateway 实施计划

> **For agentic workers:** Execute this plan task by task. Use one fresh `subagent` per task (recommended), or implement the tasks directly in session. Track progress with `todo_write` and keep the `-[ ]` checkboxes below updated as the durable record in the file itself.

**Goal:** 把 Ebony-Vinyl/dsh-our-free-model（OFM）standalone 服务用单容器双进程（ofm + nginx 反代）打包，发布到 GitHub 私有仓库，经 OrcaTerm 网页终端部署到腾讯云轻量服务器并对外开放 8123 端口。

**Architecture:** OFM standalone 是零依赖 Node 服务，强制绑定回环；同一容器内 nginx 监听 0.0.0.0:8123 反代 127.0.0.1:18900——`/v1/*` 直通（仅 Bearer Key 鉴权），管理面改写 `Host` 为回环并剥离 `Origin`/`Referer` 以通过上游结构化围栏。数据（API Key、渠道凭据）落在宿主卷 `./data`。

**Tech Stack:** Node 22 Alpine（上游 engines `^22.19.0 || >=24.0.0`）、alpine nginx、Docker Compose、GitHub API（PAT 本机凭据）、OrcaTerm 网页终端（腾讯云轻量 lhins-1wy6c37c，ap-seoul）。

**Spec:** [2026-10-11-free-model-gateway-design.md](../specs/2026-10-11-free-model-gateway-design.md)

## Global Constraints

- 上游 Node 引擎要求：`^22.19.0 || >=24.0.0` → 镜像 `node:22-alpine`（当前 latest 22.x 满足）。
- 运行时零 npm 依赖：ofm 树原样打包，**不得** `npm install`，**不得**修改上游任何源文件（尤其 `isLoopbackHost` 回环强制）。
- 镜像必须包含 `ofm/vendor/channel-pack/qoder-auth-wasm.wasm`（`business.mjs:37023` 以 `import.meta.url` 相对路径 `../../../vendor/channel-pack/…` 加载，遗漏即渠道 worker 崩）。
- 对外端口一律 8123；ofm 固定 18900。
- 部署全程不使用 SSH：只用 OrcaTerm 网页终端 + 浏览器自动化。
- 服务器上不持久化任何 GitHub 凭据（PAT 不落盘、不进 shell 历史、不进本对话记录）。
- 仓库 `A12384327/free-model-gateway`（Private）；上游 MIT，保留 ofm/LICENSE 与出处标注。
- 上游固定 commit `4ed5955f942e805b815c86d4d70914e72df7c1c1`（2026-10-11 main）。

## Review Focus

规格没写但实际会咬人的输入类，及归属测试：

1. **浏览器带 `Origin`/`Referer`/`sec-fetch-site` 访问管理面** → 必须经反代改写后 200，直连形状必 403。→ Task 5 preflight 检查 1/2/4/5。
2. **流式 SSE 被反代缓冲** → 长思考 60s+ 静默被缓冲成尾包。→ nginx `proxy_buffering off` + `proxy_read_timeout 3600s` + HTTP/1.1（Task 2 固化），Task 8 服务器实测流式逐帧到达。
3. **容器被 kill 后 `/data/service.lock` 残留** → 重启起不来。→ entrypoint 启动前 `rm -f /data/service.lock`（Task 3 固化），Task 8 服务器实测 `docker restart` 后健康。
4. **渠道备份导入 8MB 请求体** → nginx 默认 1m 上限直接 413。→ `client_max_body_size 16m`（Task 2 固化），Task 8 服务器实测 1MB 未鉴权 POST 得 401（上游响应）而非 413（nginx）。
5. **一次性登录链接过期（10 分钟）后无法进管理页** → 用户被锁在外面。→ README 写明 forwardKey 登录路径 + `docker compose exec` 读取方法（Task 6）。

## File Structure

```
free-model-gateway/               ← 仓库根（git init -b main）
├── Dockerfile                     ← 单容器：node:22-alpine + apk nginx
├── docker-entrypoint.sh           ← 双进程拉起 + 锁清理 + 信号处理
├── docker-compose.yml             ← 8123:8123，./data:/data，restart 策略
├── .dockerignore / .gitignore / .gitattributes
├── LICENSE                        ← MIT（含上游出处）
├── README.md                      ← 我们的项目文档（部署/使用/边界）
├── nginx/ofm.conf                 ← 反代规则（唯一 nginx 决策点）
├── scripts/deploy.sh              ← 服务器端：装 Docker + compose up + 健康等待
├── scripts/preflight.mjs           ← 围栏契约离线测试（ofm + 参考代理）
├── docs/specs/… · docs/plans/…     ← 规格与本计划
└── ofm/                           ← 上游完整树（minus .git/.github），含 vendor wasm
```

各文件单一职责：`nginx/ofm.conf` 只做转发决策；`docker-entrypoint.sh` 只做进程生命周期；`scripts/preflight.mjs` 只验证"反代形状 ↔ 上游围栏"契约；`ofm/` 永不手改。

---

### Task 1: 仓库脚手架 + vendor 上游树

**Files:**
- Create: `ofm/`（从本地 `dsh-our-free-model/` 复制，排除 `.git`、`.github`）
- Create: `.gitignore`（`data/`、`node_modules/`）、`.dockerignore`（`.git`、`data`、`node_modules`）、`.gitattributes`（`* text=auto eol=lf`）
- Create: `LICENSE`（MIT，正文注明含 Ebony-Vinyl/dsh-our-free-model 代码）
- Create: `ofm/UPSTREAM.md`（固定 commit `4ed5955f…`、克隆日期、上游仓库链接）

**Interfaces:**
- Produces: `ofm/packages/standalone/cli.mjs`（后续所有任务的运行入口）、`ofm/vendor/channel-pack/qoder-auth-wasm.wasm`（镜像必带文件）

- [x] **Step 1: 复制上游树**

```powershell
robocopy dsh-our-free-model free-model-gateway\ofm /E /XD .git .github
```

- [x] **Step 2: 写 4 个 meta 文件 + UPSTREAM.md**

内容如上 Files 列表所述；`.gitattributes` 逐字 `* text=auto eol=lf`。

- [x] **Step 3: 验证关键文件在位**

`Test-Path ofm\packages\standalone\cli.mjs`、`ofm\packages\standalone\web\assets.json`、`ofm\vendor\channel-pack\qoder-auth-wasm.wasm`、`ofm\src\core\runtime.js` 全部为 True；`node ofm\packages\standalone\cli.mjs --help` 打印用法文本。

- [x] **Step 4: git init -b main + 首次提交**

提交信息 `chore: vendor dsh-our-free-model at 4ed5955 and scaffold repo`（含 docs/specs、docs/plans）。

### Task 2: nginx 反代配置

**Files:**
- Create: `nginx/ofm.conf`

**Interfaces:**
- Produces: 两个 location 的头部改写规则——Task 3（Dockerfile）COPY 到 `/etc/nginx/http.d/ofm.conf`；Task 5 的参考代理按同表实现；alpine nginx 主配置自动 include `/etc/nginx/http.d/*.conf`。

规则表（决策核心，逐行有据）：

| 路径 | Host | Origin/Referer | 缓冲 | 超时 | 依据 |
|---|---|---|---|---|---|
| `/v1/` | 原样透传 | 原样透传 | off | 读 3600s | forward.js 不查 Host；SSE 心跳 15s+思考 60s+ |
| 其余（`/`、`/health`、`/api/management/*`、无 `/v1` 前缀的 API 别名） | `127.0.0.1:18900` | 剥离（空值即删头） | off | 读 3600s | management 围栏：Host 须回环、Origin/Referer 须匹配或缺失 |

- [x] **Step 1: 写 nginx/ofm.conf**

两 location + `client_max_body_size 16m` + `proxy_http_version 1.1` + `proxy_set_header Connection ""`；`listen 8123`。

- [x] **Step 2: 与规则表逐行核对后提交**

提交信息 `feat: reverse-proxy config with fence-satisfying header rewrites`。

### Task 3: Dockerfile + entrypoint

**Files:**
- Create: `Dockerfile`、`docker-entrypoint.sh`

**Interfaces:**
- Consumes: Task 1 的 `ofm/` 树、Task 2 的 `nginx/ofm.conf`
- Produces: 镜像 `free-model-gateway:latest`——入口 `/usr/local/bin/docker-entrypoint.sh`，容器内进程：`node /app/packages/standalone/cli.mjs --port 18900 --data-dir /data` + `nginx -g 'daemon off;'`；`HEALTHCHECK` 用 busybox `wget -q -O /dev/null http://127.0.0.1:18900/health`（start-period 90s，探测要等渠道 worker 初始化）

- [x] **Step 1: 写 docker-entrypoint.sh**

要点：`set -e`；`mkdir -p /data`；**`rm -f /data/service.lock`**（容器重建后旧 pid 必不存在，属容器语义的安全清理）；后台拉起两进程；`trap` TERM/INT 双杀；`kill -0` 轮询代替 busybox `wait -n`（兼容性）；退出前 `wait` 收尸。

- [x] **Step 2: 写 Dockerfile**

`FROM node:22-alpine` + `RUN apk add --no-cache nginx` + `COPY ofm/ /app/` + `COPY nginx/ofm.conf /etc/nginx/http.d/ofm.conf` + `ENV OFM_HOME=/data` + `EXPOSE 8123` + HEALTHCHECK + ENTRYPOINT。

- [x] **Step 3: 提交**

提交信息 `feat: single-container image running ofm behind in-container nginx`。

### Task 4: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: Task 3 镜像
- Produces: 服务 `gateway`：`build: .`、`init: true`（Docker 内置 init 收割僵尸进程）、`ports: ["8123:8123"]`、`volumes: ["./data:/data"]`、`restart: unless-stopped`（健康检查沿用镜像内定义，不在 compose 重复）

- [x] **Step 1: 写文件 + 提交**

提交信息 `feat: compose service on 8123 with persistent data volume`。

### Task 5: 围栏契约测试（preflight）

**Files:**
- Create: `scripts/preflight.mjs`
- Test: 该文件自含测试（拉起真实 ofm + 参考代理，离线运行，`--no-refresh` 不触网）

**Interfaces:**
- Consumes: `ofm/packages/standalone/cli.mjs`（`--port 18990 --data-dir <tmp> --no-refresh`）、Task 2 规则表
- Produces: 退出码 0 = 契约成立；stdout 逐项 `PASS/FAIL`

九项断言（参考代理实现与 nginx/ofm.conf 同一规则表）：

1. **直连** `http://127.0.0.1:18990/`（Host: `203.0.113.7:8123`）→ **403**（围栏拒绝公网 Host——对照组，证明改写必要）
2. **经代理** `GET /`（带浏览器头：Origin/Referer/sec-fetch-site: same-origin，Host: `203.0.113.7:8123`）→ **200** HTML
3. 经代理 `GET /api/management/summary`（无凭证）→ **401**（非 403，证明围栏已过、鉴权接管）
4. 从 ofm stdout 解析一次性 `#login=<token>`，经代理 `POST /api/management/session` {bootstrapToken} → **200** + set-cookie
5. 带 cookie 经代理 `GET /api/management/summary` → **200**（管理全链路走通）
6. 经代理 `GET /v1/models` 无 Key → **401**
7. 读 `<tmp>/settings.json` 的 `forwardKey`，经代理带 Bearer → **200**
8. 经代理 `GET /health` → **200**
9. 经代理 `OPTIONS /v1/chat/completions` → **204**

用 `node:http` 原生请求（fetch 禁设 Host 头）；测试结束杀子进程 + 清理 tmp 目录。

- [x] **Step 1: 写 scripts/preflight.mjs（断言 1–9 + 参考代理 + 进程清理）**
- [x] **Step 2: 本机运行 `node scripts/preflight.mjs`，期望 9/9 PASS**

实测中出现过的教训：ofm 启动横幅中文在 Windows 控制台是乱码但不影响解析（token 是 ASCII）；端口解析要用 stdout 里实际打印的端口（standalone 会自动顺延占用端口）。

- [x] **Step 3: 提交**

提交信息 `test: pin reverse-proxy fence contract with offline preflight`。

### Task 6: README + 部署脚本

**Files:**
- Create: `README.md`（根，我们项目的）、`scripts/deploy.sh`

**Interfaces:**
- Consumes: Task 2–5 全部产物
- Produces: 面向用户的部署文档（含：架构图、本地 Docker 跑法、腾讯云轻量跑法、**防火墙放行 8123 提示**、API 用法 curl 示例、管理页两种登录方式——10 分钟一次性链接 / forwardKey（`docker compose exec gateway cat /data/settings.json`）、Key 轮换语义、上游边界——Kilo 记录 prompt/429 限流/管理面公网暴露提示）+ 服务器脚本（`deploy.sh`：无 docker 则 `curl -fsSL https://get.docker.com | sh`；`docker compose up -d --build`；30×2s 轮询 `/health`，超时打印 `compose logs`）

- [x] **Step 1: 写两个文件**
- [x] **Step 2: 提交**

提交信息 `docs: deployment guide and idempotent server script`。

### Task 7: GitHub 建仓 + 推送

**Files:**
- Modify: git remote 配置（本地仓 → `https://github.com/A12384327/free-model-gateway`）

**Interfaces:**
- Consumes: 本机 git 凭据管理器中 A12384327 的 PAT（已验证可建仓/推送）
- Produces: 私有仓库 `A12384327/free-model-gateway`，分支 `main`；本地 `git archive --format=tar.gz -o free-model-gateway.tar.gz main` 产物（Task 8 上传服务器用）

- [x] **Step 1: 建仓**

先试 `PATCH /repos/A12384327/ofm-api-gateway-probe`（复用探测仓库，name → `free-model-gateway`，顺便清掉残留）；403/404 则 `POST /user/repos` {"name":"free-model-gateway","private":true}。

- [x] **Step 2: remote add + push -u origin main**

- [x] **Step 3: `git ls-remote` 验证远端 main 与本地 HEAD 一致；打 tag `v1.0.0` 并推送**

### Task 8: 服务器部署（OrcaTerm，交互式——只能 Lead 执行）

**Files:**
- 无仓库文件变更；产出服务器上的运行实例

**Interfaces:**
- Consumes: Task 7 的 tarball；用户给的 OrcaTerm URL（`https://orcaterm.cloud.tencent.com/terminal?type=lighthouse&instanceId=lhins-1wy6c37c&region=ap-seoul`）
- Produces: 服务器上 healthy 的 `free-model-gateway` 容器；`./data/settings.json` 内的 forwardKey

- [x] **Step 1: 浏览器打开 OrcaTerm URL；若需登录，请用户在共享浏览器窗口完成登录**
- [x] **Step 2: 网页终端里探明环境**：`uname -a`、`cat /etc/os-release`、`command -v docker || echo no-docker`、`curl -s ifconfig.me`（拿公网 IP）
- [x] **Step 3: 传代码上服务器（凭据零接触方案，见下方"传输方式"）→ 解压 → `bash scripts/deploy.sh`**
- [x] **Step 4: 服务器本机验收**：`curl -s http://127.0.0.1:8123/health`；`KEY=$(docker compose exec gateway cat /data/settings.json)` 提取 forwardKey 后 `curl /v1/models` 带 Key → 模型列表；非流式 + 流式对话各一发；1MB 未鉴权 POST `/v1/chat/completions` → 401（非 nginx 413）；`docker restart` 后 health 自动恢复（锁清理生效）
- [x] **Step 5: 记录 forwardKey 告知用户（其服务器上的钥匙，交付必给）**

**传输方式（三选一，按优先级现场定）**：
- A. OrcaTerm 自带 SFTP/文件上传 UI 上传 tarball（首选：无凭据过境，服务器不碰 GitHub）
- B. 仓库临时转 Public → 服务器 `curl` tarball → 转回 Private（需用户点头；仓库无任何机密）
- C. `read -s` 盲输 PAT 拉取（token 不进 shell 历史，但会出现在我的浏览器 keystroke 工具调用里——**不采用**，仅列为已否决项）

### Task 9: 防火墙放行 + 外网验收（Lead 执行）

**Files:**
- 无仓库文件变更

- [x] **Step 1: 腾讯云控制台（同一登录会话）→ 轻量服务器 → 防火墙 → 添加规则：TCP 8123，源 All；若 UI 不可自动化则给用户精确点击路径**
- [x] **Step 2: 本机外网验收**：`curl http://<公网IP>:8123/health` → 200；`/v1/models` 带 Key → 列表；非流式对话 200；浏览器打开管理页 `http://<公网IP>:8123/` → 登录页正常（无 403）；流式对话逐帧到达
- [x] **Step 3: 向用户交付**：API 地址、forwardKey、管理页入口、README 链接、防火墙规则位置、后续更新方法（重传 tarball → `docker compose up -d --build`）

---

## Self-Review 记录

- 规格覆盖：§2 决策表（Task 1/7 仓、Task 2/8/9 端口 8123、全渠道=vendor 全树）、§4 架构（Task 2/3/4）、§6 验收 9 条（Task 8 Step 4 + Task 9 Step 2 逐条对应）、§7 交付物（Tasks 1–7）、§8 部署流程（Task 8）——无遗漏。
- 步骤可执行性：nginx/entrypoint/Dockerfile 的关键行内联（是决策本体）；preflight 只给断言表（实现细节由断言唯一确定）。
- 类型一致性：`ofm/packages/standalone/cli.mjs`、`forwardKey`、端口 18900/8123/18990/18989 全文一致。
- Review Focus 5 项均有归属测试/固化点。
- 篇幅：规格 149 行，计划与之相称；配置内联为决策而非转写。
