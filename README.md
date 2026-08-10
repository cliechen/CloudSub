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
      vless://b7a392e2-4ef0-4496-90bc-1c37bb234904@cf.090227.xyz:443?encryption=none&security=tls&sni=edgetunnel-2z2.pages.dev&fp=random&type=ws&host=edgetunnel-2z2.pages.dev&path=%2F%3Fed%3D2048#%E5%8A%A0%E5%85%A5%E6%88%91%E7%9A%84%E9%A2%91%E9%81%93t.me%2FCMLiussss%E8%A7%A3%E9%94%81%E6%9B%B4%E5%A4%9A%E4%BC%98%E9%80%89%E8%8A%82%E7%82%B9
      vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogIuWKoOWFpeaIkeeahOmikemBk3QubWUvQ01MaXVzc3Nz6Kej6ZSB5pu05aSa5LyY6YCJ6IqC54K5PuiLseWbvSDlgKvmlabph5Hono3ln44iLA0KICAiYWRkIjogImNmLjA5MDIyNy54eXoiLA0KICAicG9ydCI6ICI4NDQzIiwNCiAgImlkIjogIjAzZmNjNjE4LWI5M2QtNjc5Ni02YWVkLThhMzhjOTc1ZDU4MSIsDQogICJhaWQiOiAiMCIsDQogICJzY3kiOiAiYXV0byIsDQogICJuZXQiOiAid3MiLA0KICAidHlwZSI6ICJub25lIiwNCiAgImhvc3QiOiAicHBmdjJ0bDl2ZW9qZC1tYWlsbGF6eS5wYWdlcy5kZXYiLA0KICAicGF0aCI6ICIvamFkZXIuZnVuOjQ0My9saW5rdndzIiwNCiAgInRscyI6ICJ0bHMiLA0KICAic25pIjogInBwZnYydGw5dmVvamQtbWFpbGxhenkucGFnZXMuZGV2IiwNCiAgImFscG4iOiAiIiwNCiAgImZwIjogIiINCn0=
      https://sub.xf.free.hr/auto
      https://hy2sub.pages.dev
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
      vless://b7a392e2-4ef0-4496-90bc-1c37bb234904@cf.090227.xyz:443?encryption=none&security=tls&sni=edgetunnel-2z2.pages.dev&fp=random&type=ws&host=edgetunnel-2z2.pages.dev&path=%2F%3Fed%3D2048#%E5%8A%A0%E5%85%A5%E6%88%91%E7%9A%84%E9%A2%91%E9%81%93t.me%2FCMLiussss%E8%A7%A3%E9%94%81%E6%9B%B4%E5%A4%9A%E4%BC%98%E9%80%89%E8%8A%82%E7%82%B9
      vmess://ew0KICAidiI6ICIyIiwNCiAgInBzIjogIuWKoOWFpeaIkeeahOmikemBk3QubWUvQ01MaXVzc3Nz6Kej6ZSB5pu05aSa5LyY6YCJ6IqC54K5PuiLseWbvSDlgKvmlabph5Hono3ln44iLA0KICAiYWRkIjogImNmLjA5MDIyNy54eXoiLA0KICAicG9ydCI6ICI4NDQzIiwNCiAgImlkIjogIjAzZmNjNjE4LWI5M2QtNjc5Ni02YWVkLThhMzhjOTc1ZDU4MSIsDQogICJhaWQiOiAiMCIsDQogICJzY3kiOiAiYXV0byIsDQogICJuZXQiOiAid3MiLA0KICAidHlwZSI6ICJub25lIiwNCiAgImhvc3QiOiAicHBmdjJ0bDl2ZW9qZC1tYWlsbGF6eS5wYWdlcy5kZXYiLA0KICAicGF0aCI6ICIvamFkZXIuZnVuOjQ0My9saW5rdndzIiwNCiAgInRscyI6ICJ0bHMiLA0KICAic25pIjogInBwZnYydGw5dmVvamQtbWFpbGxhenkucGFnZXMuZGV2IiwNCiAgImFscG4iOiAiIiwNCiAgImZwIjogIiINCn0=
      https://sub.xf.free.hr/auto
      https://hy2sub.pages.dev
      ```

   > 订阅源支持多种格式：Clash YAML、sing-box / v2ray JSON、Surge / Loon / Quantumult X 配置、SS JSON、Clash JSON、base64 与明文节点链接，均可直接填入。

</details>

## 📋 变量说明
| 变量名 | 示例 | 必填 | 备注 | 
|-|-|-|-|
| TOKEN | `auto` | ✅ | 仅用于管理配置页面的入口 Token，例如：`/auto` | 
| SUBTOKEN | `550e8400-e29b-41d4-a716-446655440000` | ✅ | 客户端订阅 Token，必须为 UUID，例如：`/sub?token=550e8400-e29b-41d4-a716-446655440000`。也可使用变量名 `SUBUUID` | 
| KV | （KV 命名空间绑定） | ✅（推荐） | 绑定**变量名称**为 `KV` 的 KV 命名空间，用于保存节点/订阅链接、协议过滤配置与分流规则缓存 | 
| LINK | `vless://b7a39...`,`vmess://ew0K...`,`https://sub...` | ❌ | 未绑定 KV 时使用：可同时放入多个节点链接与多个订阅链接，链接之间用换行做间隔 |
| LINKSUB | `https://sub...` | ❌ | 未绑定 KV 时使用：仅填写订阅链接（机场/自建聚合订阅），换行分隔 |
| PROTOCOL | `vmess,vless,ss` | ❌ | 仅保留指定协议的节点；也可在管理页勾选（存入 KV 的 `PROTOCOL.txt`） |
| WARP | `warp://...` 或任意节点链接 | ❌ | 追加 WARP 节点到聚合订阅中 |
| SUBNAME | `CloudSub` | ❌ | 订阅名称 |
| SUBUPTIME | `6` | ❌ | 客户端订阅自动更新时间（小时），默认 6 |
| SUBMAXSOURCE | `50` | ❌ | 聚合订阅源数量上限（默认 50）；免费版 Workers 单请求子请求上限为 50（含 Clash 规则集拉取），源较多时建议调小 |
| SUBMAXSIZE | `10485760` | ❌ | 单个订阅源响应大小上限（字节，默认 10MB）；超大订阅被跳过时在日志中提示调大 |
| SUBMAXTOTAL | `41943040` | ❌ | 全部订阅源合计响应大小预算（字节，默认 40MB）；超出后按配置顺序跳过靠后的源，避免大源因下载慢被误杀 |
| SUBMAXTIME | `20000` | ❌ | 单个订阅源拉取超时（毫秒，默认 20 秒） |
| TGTOKEN | `6894123456:XXXXXXXXXX0qExVsBPUhHDAbXXXXXqWXgBA` | ❌ | 发送TG通知的机器人token | 
| TGID | `6946912345` | ❌ | 接收TG通知的账户数字ID | 
| TG | `1` | ❌ | 开发者用：`1` 推送所有访问信息，`0`（默认）不推送 | 
| URL302 | `https://example.com` | ❌ | 未授权访问时的 302 跳转地址 | 
| URL | `https://example.com` | ❌ | 未授权访问时的反向代理目标地址 | 
| SUBAPI | - | ❌ | **已废弃**：全部订阅格式均在 Worker 内本地生成，不再依赖第三方转换后端，无需配置 | 
| SUBCONFIG | - | ❌ | **已废弃**：分流规则使用内置 ACL4SSR 规则集（KV 缓存），无需配置 | 


## ⚠️ 注意事项
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

## ⭐ Star 星星走起
[![Stargazers over time](https://starchart.cc/cliechen/CloudSub.svg?variant=adaptive)](https://starchart.cc/cliechen/CloudSub)


# 🙏 致谢
[Alice Networks LTD](https://alicenetworks.net/)，[mianayang](https://github.com/mianayang/myself/blob/main/cf-workers/sub/sub.js)、[ACL4SSR](https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config)、[肥羊](https://sub.v1.mk/)
