# CloudSub

自建订阅聚合工具：将多个节点和订阅合并为单一链接，自动适配客户端格式，简化订阅管理。

部署在 Cloudflare Workers / Pages 上，全部订阅格式由 Worker 本地生成，**零第三方转换依赖**。

## ✨ 功能特性

1. **节点转订阅**：将节点链接自动转换为 base64 订阅链接
2. **多订阅汇聚**：多个机场订阅合并为一个订阅地址，一键获取所有节点
3. **六大格式本地生成**：base64 / Clash / sing-box / Surge / Quantumult X / Loon 均由 Worker 本地生成，不依赖任何第三方转换后端
4. **订阅源本地识别**：支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，无需提交给第三方解析
5. **自动适配格式**：通过 URL 参数（`?clash`、`?singbox`、`?surge`、`?quanx`、`?loon`）或客户端 UA 自动返回对应格式
6. **分流规则**：内置 ACL4SSR 规则集（KV 缓存）
7. **按协议过滤**：管理页可勾选仅保留指定协议（vmess / vless / ss / ssr / trojan / hysteria2 / tuic / wireguard / anytls 等）
8. **节点校验加固**：全协议字段按 mihomo 实测校验，非法节点整节点丢弃，避免单个坏节点导致客户端拒绝加载整个配置
9. **本地 GeoIP 剔除**：可选剔除中国大陆节点，本地 IP 段二分匹配，不请求第三方查询接口
10. **屏蔽警示/占位节点**：服务器为本地地址（127.x / 0.0.0.0 / localhost）的节点默认剔除（如公开源注入的「防范境外势力渗透」系列），另支持按节点名称关键词屏蔽（`BLOCKWORDS` 配置）
11. **法国节点专属分组**：结构化配置（Clash / sing-box / Surge / Quantumult X / Loon）会自动生成「🇫🇷 法国节点」策略组，聚合法国节点并单独成组，方便按需切换；在任意格式订阅地址后追加 `?fr` / `&fr` 参数，可获取**仅含法国节点的专属订阅**，使用本地 GeoIP（ipdeny 法国 CIDR，7 天缓存）+ 名称关键词二路识别，零第三方查询。

## 🚀 快速部署

### Cloudflare Pages

1. Fork 本项目，在 Cloudflare Pages 控制台选择「连接到 Git」并部署
2. 绑定 `KV` 命名空间（变量名必须为 `KV`，用于保存节点/订阅链接与配置）
3. 设置环境变量：`TOKEN`（管理页入口）、`SUBTOKEN`（客户端订阅 Token，UUID 格式）

### Cloudflare Workers

1. 新建 Worker，将 `_worker.js` 内容粘贴到编辑器中
2. 绑定 `KV` 命名空间（变量名 `KV`）
3. 设置环境变量 `TOKEN` 与 `SUBTOKEN`

### 使用

- 管理页地址：`https://<你的域名>/<TOKEN>`，在页面中添加自建节点链接和机场订阅链接（每行一个）
- 客户端订阅地址：`https://<你的域名>/sub?token=<SUBTOKEN>`，按客户端 UA 自动适配格式；如需指定格式，追加 `&clash`、`&singbox`、`&surge`、`&quanx`、`&loon` 参数；追加 `?fr` / `&fr` 参数获取仅含法国节点的专属订阅

> 订阅源支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接。

## 🔑 环境变量

| 变量名 | 示例 | 必填 | 说明 |
|-|-|-|-|
| TOKEN | `auto` | ✅ | 管理配置页面的入口 Token，例如 `/auto` |
| SUBTOKEN | `00000000-0000-0000-0000-000000000000` | ✅ | 客户端订阅 Token，必须为 UUID（也可用变量名 `SUBUUID`），且不能与 `TOKEN` 相同 |
| KV | （KV 命名空间绑定） | ✅ 推荐 | 保存节点/订阅链接、协议过滤配置与分流规则缓存 |
| LINK | `vless://...`、`vmess://...`、`https://...` | ❌ | 未绑定 KV 时使用：节点链接与订阅链接，换行分隔 |
| LINKSUB | `https://...` | ❌ | 未绑定 KV 时使用：仅填写订阅链接，换行分隔 |
| PROTOCOL | `vmess,vless,ss` | ❌ | 仅保留指定协议的节点 |
| NOCN | `1` | ❌ | 剔除中国大陆节点（本地 GeoIP 匹配 + 名称关键词回退） |
| WARP | `warp://...` | ❌ | 追加 WARP 节点到聚合订阅 |
| SUBNAME | `CloudSub` | ❌ | 订阅名称 |
| SUBUPTIME | `6` | ❌ | 客户端订阅自动更新时间（小时），默认 6，范围 1-168 |
| SUBMAXSOURCE | `50` | ❌ | 聚合订阅源数量上限（默认 50） |
| SUBMAXSIZE | `10485760` | ❌ | 单个订阅源响应大小上限（字节，默认 10MB） |
| SUBMAXTOTAL | `41943040` | ❌ | 全部订阅源合计响应大小预算（字节，默认 40MB） |
| SUBMAXTIME | `20000` | ❌ | 单个订阅源拉取超时（毫秒，默认 20 秒） |
| SUBMAXNODES | `20000` | ❌ | 聚合结果节点行数上限（默认 20000） |
| EXCLUDE | `example.com` | ❌ | 排除订阅源：按 URL 片段匹配，命中即不拉取 |
| BLOCKWORDS | `防范境外势力渗透,已被劫持` | ❌ | 屏蔽节点：名称含任一关键词即剔除（逗号/换行分隔）；服务器为本地地址（127.x/0.0.0.0/localhost）的警示占位节点默认剔除，无需配置 |
| IPINFO | `0` | ❌ | `0` 时通知不再查询 ip-api.com 归属地（默认查询） |
| TGTOKEN | `YOUR-BOT-TOKEN` | ❌ | 发送 Telegram 通知的机器人 Token |
| TGID | `YOUR-CHAT-ID` | ❌ | 接收 Telegram 通知的账户数字 ID |
| TG | `1` | ❌ | `1` 推送所有访问信息，`0`（默认）不推送 |
| URL302 | `https://example.com` | ❌ | 未授权访问时的 302 跳转地址 |
| URL | `https://example.com` | ❌ | 未授权访问时的反向代理目标地址 |

> 说明：`/auto` 仅作为管理页面入口，客户端订阅统一使用 `/sub?token=<SUBTOKEN>`。`SUBTOKEN` 未配置或格式不正确时所有请求返回 500。

## 🛠 开发与构建

从 v2.8.0 起，源码由单文件 `_worker.js` 按职责拆分到 `src/` 目录：

```
src/
├── 00-constants.js         # 配置常量、协议列表、拉取限制
├── 10-handler.js           # 入口 fetch 处理器（订阅请求路由 + 聚合缓存）
├── 15-notify.js            # ADD / nginx / TG 通知 / base64 / 哈希工具
├── 20-http.js              # 代理跳转 / getSUB 订阅源拉取 / 响应读取
├── 30-clash-parser.js      # Clash YAML 订阅解析
├── 40-singbox-parser.js    # sing-box / v2ray JSON 订阅解析
├── 50-multiformat-parser.js# Surge / Loon / QX / SS / base64 多格式解析
├── 60-convert.js           # 节点与 sing-box / YAML 转换工具
├── 70-render-rules.js      # YAML 渲染 / ACL4SSR 规则获取与缓存
├── 80-generators.js        # Clash / Surge / QX / Loon 配置本地生成
├── 90-filter-dedup.js      # 按协议过滤 / 节点去重
└── 95-admin.js             # KV 管理页 + 数据迁移
```

`src/*.js` 处于同一模块作用域（不互相 import），`build.js` 按序拼接回单文件 `_worker.js`，可直接粘贴进 Workers 编辑器部署。

常用命令（需 Node ≥ 18）：

```bash
npm run build   # 由 src/ 重新生成 _worker.js
npm run check   # 校验 src 与 _worker.js 一致 + 语法检查
npm test        # 重构建并运行离线单元测试（不联网）
npm run lint    # ESLint
```

> 开发时请修改 `src/` 下的源码，改完运行 `npm run build` 刷新 `_worker.js`，不要直接改 `_worker.js`。

## 📄 许可证

[MIT](LICENSE)