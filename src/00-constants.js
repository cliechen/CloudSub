
// TOKEN 仅用于管理页面；SUBTOKEN/SUBUUID 用于客户端订阅请求。

const DEFAULT_TOKEN = 'auto';
const DEPLOY_VERSION = 'v2.8.2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_FILE_NAME = 'CloudSub';
const DEFAULT_UPDATE_TIME = 6;

//节点链接 + 订阅链接（默认留空，请自行在 env 中配置 LINK 或通过管理页添加）
const DEFAULT_MAIN_DATA = ``;
// ===== 订阅源拉取限制(默认值;可用环境变量覆盖) =====
// SUBMAXSOURCE  聚合订阅源数量上限(默认 50)。注意:免费版 Workers 单请求子请求上限为 50,
//               若同时启用 Clash 规则集拉取(12 个)或源含重定向,建议按需调小。
// SUBMAXSIZE    单个订阅源响应大小上限(字节,默认 10MB)。超大订阅被跳过时会在日志提示调大。
// SUBMAXTOTAL   全部订阅源合计响应大小预算(字节,默认 40MB)。
//               超出预算的源按用户配置顺序(靠后的先跳过),避免大源因“下载慢、完成晚”被误杀。
// SUBMAXTIME    单个订阅源拉取超时(毫秒,默认 20000)。
const DEFAULT_MAX_SUB_SOURCES = 50;
const DEFAULT_MAX_SUB_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SUB_TOTAL_BYTES = 40 * 1024 * 1024;
const DEFAULT_SUB_FETCH_TIMEOUT_MS = 20000;
// 聚合结果节点行数上限(默认 20000)。超大订阅(数万节点)会撑爆 KV 2MiB 缓存上限
// 导致每次请求都全量重拉,这里按行数截断,保证缓存可用且响应可控。
const DEFAULT_MAX_SUB_NODES = 20000;
const HARD_MAX_SUB_NODES = 100000;
const MAX_KV_CONTENT_BYTES = 2 * 1024 * 1024;
// 环境变量可配置值的硬上限(避免误配导致 Worker 内存超限,免费版内存为 128MB)
const HARD_MAX_SUB_RESPONSE_BYTES = 32 * 1024 * 1024;
const HARD_MAX_SUB_TOTAL_BYTES = 64 * 1024 * 1024;
const HARD_MAX_SUB_TIMEOUT_MS = 120000;

// ===== 协议过滤(最后合成大订阅时按协议勾选显示) =====
// 支持过滤的协议类型列表(用于编辑页勾选)
const 支持协议 = ['vmess', 'vless', 'ss', 'ssr', 'trojan', 'hysteria2', 'hysteria', 'tuic', 'wireguard', 'anytls', 'socks', 'http'];

