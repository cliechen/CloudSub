# ⚙ 自建汇聚订阅 CloudSub

![自建汇聚订阅 CloudSub](./sub.png)

这是一个将多个节点和订阅合并为单一链接的工具，支持自动适配与自定义分流，简化了订阅管理。

> [!TIP]
> **全部订阅格式均由 Worker 本地生成**（base64 / Clash / sing-box / Surge / Quantumult X / Loon），**零第三方转换依赖**，不再依赖任何在线订阅转换后端——速度快、稳定、隐私好。
>
> **订阅源同样本地识别解析**：支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64（可递归解码）与明文节点链接；无法本地识别的来源自动跳过，不会提交给任何第三方服务。

## 🛠 功能特点
1. **节点链接自动转换成base64订阅链接：** 这是最基础的功能，可以将您的节点自动转换为base64格式的订阅链接；
2. **将多个订阅汇聚成一个订阅链接：** 可以将多个订阅（例如不同的机场）合并成一个订阅，只需使用一个订阅地址即可获取所有节点；
3. **六大格式本地生成，零第三方依赖：** base64 / Clash / sing-box / Surge / Quantumult X / Loon 全部由 Worker 本地生成，不依赖任何第三方订阅转换后端；
4. **多格式订阅源本地识别：** 聚合的订阅源支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，无需提交给第三方解析；
5. **自动适配不同梯子的格式：** 通过 URL 参数（`?clash`、`?singbox`、`?surge`、`?quanx`、`?loon`）或客户端 UA 自动返回对应格式；
6. **专属代理分流规则：** 内置 ACL4SSR 规则集（KV 缓存），实现个性化的分流模式；
7. **按协议过滤节点：** 管理页可勾选仅保留指定协议（vmess / vless / ss / ssr / trojan / hysteria2 / tuic / wireguard / anytls 等）；
8. **更多功能等待发掘...**

## 🎬 视频教程
- **[自建订阅！CloudSub 教你如何将多节点多订阅汇聚合并为一个订阅！](https://youtu.be/w6rRY4FDd58)**

## 🤝 社区支持
- Telegram 交流群: [@CMLiussss](https://t.me/CMLiussss)
- 感谢 [Alice Networks](https://alicenetworks.net/) 提供的云服务器支持

## 📦 Pages 部署方法

<details>
<summary><code><strong>「 Pages GitHub 部署文字教程 」</strong></code></summary>

### 1. 部署 Cloudflare Pages：
   - 在 Github 上先 Fork 本项目，并点上 Star !!!
   - 在 Cloudflare Pages 控制台中选择 `连接到 Git`后，选中 `CloudSub`项目后点击 `开始设置`。

### 2. 给 Pages绑定 自定义域：
   - 在 Pages控制台的 `自定义域`选项卡，下方点击 `设置自定义域`。
   - 填入你的自定义次级域名，注意不要使用你的根域名，例如：
     您分配到的域名是 `fuck.cloudns.biz`，则添加自定义域填入 `sub.fuck.cloudns.biz`即可；
   - 按照 Cloudflare 的要求将返回你的域名DNS服务商，添加 该自定义域 `sub`的 CNAME记录 `CloudSub.pages.dev` 后，点击 `激活域`即可。

### 3. 修改 快速订阅入口 ：

  例如您的pages项目域名为：`sub.fuck.cloudns.biz`；
   - 添加 `TOKEN` 变量作为管理入口 Token，默认值为 `auto`，管理页面地址为 `https://sub.fuck.cloudns.biz/auto`。
   - 添加 `SUBTOKEN` 变量作为订阅 Token，必须使用 UUID 格式，例如：`550e8400-e29b-41d4-a716-446655440000`。也可以使用变量名 `SUBUUID`。
   - 客户端订阅地址（根据客户端 UA 自动适配格式）：
     ```url
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000
     ```
   - 如需指定格式，追加对应参数即可：
     ```url
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000&clash
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000&singbox
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000&surge
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000&quanx
     https://sub.fuck.cloudns.biz/sub?token=550e8400-e29b-41d4-a716-446655440000&loon
     ```

### 4. 添加你的节点和订阅链接：
   1. 绑定**变量名称**为`KV`的**KV命名空间**；
   2. 访问管理地址 `https://sub.fuck.cloudns.biz/auto`，添加你的自建节点链接和机场订阅链接，确保每行一个链接，例如：
      ```
      vless://...（你的 vless 节点链接）
      vmess://...（你的 vmess 节点链接）
      https://...（你的订阅链接）
      ```

   > 订阅源支持多种格式：Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，均可直接填入。

</details>

## 🛠️ Workers 部署方法

<details>
<summary><code><strong>「 Workers 部署文字教程 」</strong></code></summary>

### 1. 部署 Cloudflare Worker：

   - 在 Cloudflare Worker 控制台中创建一个新的 Worker。
   - 将 [_worker.js](https://github.com/cliechen/CloudSub/blob/main/_worker.js)  的内容粘贴到 Worker 编辑器中。


### 2. 修改 订阅入口 ：

  例如您的workers项目域名为：`sub.cloudsub.workers.dev`；
   - 添加 `TOKEN` 环境变量作为管理页面入口，避免配置页暴露。
     ```
      TOKEN=auto
     ```
   管理地址用于打开配置页面，不再作为客户端订阅地址。客户端请使用 `SUBTOKEN` 生成的 UUID 订阅地址（根据客户端 UA 自动适配格式），例如：
     ```url
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000
     ```
   如需指定格式，追加对应参数即可：
     ```url
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000&clash
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000&singbox
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000&surge
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000&quanx
      https://sub.cloudsub.workers.dev/sub?token=550e8400-e29b-41d4-a716-446655440000&loon
     ```


### 3. 添加你的节点或订阅链接：
   1. 绑定**变量名称**为`KV`的**KV命名空间**；
   2. 访问管理地址 `https://sub.cloudsub.workers.dev/auto`，添加你的自建节点链接和机场订阅链接，确保每行一个链接，例如：
      ```
      vless://...（你的 vless 节点链接）
      vmess://...（你的 vmess 节点链接）
      https://...（你的订阅链接）
      ```

   > 订阅源支持多种格式：Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，均可直接填入。

</details>

## 📋 变量说明
| 变量名 | 示例 | 必填 | 备注 | 
|-|-|-|-|
| TOKEN | `auto` | ✅ | 仅用于管理配置页面的入口 Token，例如：`/auto` | 
| SUBTOKEN | `550e8400-e29b-41d4-a716-446655440000` | ✅ | 客户端订阅 Token，必须为 UUID，例如：`/sub?token=550e8400-e29b-41d4-a716-446655440000`。也可使用变量名 `SUBUUID` | 
| KV | （KV 命名空间绑定） | ✅（推荐） | 绑定**变量名称**为 `KV` 的 KV 命名空间，用于保存节点/订阅链接、协议过滤配置与分流规则缓存 | 
| LINK | `vless://...`, `vmess://...`, `https://...` | ❌ | 未绑定 KV 时使用：可同时放入多个节点链接与多个订阅链接，链接之间用换行做间隔 |
| LINKSUB | `https://sub...` | ❌ | 未绑定 KV 时使用：仅填写订阅链接（机场/自建聚合订阅），换行分隔 |
| PROTOCOL | `vmess,vless,ss` | ❌ | 仅保留指定协议的节点；也可在管理页勾选（存入 KV 的 `PROTOCOL.txt`） |
| NOCN | `1` / `true` / `on` | ❌ | 剔除「中国大陆」节点。**本地 GeoIP 优先**：自动从 GitHub（17mon/china_ip_list，KV 缓存 7 天）下载中国 IP 段，服务器为 IP 字面量的节点直接在本地二分匹配（不请求任何第三方 IP 查询接口，域名节点无法本地解析时回退名称关键词）；名称含「省份/城市/中国/大陆/移动/联通/电信」等关键词亦剔除，名称含香港/澳门/台湾的不受影响。也可在管理页勾选（存入 KV 的 `NOCN.txt`）。值可为 `1`、`true`、`on`、`yes`、`开`、`是` |
| WARP | `warp://...` 或任意节点链接 | ❌ | 追加 WARP 节点到聚合订阅中 |
| SUBNAME | `CloudSub` | ❌ | 订阅名称 |
| SUBUPTIME | `6` | ❌ | 客户端订阅自动更新时间（小时），默认 6，范围 1-168 |
| SUBMAXSOURCE | `50` | ❌ | 聚合订阅源数量上限（默认 50）；免费版 Workers 单请求子请求上限为 50（含 Clash 规则集拉取），源较多时建议调小 |
| SUBMAXSIZE | `10485760` | ❌ | 单个订阅源响应大小上限（字节，默认 10MB）；超大订阅被跳过时在日志中提示调大 |
| SUBMAXTOTAL | `41943040` | ❌ | 全部订阅源合计响应大小预算（字节，默认 40MB）；超出后按配置顺序跳过靠后的源，避免大源因下载慢被误杀 |
| SUBMAXTIME | `20000` | ❌ | 单个订阅源拉取超时（毫秒，默认 20 秒） |
| SUBMAXNODES | `20000` | ❌ | 聚合结果节点行数上限（默认 20000，范围 1-100000）；超大订阅按行截断，避免超过 KV 2MiB 缓存安全上限、每次请求都全量重拉 |
| EXCLUDE | `bad.example.com` | ❌ | 排除订阅源：按 URL 片段匹配（一行一个，支持逗号/分号分隔），命中即不拉取该源；也可在 KV 存入 `EXCLUDE.txt` |
| IPINFO | `0` | ❌ | `0` 时 TG 通知不再查询 ip-api.com 归属地（省外部请求、不向第三方暴露访客 IP）；默认查询 |
| TGTOKEN | `6894123456:XXXXXXXXXX0qExVsBPUhHDAbXXXXXqWXgBA` | ❌ | 发送TG通知的机器人token | 
| TGID | `6946912345` | ❌ | 接收TG通知的账户数字ID | 
| TG | `1` | ❌ | 开发者用：`1` 推送所有访问信息，`0`（默认）不推送 | 
| URL302 | `https://example.com` | ❌ | 未授权访问时的 302 跳转地址 | 
| URL | `https://example.com` | ❌ | 未授权访问时的反向代理目标地址 | 
| SUBAPI | - | ❌ | **已废弃**：全部订阅格式均在 Worker 内本地生成，不再依赖第三方转换后端，无需配置 | 
| SUBCONFIG | - | ❌ | **已废弃**：分流规则使用内置 ACL4SSR 规则集（KV 缓存），无需配置 | 


## ⚠️ 注意事项
- **v2.8.1 起 TG 通知不再阻塞请求**：通知改为后台异步（`ctx.waitUntil`）发送，且统一由 `TG=1` 开关控制（`TG=0` 默认不推送，与变量表一致）；`IPINFO=0` 可关闭通知中的 ip-api 归属地查询；
- **v2.8.1 起订阅响应支持 ETag/304**：客户端带 `If-None-Match` 且内容未变化时直接返回 304，不再重复生成/编码配置，减少下游重复拉取；
- **v2.8.1 起显著减少 KV 读取**：`LINK.txt` / `PROTOCOL.txt` / `NOCN.txt` / `EXCLUDE.txt` 等热点键增加 30 秒实例内存缓存（管理页保存时立即失效）；clash/singbox/surge/quanx/loon 格式成品增加秒级内存缓存，大订阅不再每次请求全量重解析生成；
- **v2.8.1 起构建校验更严格**：`npm run check` 真正校验 `src/` 拼接结果与 `_worker.js` 一致；聚合锁 `SUB_LOCK` 防悬挂（持锁超时后可接管、释放时校验归属）；
- **v2.8.1 起「剔除大陆节点」升级为本地 GeoIP 匹配**：自动从 GitHub 下载中国 IP 段（17mon/china_ip_list），KV 缓存 7 天 + 实例内存缓存 1 小时，服务器为 IP 字面量的节点直接在本地二分匹配，不再依赖节点名称关键词（机场常给大陆节点起境外名）；全程不请求任何第三方 IP 归属查询接口，域名节点回退名称关键词判断；
- **v2.8.1 起修复 SS 节点导致 OpenClash/mihomo 无法启动的问题**：SS 插件参数（`obfs`/`v2ray-plugin`）逐项用 `mihomo -t` 实测校准——非法模式（如 `obfs=on`、`v2ray-plugin mode=quic`）会让 mihomo 报 `obfs mode error` 并**拒绝加载整个配置**，现改为整节点丢弃；缺失模式时按惯例默认 `http`/`websocket`；SS cipher 白名单扩充到与 mihomo 支持列表一致（ccm/gcm-siv/chacha8/lea/aegis 等 17 种不再被误丢），并确认 `chacha20-poly1305` 为 mihomo 不支持的名称、保持丢弃；
- **v2.8.1 起全协议字段按 mihomo 实测校验**（避免单个坏节点拖垮整个配置）：vmess 仅接受 `auto`/`aes-128-gcm`/`chacha20-poly1305`/`none` 四种 cipher、`alterId` 必须为非负整数；hysteria2 `obfs` 仅接受 `salamander` 且必须带 `obfs-password`；hysteria v1 `up`/`down` 必须为正整数（缺省给默认值）；wireguard `ip` 仅接受纯 IPv4、`reserved` 必须恰好 3 字节且每字节 0-255；anytls 数字字段（`idle-session-check-interval` 等）必须为正整数。上述非法值一律整节点丢弃；另容忍 URI 尾部斜杠（如 `hysteria2://pw@host:443/`）不再误丢节点；
- **v2.8.1 起支持 GitHub Actions 部署**：手动触发 `Deploy to Cloudflare Workers` 工作流即可部署（需在仓库配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` secrets）；
- **v2.7.6 起大订阅拉取更完整**：修复无 `content-length`（分块传输/动态生成）或 gzip 压缩的订阅源被按单源上限过度估算、导致默认预算下只能拉取少量来源的问题；压缩响应不再因声明大小误导被整源丢弃，实际总读取量由流式预算兜底（不超过 `SUBMAXTOTAL`）；
- **v2.7.2 起订阅源拉取更完整**：单源上限由 5MB 提升至 10MB、合计预算由 20MB 提升至 40MB，且超出合计预算时按配置顺序（而非下载完成先后）跳过靠后的源，大订阅不再因下载慢而被误杀；四个拉取限制均可通过 `SUBMAXSOURCE` / `SUBMAXSIZE` / `SUBMAXTOTAL` / `SUBMAXTIME` 调整。
- **v2.7.0 起订阅地址变更**：客户端订阅地址为 `/sub?token=<SUBTOKEN>`，`/auto` 仅作为管理页面入口，不再输出订阅内容；
- **`SUBTOKEN` 为必填项**：未配置或格式不正确时，所有请求将返回 500，请务必在部署时设置 UUID 格式的 `SUBTOKEN`（或 `SUBUUID`），且不能与 `TOKEN` 相同；
- 项目中，TGTOKEN和TGID在使用时需要先到Telegram注册并获取。其中，TGTOKEN是telegram bot的凭证，TGID是用来接收通知的telegram用户或者组的id。


## 🧪 订阅源完整性测试

将订阅源列表写入 `test/sub_sources.txt`（每行一个），然后运行：

```bash
node test/test_subscription.mjs
```

脚本会逐个（并发受限）拉取每个源并统计 HTTP 状态、是否缺失 `content-length`、是否 gzip、响应大小与解析出的节点数，再用 `getSUB` 全流程（生产默认限制）聚合，对比去重后的节点完整性。瞬时网络失败会自动重试一次；挂起的上游连接由硬超时看门狗终止。

## 🛠 开发与构建（源码模块化）

> 从 `v2.8.0` 起，源码由单文件 `_worker.js` **按职责拆分到 `src/` 目录**，便于维护与审阅：

```
src/
├── 00-constants.js         # 配置常量、协议列表、拉取限制
├── 10-handler.js           # 入口 fetch 处理器(订阅请求路由 + 聚合缓存)
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

所有 `src/*.js` 处于**同一模块作用域**（不互相 `import`），`build.js` 按序拼接回单文件 `_worker.js`，保证：

- `_worker.js` 仍是**可直接粘贴进 Workers 编辑器**的部署产物，与旧版行为完全一致；
- 减少单文件体积、按职责分文件维护、便于 Code Review 与后续演进。

常用命令（需 Node ≥ 18）：

```bash
npm run build       # 由 src/ 重新生成 _worker.js
npm run check       # 校验 src 行数与 _worker.js 一致 + 语法检查
npm test            # 重构建并运行离线单元测试(tests/unit.test.mjs,不联网)
npm run lint        # ESLint(需先 npm install)
```

> ⚠️ 开发时请**修改 `src/` 下的源码**，改完运行 `npm run build` 刷新 `_worker.js`，不要直接改 `_worker.js`（它由构建生成）。

### 聚合结果 KV 缓存（含“变化才下载”）

`/sub` 默认每次都会重新拉取全部上游订阅源。从 `v2.8.0` 起，聚合、去重、按协议过滤后的最终节点结果会按「自建节点 + 订阅源 + 协议过滤 + WARP」的哈希**缓存在 KV**（一份缓存服务 base64/clash/singbox/surge/quanx/loon 所有格式）。为降低 Cloudflare 后台资源占用，实现四层机制：

1. **实例内存热缓存（秒级）**：同一 Worker 实例内命中则完全不碰 KV、不拉上游，大幅减少 KV 读取；
2. **KV 缓存（TTL=SUBUPTIME）**：跨实例复用权威结果；
3. **SWR 后台刷新 + 条件请求（“有变化才下载”）**：缓存靠近过期且被访问时，用 `ctx.waitUntil` 在后台带上上次的 `ETag`/`Last-Modified` 去刷新——上游全部返回 **304（内容未变）则“不下载 body、不重建、仅续期”**，真正有变化才下载；用户请求不阻塞；
4. **防惊群锁**：缓存 cold 时仅一个请求承担全量拉取，其余等待读取结果，避免并发重复拉取。

追加 `&refresh` 可强制重建（无论是否变化都重新拉取）。未绑定 KV 时自动退化为每次都实时聚合（与原行为一致）。

聚合结果写入 KV 前会按 UTF-8 字节数检查项目设置的 KV 缓存安全上限（2 MiB）；超过限制时仅跳过持久化缓存，不影响当前请求返回。此时应降低订阅规模或拆分订阅源。

> ⚠️ 说明：Cloudflare Worker 代码只在“有请求时”运行，无真正的后台定时器。因此上述刷新由“访问 + 后台异步收尾”驱动，而非固定间隔的心跳；若需“无人访问也定时刷新”，必须另行配置 Cron Triggers（需手动设置，本项目默认不做）。

聚合缓存使用的 KV 键（均以 `SUB_` 前缀，避免与用户数据键冲突）：

| 键 | 用途 |
|---|---|
| `SUB_AGG:<sha256>` | 聚合去重过滤后的最终节点文本（TTL=SUBUPTIME） |
| `SUB_AGG_AT:<sha256>` | 上次聚合写入的时间戳（SWR 判断接近过期用） |
| `SUB_ETAG:<sha256(url)>` | 每个订阅源上次的 ETag/Last-Modified（条件请求凭据） |
| `SUB_REFRESH_AT:<sha256>` | 后台刷新调度防抖（防多实例并发） |
| `SUB_LOCK:<sha256>` | 重建锁（防惊群） |


## ⭐ Star 星星走起
[![Stargazers over time](https://starchart.cc/cliechen/CloudSub.svg?variant=adaptive)](https://starchart.cc/cliechen/CloudSub)


# 🙏 致谢
[Alice Networks LTD](https://alicenetworks.net/)，[mianayang](https://github.com/mianayang/myself/blob/main/cf-workers/sub/sub.js)、[ACL4SSR](https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config)、[肥羊](https://sub.v1.mk/)
