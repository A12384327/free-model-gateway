# free-model-gateway

把 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（OFM）里的免费模型
**全部提出来，集在一个 API 里**，用 Docker 部署、通过反向代理对外可访问。

```
外网浏览器 / 任意 OpenAI 客户端
        │  http://<服务器IP>:8123
        ▼
   nginx  (0.0.0.0:8123)
        │  /v1/*             → 直通（Bearer Key 鉴权）
        │  管理页 & 其余路径   → Host 改写为 127.0.0.1:18900 + 剥离 Origin/Referer
        ▼
   OFM standalone  (127.0.0.1:18900，上游强制回环，原样保留)
        ├── 匿名免费车道（OpenCode Zen 网关，零登录、零 Key）
        ├── Kilo 免费池（零登录）
        ├── 13 个账号渠道 + EAC（管理页登录后解锁）
        └── /v1/models · /v1/chat/completions · /v1/responses（流式 + 非流式）
```

**不是 dsh 插件**——`ofm/` 是上游完整源码的 verbatim 拷贝（见 [ofm/UPSTREAM.md](ofm/UPSTREAM.md)，
pinned commit `4ed5955`），零修改、零 npm 依赖，入口是上游自带的独立服务
`packages/standalone/cli.mjs`。nginx 与 OFM 同容器共享网络命名空间：
OFM 按自身安全设计只监听回环，nginx 是唯一对外的门。

## 快速部署（任何有 Docker 的 Linux）

```bash
tar xzf free-model-gateway.tar.gz -C free-model-gateway 2>/dev/null || tar xzf free-model-gateway.tar.gz
cd free-model-gateway
bash scripts/deploy.sh          # 无 Docker 时自动安装；然后 compose up + 等健康
```

启动后：

- **管理页**：`http://<服务器IP>:8123/`
  - 登录方式一：`docker compose logs gateway` 里的一次性链接（**10 分钟内有效，仅一次**，重启即失效）
  - 登录方式二：`docker compose exec gateway cat /data/settings.json` 读取 `forwardKey`，粘进登录页
- **API**：`http://<服务器IP>:8123/v1`，`Authorization: Bearer <forwardKey>`
- **云防火墙**：放行 TCP 8123（腾讯云轻量：控制台 → 实例 → 防火墙 → 添加规则）

## 使用

```bash
KEY=<上面拿到的 forwardKey>
curl http://<IP>:8123/v1/models -H "Authorization: Bearer $KEY"

curl http://<IP>:8123/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl http://<IP>:8123/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

任何 OpenAI 兼容客户端：base URL 填 `http://<IP>:8123/v1`，API Key 填 `forwardKey`。

免费模型（`-free` 结尾的匿名车道 + Kilo `:free` 池）**无需任何登录即可调用**。
13 个账号渠道（CodeArts/TRAE/Qoder 等）在管理页“免费账号渠道”里登录后追加可用模型。

## 管理页能干什么

模型清单与单模型测试、用量统计、13 渠道账号登录/签到/备份、EAC GitHub 授权、
服务设置（暂停推理/探测/输出上限）、API Key 查看**与轮换**（轮换后旧 Key 立即失效）。

## 数据与安全

- `./data/`（容器内 `/data`）：API Key（`settings.json`）、渠道凭据、统计。**删除即重置一切**。
- 容器异常退出可能残留 `data/service.lock`——entrypoint 已自动清理，无需手动处理。
- 管理页与 API 都有独立鉴权；但 **8123 是公网端口**，任何人都够得到登录页与 API 端点，
  请保管好 Key；泄露后在管理页轮换即可。
- 上游边界（如实转述）：免费车道按 session 限速（429 时服务标注“已达限额”并退避）；
  Kilo 免费池声明 prompt 可能被上游记录，**勿发敏感内容**；部分模型上游首字延迟 30s+。

## 开发与验证

```bash
node scripts/preflight.mjs   # 围栏契约 9 项断言：真实服务 + 参考代理，离线运行
```

反代规则表（`/v1/*` 直通；其余 Host→127.0.0.1:18900 + 剥离 Origin/Referer）有两份等价实现：
`nginx/ofm.conf`（生产）与 `scripts/preflight.mjs` 内的参考代理（测试）。改一处必须同步另一处。

## 更新

重新上传项目 tarball 覆盖后 `docker compose up -d --build`；`./data` 不受影响，
Key 与渠道登录保持。若要跟进上游 OFM 新版本：重新 vendor `ofm/`（保持 verbatim）后重建。

## License

MIT。内嵌上游 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)
（MIT），上游许可见 [ofm/LICENSE](ofm/LICENSE)。
