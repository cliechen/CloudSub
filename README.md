# 自建汇聚订阅 CloudSub

这是一个将多个节点和订阅合并为单一链接的工具，支持自动适配与自定义分流，简化了订阅管理。

> [!TIP]
> **全部订阅格式均由 Worker 本地生成**（base64 / Clash / sing-box / Surge / Quantumult X / Loon），**零第三方转换依赖**，不再依赖任何在线订阅转换后端——速度快、稳定、隐私好。
>
> **订阅源同样本地识别解析**：支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64（可递归解码）与明文节点链接；无法本地识别的来源自动跳过，不会提交给任何第三方服务。

## 功能特点
1. **节点链接自动转换成base64订阅链接：** 这是最基础的功能，可以将您的节点自动转换为base64格式的订阅链接；
2. **将多个订阅汇聚成一个订阅链接：** 可以将多个订阅（例如不同的机场）合并成一个订阅，只需使用一个订阅地址即可获取所有节点；
3. **六大格式本地生成，零第三方依赖：** base64 / Clash / sing-box / Surge / Quantumult X / Loon 全部由 Worker 本地生成，不依赖任何第三方订阅转换后端；
4. **多格式订阅源本地识别：** 聚合的订阅源支持 Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，无需提交给第三方解析；
5. **自动适配不同梯子的格式：** 通过 URL 参数（`?clash`、`?singbox`、`?surge`、`?quanx`、`?loon`）或客户端 UA 自动返回对应格式；
6. **专属代理分流规则：** 内置 ACL4SSR 规则集（KV 缓存），实现个性化的分流模式；
7. **按协议过滤节点：** 管理页可勾选仅保留指定协议（vmess / vless / ss / ssr / trojan / hysteria2 / tuic / wireguard / anytls 等）；
8. **更多功能等待发掘...**

## Pages 部署方法

### 1. 部署 Cloudflare Pages：
   - 在 Github 上先 Fork 本项目
   - 在 Cloudflare Pages 控制台中选择 `连接到 Git`后，选中 `CloudSub`项目后点击 `开始设置`。

### 2. 给 Pages绑定 自定义域：
   - 在 Pages控制台的 `自定义域`选项卡，下方点击 `设置自定义域`。
   - 填入你的自定义次级域名，注意不要使用你的根域名，例如：
     您分配到的域名是 `your-domain.com`，则添加自定义域填入 `sub.your-domain.com`即可；
   - 按照 Cloudflare 的要求将返回你的域名DNS服务商，添加 该自定义域 `sub`的 CNAME记录 `CloudSub.pages.dev` 后，点击 `激活域`即可。

### 3. 修改 快速订阅入口 ：

  例如您的pages项目域名为：`sub.your-domain.com`；
   - 添加 `TOKEN` 变量作为管理入口 Token，默认值为 `auto`，管理页面地址为 `/auto`。
   - 添加 `SUBTOKEN` 变量作为订阅 Token，必须使用 UUID 格式，例如：`YOUR-UUID-HERE`。也可以使用变量名 `SUBUUID`。
   - 客户端订阅地址（根据客户端 UA 自动适配格式）：
     ```
     /sub?token=YOUR-UUID-HERE
     ```
   - 如需指定格式，追加对应参数即可：
     ```
     /sub?token=YOUR-UUID-HERE&clash
     /sub?token=YOUR-UUID-HERE&singbox
     /sub?token=YOUR-UUID-HERE&surge
     /sub?token=YOUR-UUID-HERE&quanx
     /sub?token=YOUR-UUID-HERE&loon
     ```

### 4. 添加你的节点和订阅链接：
   1. 绑定**变量名称**为`KV`的**KV命名空间**；
   2. 访问管理地址 `/auto`，添加你的自建节点链接和机场订阅链接，确保每行一个链接，例如：
      ```
      vless://YOUR-NODE-LINK-HERE
      vmess://YOUR-NODE-LINK-HERE
      示例订阅源：/auto
      示例订阅源：hy2sub.pages.dev
      ```

   > 订阅源支持多种格式：Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，均可直接填入。

## Workers 部署方法

### 1. 部署 Cloudflare Worker：

   - 在 Cloudflare Worker 控制台中创建一个新的 Worker。
   - 将 [_worker.js](_worker.js) 的内容粘贴到 Worker 编辑器中。


### 2. 修改 订阅入口 ：

  例如您的workers项目域名为：`your-project.workers.dev`；
   - 添加 `TOKEN` 环境变量作为管理页面入口，避免配置页暴露。
     ```
      TOKEN=auto
     ```
   管理地址用于打开配置页面，不再作为客户端订阅地址。客户端请使用 `SUBTOKEN` 生成的 UUID 订阅地址（根据客户端 UA 自动适配格式），例如：
     ```
      /sub?token=YOUR-UUID-HERE
     ```
   如需指定格式，追加对应参数即可：
     ```
      /sub?token=YOUR-UUID-HERE&clash
      /sub?token=YOUR-UUID-HERE&singbox
      /sub?token=YOUR-UUID-HERE&surge
      /sub?token=YOUR-UUID-HERE&quanx
      /sub?token=YOUR-UUID-HERE&loon
     ```


### 3. 添加你的节点或订阅链接：
   1. 绑定**变量名称**为`KV`的**KV命名空间**；
   2. 访问管理地址 `/auto`，添加你的自建节点链接和机场订阅链接，确保每行一个链接，例如：
      ```
      vless://YOUR-NODE-LINK-HERE
      vmess://YOUR-NODE-LINK-HERE
      示例订阅源：/auto
      示例订阅源：hy2sub.pages.dev
      ```

   > 订阅源支持多种格式：Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，均可直接填入。

## 变量说明
| 变量名 | 示例 | 必填 | 备注 | 
|-|-|-|-|
| TOKEN | `auto` | ✅ | 仅用于管理配置页面的入口 Token，例如：`/auto` | 
| SUBTOKEN | `YOUR-UUID-HERE` | ✅ | 客户端订阅 Token，必须为 UUID，例如：`/sub?token=YOUR-UUID-HERE`。也可使用变量名 `SUBUUID` | 
| KV | （KV 命名空间绑定） | ✅（推荐） | 绑定**变量名称**为 `KV` 的 KV 命名空间，用于保存节点/订阅链接、协议过滤配置与分流规则缓存 | 
| LINK | `vless://...`,`vmess://...`,`订阅链接...` | ❌ | 未绑定 KV 时使用：可同时放入多个节点链接与多个订阅链接，链接之间用换行做间隔 | 
| LINKSUB | `https://订阅链接...` | ❌ | 未绑定 KV 时使用：仅填写订阅链接（机场/自建聚合订阅），换行分隔 | 
| PROTOCOL | `vmess,vless,ss` | ❌ | 仅保留指定协议的节点；也可在管理页勾选（存入 KV 的 `PROTOCOL.txt`） | 
| WARP | `warp://...` 或任意节点链接 | ❌ | 追加 WARP 节点到聚合订阅中 | 
| SUBNAME | `CloudSub` | ❌ | 订阅名称 | 
| SUBUPTIME | `6` | ❌ | 客户端订阅自动更新时间（小时），默认 6 | 
| TGTOKEN | `6894123456:***` | ❌ | 发送TG通知的机器人token | 
| TGID | `6946912345` | ❌ | 接收TG通知的账户数字ID | 
| TG | `1` | ❌ | 开发者用：`1` 推送所有访问信息，`0`（默认）不推送 | 
| URL302 | `https://example.com` | ❌ | 未授权访问时的 302 跳转地址 | 
| URL | `https://example.com` | ❌ | 未授权访问时的反向代理目标地址 | 
| SUBAPI | - | ❌ | **已废弃**：全部订阅格式均在 Worker 内本地生成，不再依赖第三方转换后端，无需配置 | 
| SUBCONFIG | - | ❌ | **已废弃**：分流规则使用内置 ACL4SSR 规则集（KV 缓存），无需配置 | 


## 注意事项
- **v2.7.0 起订阅地址变更**：客户端订阅地址为 `/sub?token=<SUBTOKEN>`，`/auto` 仅作为管理页面入口，不再输出订阅内容；
- **`SUBTOKEN` 为必填项**：未配置或格式不正确时，所有请求将返回 500，请务必在部署时设置 UUID 格式的 `SUBTOKEN`（或 `SUBUUID`），且不能与 `TOKEN` 相同；
- 项目中，TGTOKEN和TGID在使用时需要先到Telegram注册并获取。其中，TGTOKEN是telegram bot的凭证，TGID是用来接收通知的telegram用户或者组的id。
