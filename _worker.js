
// TOKEN 仅用于管理页面；SUBTOKEN/SUBUUID 用于客户端订阅请求。

const DEFAULT_TOKEN = 'auto';
const DEPLOY_VERSION = 'v2.7.6';
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
const MAX_KV_CONTENT_BYTES = 2 * 1024 * 1024;
// 环境变量可配置值的硬上限(避免误配导致 Worker 内存超限,免费版内存为 128MB)
const HARD_MAX_SUB_RESPONSE_BYTES = 32 * 1024 * 1024;
const HARD_MAX_SUB_TOTAL_BYTES = 64 * 1024 * 1024;
const HARD_MAX_SUB_TIMEOUT_MS = 120000;

// ===== 协议过滤(最后合成大订阅时按协议勾选显示) =====
// 支持过滤的协议类型列表(用于编辑页勾选)
const 支持协议 = ['vmess', 'vless', 'ss', 'ssr', 'trojan', 'hysteria2', 'hysteria', 'tuic', 'wireguard', 'anytls', 'socks', 'http'];

// ===== 实例内存热缓存(纯 Worker 内,避免高频请求每次都读 KV) =====
// 聚合结果在“上游未变化”前提下是确定性的,故内存缓存与 KV 缓存可安全并存。
// 注意:Worker 实例可能被回收,内存缓存只是热点加速层,KV 才是权威。
const 内存TTL秒 = 60;
const 内存缓存 = new Map(); // key -> { value, expireAt }
function 内存缓存取(key) {
	const e = 内存缓存.get(key);
	if (!e) return null;
	if (Date.now() > e.expireAt) { 内存缓存.delete(key); return null; }
	return e.value;
}
function 内存缓存放(key, value) {
	if (!value) return;
	if (内存缓存.size >= 1024) { // 简单清理过期项,防止无限增长
		for (const [k, v] of 内存缓存) { if (Date.now() > v.expireAt) 内存缓存.delete(k); }
	}
	内存缓存.set(key, { value, expireAt: Date.now() + 内存TTL秒 * 1000 });
}

// ===== 订阅源条件请求凭据(ETag / Last-Modified)存取 =====
// 用于“有变化才下载”:后台刷新带上上次 ETag,上游返回 304 则不下载 body。
async function 读取源条件(env, urls) {
	if (!env || !env.KV || !urls || urls.length === 0) return null;
	const 表 = {};
	await Promise.all(urls.map(async u => {
		try {
			const raw = await env.KV.get('SUB_ETAG:' + await hashText(u));
			if (raw) { const o = JSON.parse(raw); if (o && (o.etag || o.lastModified)) 表[u] = o; }
		} catch (e) { /* 该源无凭据则做一次普通请求 */ }
	}));
	return Object.keys(表).length ? 表 : null;
}
async function 保存源条件(env, 新表, ttlHours = 24) {
	if (!env || !env.KV || !新表) return;
	await Promise.all(Object.entries(新表).map(async ([u, v]) => {
		try {
			// 与聚合缓存(SUB_AGG)采用相同 TTL,避免 ETag 常驻而聚合缓存已过期:
			// 否则上游返回 304 时因无旧缓存而重建出"缺失所有订阅源节点"的残缺结果。
			await env.KV.put('SUB_ETAG:' + await hashText(u), JSON.stringify(v), { expirationTtl: ttlHours * 3600 });
		} catch (e) { /* 忽略 */ }
	}));
}

// ===== 执行一次聚合刷新并写缓存 =====
// 使用条件请求(ETag)实现“有变化才下载”:多数刷新周期源未变化(304)时不下载 body。
// 返回新的 过滤结果;若全部源都未变化且存在可复用的旧缓存,则“不下载、不重建、仅续期”,返回 null。
async function 执行聚合刷新({ MainData, 订阅链接数组, 协议过滤, 剔除大陆, WARP, env, request, 追加UA, userAgentHeader, fileName, 拉取限制, KV缓存键, 时间戳键, SUBUpdateTime, 写缓存, 旧缓存 }) {
	const etags = await 读取源条件(env, 订阅链接数组);
	const 标记 = {};
	let req_data = MainData;
	if (订阅链接数组.length > 0) {
		let 订阅内容 = await getSUB(订阅链接数组, request, 追加UA, userAgentHeader, fileName, 拉取限制, { etags, 标记 });
		// 全部源 304(未变化)且有旧缓存可复用:沿用旧值,仅续期时间戳,不下载、不重建。
		if (标记.全部未变化 && 旧缓存) {
			if (写缓存 && env.KV) {
				try { await env.KV.put(时间戳键, String(Date.now()), { expirationTtl: SUBUpdateTime * 3600 }); } catch (e) { /* 忽略 */ }
			}
			内存缓存放(KV缓存键, 旧缓存);
			return null;
		}
		// 全部源 304 但无旧缓存(缓存已过期而 ETag 仍有效):不能据 304 重建内容,
		// 必须去条件化重拉一次,否则会缓存一份缺失所有订阅源节点的残缺结果。
		if (标记.全部未变化) {
			console.log('全部源 304 但无旧缓存,已去条件化重拉,避免缓存残缺结果');
			const 新标记 = {};
			订阅内容 = await getSUB(订阅链接数组, request, 追加UA, userAgentHeader, fileName, 拉取限制, { etags: null, 标记: 新标记 });
			标记.新etags = 新标记.新etags || 标记.新etags;
		}
		if (订阅内容.length > 0) req_data += '\n' + 订阅内容.join('\n');
		// 持久化本次获取到的最新源 ETag(与缓存同 TTL,避免 ETag 比缓存活得久)
		if (标记.新etags) await 保存源条件(env, 标记.新etags, SUBUpdateTime);
	}

	if (WARP) {
		const warpNodes = await ADD(WARP);
		if (warpNodes.length > 0) req_data += '\n' + warpNodes.join('\n');
	}
	//去重 + 按协议过滤 (+ 可选剔除大陆节点)
	const text = new TextDecoder().decode(new TextEncoder().encode(req_data));
	let 过滤结果 = 过滤协议节点(节点去重(text), 协议过滤);
	if (剔除大陆) 过滤结果 = 剔除大陆节点(过滤结果);

	if (写缓存 && env.KV && 过滤结果) {
		const bytes = new TextEncoder().encode(过滤结果).byteLength;
		if (bytes <= MAX_KV_CONTENT_BYTES) {
			try {
				await env.KV.put(KV缓存键, 过滤结果, { expirationTtl: SUBUpdateTime * 3600 });
				await env.KV.put(时间戳键, String(Date.now()), { expirationTtl: SUBUpdateTime * 3600 });
			} catch (e) {
				console.error(`聚合缓存写入失败: ${KV缓存键}, ${bytes} 字节, ${e?.message || e}`);
			}
		} else {
			console.error(`聚合结果超过项目 KV 缓存安全上限,跳过缓存: ${KV缓存键}, ${bytes} 字节`);
		}
	}
	内存缓存放(KV缓存键, 过滤结果);
	return 过滤结果;
}

// ===== 触发后台刷新(SWR,访问驱动) =====
// 缓存靠近过期且被访问时,把刷新放到 ctx.waitUntil 后台执行,用户请求不阻塞。
// 双防抖(实例内存 + KV),避免每个请求都去读 KV 防抖键,也避免多实例并发重复调度。
const SWR调度记录 = new Map(); // 防抖键 -> 上次调度时间戳(实例内存)
async function 触发后台刷新(ctx, env, 缓存键, 时间戳键, SUBUpdateTime, 当前值, 刷新参数) {
	try {
		const 防抖键 = 'SUB_REFRESH_AT:' + 缓存键;
		// 1) 实例内存节流:每实例每键每 5 分钟才真正访问 KV 一次
		const 上次数值 = SWR调度记录.get(防抖键) || 0;
		if (Date.now() - 上次数值 < 5 * 60 * 1000) return;
		SWR调度记录.set(防抖键, Date.now());
		// 只有缓存接近 TTL 过期时才刷新。时间戳缺失时按旧缓存处理,避免永久不刷新。
		let 缓存时间 = 0;
		try { 缓存时间 = Number(await env.KV.get(时间戳键) || 0); } catch (e) { /* 按缺失时间戳处理 */ }
		const ttlMs = SUBUpdateTime * 3600 * 1000;
		const refreshWindowMs = Math.max(5 * 60 * 1000, Math.min(ttlMs / 5, 60 * 60 * 1000));
		if (缓存时间 && Date.now() - 缓存时间 < Math.max(0, ttlMs - refreshWindowMs)) return;
		// 2) KV 防抖:防止多实例/多请求并发调度同一刷新
		let 最近刷 = 0;
		try { 最近刷 = Number(await env.KV.get(防抖键) || 0); } catch (e) { 最近刷 = 0; }
		if (Date.now() - 最近刷 < 5 * 60 * 1000) return; // 5 分钟内已调度则跳过
		try { await env.KV.put(防抖键, String(Date.now()), { expirationTtl: 600 }); } catch (e) { return; }
		ctx.waitUntil((async () => {
			try {
				await 执行聚合刷新({ ...刷新参数, 写缓存: true, 旧缓存: 当前值 || null });
			} catch (e) { console.error('后台刷新失败:', e && e.message || e); }
		})());
	} catch (e) { /* 忽略后台刷新调度错误 */ }
}

export default {
	async fetch(request, env, ctx) {
		const userAgentHeader = request.headers.get('User-Agent');
		const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
		const url = new URL(request.url);
		const token = url.searchParams.get('token');
		const adminToken = env.TOKEN || DEFAULT_TOKEN;
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(adminToken)) {
			return new Response('TOKEN 配置无效', { status: 500 });
		}
		const subscriptionToken = env.SUBTOKEN || env.SUBUUID || '';
		if (!UUID_PATTERN.test(subscriptionToken)) {
			return new Response('SUBTOKEN 配置无效，请设置 UUID 格式的 SUBTOKEN 或 SUBUUID', { status: 500 });
		}
		if (subscriptionToken.toLowerCase() === adminToken.toLowerCase()) {
			return new Response('TOKEN 与 SUBTOKEN 不能相同', { status: 500 });
		}
		const BotToken = env.TGTOKEN || '';
		const ChatID = env.TGID || '';
		const TG = Number(env.TG || 0);
		const fileName = String(env.SUBNAME || DEFAULT_FILE_NAME).slice(0, 80);
		const SUBUpdateTime = Math.min(168, Math.max(1, Number(env.SUBUPTIME) || DEFAULT_UPDATE_TIME));

		// 订阅源拉取限制(环境变量覆盖,见常量定义处;均设硬上限防内存超限)
		const 拉取限制 = {
			sources: Math.min(500, Math.max(1, Number(env.SUBMAXSOURCE) || DEFAULT_MAX_SUB_SOURCES)),
			perSource: Math.min(HARD_MAX_SUB_RESPONSE_BYTES, Math.max(1, Number(env.SUBMAXSIZE) || DEFAULT_MAX_SUB_RESPONSE_BYTES)),
			total: Math.min(HARD_MAX_SUB_TOTAL_BYTES, Math.max(1, Number(env.SUBMAXTOTAL) || DEFAULT_MAX_SUB_TOTAL_BYTES)),
			timeout: Math.min(HARD_MAX_SUB_TIMEOUT_MS, Math.max(1000, Number(env.SUBMAXTIME) || DEFAULT_SUB_FETCH_TIMEOUT_MS)),
		};

		let MainData = DEFAULT_MAIN_DATA;
		let urls = [];

		const isPathAdminAuth = url.pathname === `/${adminToken}`;
		const isAdminAuth = token === adminToken || isPathAdminAuth;
		const isSubscriptionAuth = token === subscriptionToken;
		const isManagementRequest = isAdminAuth && userAgent.includes('mozilla') && (
			isPathAdminAuth || (token === adminToken && url.pathname === '/') || (url.searchParams.get('save') === 'protocol' && isAdminAuth)
		);
		if (!(isAdminAuth || isSubscriptionAuth)) {
			if (TG === 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") await sendMessage(`#异常访问 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgent}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID);
			if (env.URL302) return Response.redirect(env.URL302, 302);
			else if (env.URL) return await proxyURL(env.URL, url);
			else return new Response(await nginx(), {
				status: 200,
				headers: {
					'Content-Type': 'text/html; charset=UTF-8',
				},
			});
		} else {
			if (isAdminAuth && !isManagementRequest) {
				return new Response('管理 Token 仅用于配置页面', { status: 403, headers: { 'Cache-Control': 'no-store' } });
			}
			if (!['GET', 'HEAD'].includes(request.method) && !(isManagementRequest && request.method === 'POST')) {
				return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET, HEAD' } });
			}
			if (env.KV) {
				await 迁移地址列表(env, 'LINK.txt');
				if (isManagementRequest) {
					await sendMessage(`#编辑订阅 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID);
					return await KV(request, env, 'LINK.txt', { subscriptionToken, fileName });
				} else {
						MainData = await env.KV.get('LINK.txt') || '';
				}
			} else {
				MainData = env.LINK || '';
				urls = env.LINKSUB ? await ADD(env.LINKSUB) : [];
			}
			// 读取协议过滤配置(用于最后合成大订阅时按协议勾选显示)
			// 来源: KV 命名空间 PROTOCOL.txt,或环境变量 PROTOCOL。值为逗号/分号/换行分隔的协议名列表
			const 协议过滤 = new Set();
			const 协议过滤配置 = env.KV ? await env.KV.get('PROTOCOL.txt') : (env.PROTOCOL || '');
			if (协议过滤配置) {
				for (const p of String(协议过滤配置).split(/[,;\n]+/)) {
					const t = p.trim().toLowerCase();
					if (t) 协议过滤.add(t);
				}
			}
			// 读取「剔除大陆节点」开关(可选项)
			// 来源: KV 命名空间 NOCN.txt,或环境变量 NOCN。值为 1/true/on/yes/开/是 时启用。
			const 剔除大陆 = /^(1|true|on|yes|开|是)$/i.test(String((env.KV ? await env.KV.get('NOCN.txt') : (env.NOCN || '')) || '').trim());

			let 重新汇总所有链接 = await ADD(MainData + '\n' + urls.join('\n'));
			let 自建节点 = "";
			let 订阅链接 = "";
			// 区分“http/https 订阅链接”与“http/https 代理节点”:
			// 形如 http(s)://[user:pass@]host:port[#name] 或结尾是 host:port 的,是节点而非订阅地址。
			// 否则会把 http 代理节点误当远程订阅去拉取。
			const 是Http节点 = (x) => /^https?:\/\//i.test(x)
				&& (/^https?:\/\/[^/]*@[^/]+:\d+/i.test(x) || /^https?:\/\/[^/]+:\d+([?#]|$)/i.test(x));
			for (let x of 重新汇总所有链接) {
				if (/^https?:\/\//i.test(x) && !是Http节点(x)) {
					订阅链接 += x + '\n';
				} else {
					自建节点 += x + '\n';
				}
			}
			MainData = 自建节点;
			urls = await ADD(订阅链接);
			await sendMessage(`#获取订阅 ${fileName}`, request.headers.get('CF-Connecting-IP'), `UA: ${userAgentHeader}</tg-spoiler>\n域名: ${url.hostname}\n<tg-spoiler>入口: ${url.pathname}</tg-spoiler>`, BotToken, ChatID);
			const isSubConverterRequest = request.headers.get('subconverter-request') || request.headers.get('subconverter-version') || userAgent.includes('subconverter');
			let 订阅格式 = 'base64';
			if (!(userAgent.includes('null') || isSubConverterRequest || userAgent.includes('nekobox') || userAgent.includes(('CloudSub').toLowerCase()))) {
				if (userAgent.includes('sing-box') || userAgent.includes('singbox') || url.searchParams.has('sb') || url.searchParams.has('singbox')) {
					订阅格式 = 'singbox';
				} else if (userAgent.includes('surge') || url.searchParams.has('surge')) {
					订阅格式 = 'surge';
				} else if (userAgent.includes('quantumult') || url.searchParams.has('quanx')) {
					订阅格式 = 'quanx';
				} else if (userAgent.includes('loon') || url.searchParams.has('loon')) {
					订阅格式 = 'loon';
				} else if (userAgent.includes('clash') || userAgent.includes('meta') || userAgent.includes('mihomo') || url.searchParams.has('clash')) {
					订阅格式 = 'clash';
				}
			}

			// 追加UA 仅用于 getSUB 拉取上游时的标识;格式仍在下方按 订阅格式 本地生成
			let 追加UA = 'v2rayn';
			if (url.searchParams.has('b64') || url.searchParams.has('base64')) 订阅格式 = 'base64';
			else if (url.searchParams.has('clash')) 追加UA = 'clash';
			else if (url.searchParams.has('singbox')) 追加UA = 'singbox';
			else if (url.searchParams.has('surge')) 追加UA = 'surge';
			else if (url.searchParams.has('quanx')) 追加UA = 'Quantumult%20X';
			else if (url.searchParams.has('loon')) 追加UA = 'Loon';

			const 订阅链接数组 = [...new Set(urls)].filter(item => item?.trim?.()).slice(0, 拉取限制.sources); // 去重并限制来源数量

			// ===== 聚合结果缓存(性能优化) =====
			// 把「聚合、去重、按协议过滤后的最终节点文本」按 自建节点+订阅源列表+协议过滤+WARP
			// 的哈希缓存在 KV(SUB_AGG:<sha256>),一份缓存服务所有格式(base64/clash/singbox/...)。
			// 三层机制降低资源占用:
			//  1) 实例内存热缓存(秒级):命中则完全不碰 KV、不拉上游;
			//  2) KV 缓存(TTL=SUBUPTIME):跨实例复用;
			//  3) SWR + 条件请求:缓存靠近过期且被访问时,在后台(ctx.waitUntil)用
			//     ETag/Last-Modified 刷新——上游全 304 则“不下载、不重建、仅续期”,真正变化才下载;
			//  4) 防惊群锁:缓存 cold 时仅一个请求承担全量拉取,其余等待读取结果。
			// 追加 &refresh 强制重建;未绑定 KV 时退化为实时聚合。
			const 缓存因子 = [MainData, 订阅链接数组.join('\n'), [...协议过滤].sort().join(','), env.WARP || '', 剔除大陆 ? '1' : '0'].join('\u0001');
			const 缓存键 = await hashText(缓存因子);
			const KV缓存键 = 'SUB_AGG:' + 缓存键;
			const 时间戳键 = 'SUB_AGG_AT:' + 缓存键;
			const 强制刷新 = url.searchParams.has('refresh');
			const 刷新参数 = { MainData, 订阅链接数组, 协议过滤, 剔除大陆, WARP: env.WARP || '', env, request, 追加UA, userAgentHeader, fileName, 拉取限制, KV缓存键, 时间戳键, SUBUpdateTime };

			// 1) 实例内存热缓存
			let 过滤结果 = (!强制刷新) ? 内存缓存取(KV缓存键) : null;

			// 2) KV 缓存
			let KV值 = '';
			if (!过滤结果 && env.KV) {
				try { KV值 = await env.KV.get(KV缓存键) || ''; } catch (e) { KV值 = ''; }
				过滤结果 = (!强制刷新) ? (KV值 || null) : null;
			}

			if (过滤结果) {
				if (!KV值) 内存缓存放(KV缓存键, 过滤结果); // 来自内存或 KV,均回填内存热缓存
				// 3) SWR:缓存靠近过期且被访问时,后台续期/刷新(本请求不阻塞)
				if (KV值 && ctx && env.KV && !强制刷新 && 订阅链接数组.length > 0) {
					await 触发后台刷新(ctx, env, 缓存键, 时间戳键, SUBUpdateTime, 过滤结果, 刷新参数);
				}
			} else {
				// 4) 缓存 cold 或强制刷新:以防惊群锁方式同步重建
				const 锁键 = 'SUB_LOCK:' + 缓存键;
				let 拿锁 = false;
				try {
					if (env.KV) {
						const 已有锁 = await env.KV.get(锁键);
						if (!已有锁) {
							await env.KV.put(锁键, String(Date.now()), { expirationTtl: 120 });
							拿锁 = true;
						}
					} else { 拿锁 = true; }
				} catch (e) { 拿锁 = true; } // 无 KV 或失败则直接在本请求内重建
				if (拿锁) {
					try {
						过滤结果 = await 执行聚合刷新({ ...刷新参数, 写缓存: !!env.KV, 旧缓存: null });
					} finally {
						if (env.KV) { try { await env.KV.delete(锁键); } catch (e) { /* 忽略 */ } }
					}
				} else if (env.KV) {
					// 其它请求正在重建:短等待后读取 KV 结果(最多约 4 次)
					for (let i = 0; i < 4 && !过滤结果; i++) {
						await new Promise(r => setTimeout(r, 200));
						try { 过滤结果 = await env.KV.get(KV缓存键) || ''; } catch (e) { 过滤结果 = ''; }
					}
				}
				// 仍未取到(无 KV 或等待超时):直接同步聚合兜底
				if (!过滤结果) {
					过滤结果 = await 执行聚合刷新({ ...刷新参数, 写缓存: !!env.KV, 旧缓存: null }) || '';
				}
				if (过滤结果) 内存缓存放(KV缓存键, 过滤结果);
			}
			过滤结果 = 过滤结果 || '';



			// 构建响应头对象
			const responseHeaders = {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"Profile-Update-Interval": `${SUBUpdateTime}`,
				"Profile-web-page-url": request.url.includes('?') ? request.url.split('?')[0] : request.url,
				//"Subscription-Userinfo": `upload=${UD}; download=${UD}; total=${total}; expire=${expire}`,
			};

			if (订阅格式 == 'base64') {
				// 仅 base64 需编码(懒计算):clash/singbox/surge/qx/loon 等不走此分支,
				// 避免对 2MB 级大订阅每次做一次无谓的 base64 编码。
				let base64Data;
				try {
					base64Data = btoa(过滤结果);
				} catch (e) {
					// btoa 对非 Latin1 字符串抛错,回退为 UTF-8 -> base64(处理含中文的订阅名)
					const binary = new TextEncoder().encode(过滤结果);
					let base64 = '';
					const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
					for (let i = 0; i < binary.length; i += 3) {
						const byte1 = binary[i];
						const byte2 = binary[i + 1] || 0;
						const byte3 = binary[i + 2] || 0;
						base64 += chars[byte1 >> 2];
						base64 += chars[((byte1 & 3) << 4) | (byte2 >> 4)];
						base64 += chars[((byte2 & 15) << 2) | (byte3 >> 6)];
						base64 += chars[byte3 & 63];
					}
					const padding = 3 - (binary.length % 3 || 3);
					base64Data = base64.slice(0, base64.length - padding) + '=='.slice(0, padding);
				}
				return new Response(base64Data, { headers: responseHeaders });
			} else if (订阅格式 == 'clash') {
			} else if (订阅格式 == 'clash') {
				// ===== 方案A:本地生成 Clash 配置,不依赖第三方 SUBAPI =====
				// 分流规则优先使用 KV 缓存的 ACL4SSR 规则集,无 KV 时回退内置精简规则
				const 本地Clash配置 = await 生成本地Clash配置(过滤结果, env, fileName);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Clash配置, { headers: responseHeaders });
			} else if (订阅格式 == 'singbox') {
				// ===== 方案A:本地生成 sing-box 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,再转换为 sing-box outbounds + route
				const 本地Singbox配置 = await 生成本地Singbox配置(过滤结果, env, fileName);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Singbox配置, { headers: responseHeaders });
			} else if (订阅格式 == 'surge') {
				// ===== 方案A:本地生成 Surge 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 Surge [Proxy] + [Proxy Group] + [Rule]
				// 注意:Surge 不支持 vless / ssr / hysteria(v1),这些协议的节点会被自动跳过
				const 本地Surge配置 = await 生成本地Surge配置(过滤结果, env, fileName, request.url);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Surge配置, { headers: responseHeaders });
			} else if (订阅格式 == 'quanx') {
				// ===== 方案A:本地生成 Quantumult X 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 [server_local] + [policy] + [filter_local]
				// 注意:QX 不支持 tuic/wireguard/socks5/anytls,这些协议节点会被自动跳过
				const 本地Quanx配置 = await 生成本地Quanx配置(过滤结果, env, fileName);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Quanx配置, { headers: responseHeaders });
			} else if (订阅格式 == 'loon') {
				// ===== 方案A:本地生成 Loon 配置,不依赖第三方 SUBAPI =====
				// 复用 uriToClashProxy 解析节点,转换为 [Proxy] + [Proxy Group] + [Rule]
				// 注意:Loon 不支持 socks5/tuic/anytls,这些协议节点会被自动跳过
				const 本地Loon配置 = await 生成本地Loon配置(过滤结果, env, fileName);
				if (!userAgent.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(fileName)}`;
				return new Response(本地Loon配置, { headers: responseHeaders });
			}
			// 注:clash/singbox/surge/quanx/loon 均已本地生成,不再调用第三方 SUBAPI 转换
		}
	}
};

async function ADD(envadd) {
	var addtext = envadd.replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n');	// 替换为换行
	//console.log(addtext);
	if (addtext.charAt(0) == '\n') addtext = addtext.slice(1);
	if (addtext.charAt(addtext.length - 1) == '\n') addtext = addtext.slice(0, addtext.length - 1);
	const add = addtext.split('\n');
	//console.log(add);
	return add;
}

async function nginx() {
	const text = `
	<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
	`
	return text;
}

async function sendMessage(type, ip, add_data = "", botToken = '', chatID = '') {
	if (botToken !== '' && chatID !== '') {
		let msg = "";
		const response = await fetch(`https://ip-api.com/json/${encodeURIComponent(ip || '')}?lang=zh-CN`, { signal: AbortSignal.timeout(3000) });
		if (response.status == 200) {
			const ipInfo = await response.json();
			msg = `${telegramEscape(type)}\nIP: ${telegramEscape(ip)}\n国家: ${telegramEscape(ipInfo.country)}\n<tg-spoiler>城市: ${telegramEscape(ipInfo.city)}\n组织: ${telegramEscape(ipInfo.org)}\nASN: ${telegramEscape(ipInfo.as)}\n${telegramEscape(add_data)}`;
		} else {
			msg = `${telegramEscape(type)}\nIP: ${telegramEscape(ip)}\n<tg-spoiler>${telegramEscape(add_data)}`;
		}

		let url = "https://api.telegram.org/bot" + botToken + "/sendMessage?chat_id=" + chatID + "&parse_mode=HTML&text=" + encodeURIComponent(msg);
		return fetch(url, {
			method: 'get',
			headers: {
				'Accept': 'text/html,application/xhtml+xml,application/xml;',
				'Accept-Encoding': 'gzip, deflate, br',
				'User-Agent': 'Mozilla/5.0 Chrome/90.0.4430.72'
			}
		});
	}
}

function base64Decode(str) {
	str = String(str);
	// 容错:部分订阅源/base64 段落带换行/空格,且长度不整除 4(缺 padding)。
	// 若不处理,Cloudflare 的 atob 会抛异常导致整个源解析失败。
	str = str.replace(/\s+/g, '');
	const pad = (4 - (str.length % 4)) % 4;
	if (pad) str += '==='.slice(0, pad);
	str = str.replace(/-/g, '+').replace(/_/g, '/');
	const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
	const decoder = new TextDecoder('utf-8');
	return decoder.decode(bytes);
}

// 对文本做 SHA-256 哈希,返回 64 位十六进制字符串(确定性,用于聚合结果 KV 缓存键)。
// 原 MD5MD5 为未使用的死代码,移除并替换为本函数。
async function hashText(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function proxyURL(proxyURL, url) {
	const URLs = await ADD(proxyURL);
	const fullURL = URLs[Math.floor(Math.random() * URLs.length)];

	// 解析目标 URL
	let parsedURL = new URL(fullURL);
	// 提取并可能修改 URL 组件
	let URLProtocol = parsedURL.protocol.slice(0, -1) || 'https';
	let URLHostname = parsedURL.hostname;
	let URLPathname = parsedURL.pathname;

	// 处理 pathname
	if (URLPathname.charAt(URLPathname.length - 1) == '/') {
		URLPathname = URLPathname.slice(0, -1);
	}
	URLPathname += url.pathname;

	// 构建新的 URL:转发「请求」的查询串(如 /sub?token=...)而不是代理源自身的查询串,
	// 否则反向代理目标拿不到客户端参数。
	let newURL = `${URLProtocol}://${URLHostname}${URLPathname}${url.search}`;

	// 反向代理请求
	let response = await fetch(newURL);

	// 创建新的响应
	let newResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});

	// 添加自定义头部，包含 URL 信息
	//newResponse.headers.set('X-Proxied-By', 'Cloudflare Worker');
	//newResponse.headers.set('X-Original-URL', fullURL);
	// Do not expose the resolved target URL, which may contain credentials or private paths.

	return newResponse;
}

// 拉取并解析所有订阅源,返回节点 URI 行数组。
// 为避免"大链接拉取不完整":
//  - 单个源超过单源上限(SUBMAXSIZE)时整源跳过并记录日志,可调大 SUBMAXSIZE;
//  - 全部源合计按总预算(SUBMAXTOTAL)兜底:已知大小(content-length)的源按声明大小
//    预留预算,未知大小(分块传输/动态生成/压缩)的源按较小名义值参与预算分配,
//    未知/压缩源的实际读取量由读取阶段流式共享预算兜底,不会突破总预算;
//  - 压缩响应(content-encoding)的 content-length 为压缩后大小,不再作为拒绝依据,
//    避免大订阅因声明大小误导而被整源丢弃。
async function getSUB(api, request, 追加UA, userAgentHeader, fileName = DEFAULT_FILE_NAME, 限制 = {}, opts = {}) {
	const { etags = null, 标记 = {} } = opts || {};
	const 源上限 = Math.max(1, 限制.sources || DEFAULT_MAX_SUB_SOURCES);
	const 单源上限 = Math.max(1, 限制.perSource || DEFAULT_MAX_SUB_RESPONSE_BYTES);
	const 总预算 = Math.max(1, 限制.total || DEFAULT_MAX_SUB_TOTAL_BYTES);
	const 超时 = Math.max(1000, 限制.timeout || DEFAULT_SUB_FETCH_TIMEOUT_MS);
	// 未知长度订阅源(分块传输/动态生成/压缩响应)在预算分配时按较小名义值估算,
	// 避免每个源都被按单源上限估算、默认预算(40MB)下只能保留少量来源。
	const 未知长度估算 = Math.min(单源上限, 512 * 1024);

	if (!api || api.length === 0) return [];
	api = [...new Set(api)].slice(0, 源上限); // 去重并限制来源数量
	if (api.length === 0) return [];

	let newapi = "";
	let 已用预算 = 0;
	let 未变化数 = 0; // 条件请求下返回 304(内容未变化)的源数量
	const 释放连接 = response => { try { if (response.body) response.body.cancel().catch(() => {}); } catch (e) { /* 忽略 */ } };

	// 阶段1: 并行发起请求(只等响应头,不读 body)。
	// 失败(网络错误/5xx/429)的源自动重试一次,缓解 raw.githubusercontent 等源常见的
	// 瞬时连接失败导致整源丢失的问题;超时(AbortError)不重试,避免成倍拉长请求时间。
	// 重试额度:免费版单请求子请求上限为 50,每次重试(含重定向)都会额外消耗子请求,
	// 这里限制全部源的重试总次数,避免大量源同时失败时把子请求数翻倍突破上限。
	let 剩余重试 = Math.min(10, Math.max(2, Math.floor(api.length / 3)));
	const 请求一个源 = async (apiUrl) => {
		const 尝试 = () => getUrl(request, apiUrl, 追加UA, userAgentHeader, AbortSignal.timeout(超时), (etags && etags[apiUrl]) || null);
		const 若可重试 = () => {
			if (剩余重试 <= 0) return null;
			剩余重试--;
			return 尝试();
		};
		try {
			const response = await 尝试();
			// 条件请求命中:上游内容未变化(304),无需下载 body
			if (response.status === 304) { 释放连接(response); return { __未变化: true }; }
			if (response.ok || !(response.status === 429 || response.status >= 500)) return response;
			释放连接(response);
			const retryAfter = Number(response.headers.get('retry-after')) || 1; // 尊重服务端退避建议
			await new Promise(r => setTimeout(r, Math.min(3000, retryAfter * 1000)));
			const 重试请求 = 若可重试();
			return 重试请求 ? await 重试请求 : response; // 额度耗尽则按原响应处理
		} catch (e) {
			if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e;
			await new Promise(r => setTimeout(r, 500));
			const 重试请求 = 若可重试();
			if (!重试请求) throw e; // 重试额度耗尽,按原错误处理
			return await 重试请求; // 连接/DNS 等网络级错误重试一次
		}
	};
	const 响应结果 = await Promise.allSettled(api.map(apiUrl => 请求一个源(apiUrl)));

	// 阶段2: 按用户配置顺序分配预算并确定各源读取策略。
	//  - 未压缩且有 content-length:按声明大小估算(受单源上限约束);
	//  - 压缩或未知长度:声明不可信/不存在,按较小名义值估算。
	// 超出总预算的源跳过并释放连接(连接数与子请求数因此可控)。
	const 接受的 = [];
	for (let i = 0; i < 响应结果.length; i++) {
		const r = 响应结果[i];
		const 值 = r.status === 'fulfilled' ? r.value : null;
		if (值 && 值.__未变化) { 未变化数++; continue; }
		if (r.status !== 'fulfilled') {
			const reason = r.reason;
			if (reason && (reason.name === 'AbortError' || reason.name === 'TimeoutError')) {
				console.log(`订阅源请求超时: ${maskUrl(api[i])}`);
			} else {
				console.error(`订阅源请求失败: ${maskUrl(api[i])}, 状态: ${reason?.status || reason?.message || 'unknown'}`);
			}
			continue;
		}
		const response = r.value;
		if (response.status === 304) { 未变化数++; 释放连接(response); continue; }
		if (!response.ok) {
			console.error(`订阅源请求失败: ${maskUrl(api[i])}, HTTP ${response.status}`);
			释放连接(response);
			continue;
		}
		// 记录该源最新的 ETag / Last-Modified,供下一次条件请求使用(有变化才下载的凭据)
		const _etag = response.headers.get('etag') || '';
		const _lm = response.headers.get('last-modified') || '';
		if (_etag || _lm) {
			标记.新etags = 标记.新etags || {};
			标记.新etags[api[i]] = { etag: _etag, lastModified: _lm };
		}
		const 压缩 = !!response.headers.get('content-encoding');
		const declared = 压缩 ? 0 : Number(response.headers.get('content-length') || 0);
		// 未压缩且声明大小超过单源上限:整源跳过,避免无谓下载(压缩响应声明不可信,跳过该检查)
		if (!压缩 && declared > 单源上限) {
			console.log(`订阅源响应超过单源上限,已跳过: ${maskUrl(api[i])}, 大小: ${declared} 字节(可调大 SUBMAXSIZE)`);
			释放连接(response);
			continue;
		}
		const 估算 = declared > 0 ? Math.min(declared, 单源上限) : 未知长度估算;
		if (已用预算 + 估算 > 总预算) {
			console.log(`订阅源超出合计预算,已跳过: ${maskUrl(api[i])}(可调大 SUBMAXTOTAL)`);
			释放连接(response);
			continue;
		}
		已用预算 += 估算;
		接受的.push({ apiUrl: api[i], response, declared, 压缩 });
	}
	// 全部源都 304:聚合内容未变化(后台刷新时借此“不下载、不重建、仅续期”)
	标记.全部未变化 = 接受的.length === 0 && 未变化数 === api.length;
	if (接受的.length === 0) return [];

	// 阶段3: 读取已接受源的 body(受单源上限与共享预算约束);瞬时读取失败(连接重置等)
	// 自动重试一次,避免整源因网络抖动丢失。
	//  - 未压缩已知长度源:并行读取,读取上限 = 单源上限,阶段2已按声明大小预留预算;
	//  - 压缩源:声明(压缩后大小)不可信,按总预算读取(实际受共享预算约束),完整保留大订阅;
	//  - 未知长度源:按单源上限读取;未知与压缩源按配置顺序小并发读取(先配置的源优先
	//    开始读取、优先占用预算),合计读取量由共享预算兜底,避免大源被“完成晚”误杀。
	const 读取重试 = async (apiUrl, response, 读取上限, 预算) => {
		// 共享预算按本次读取精确扣减并统计,失败时归还,避免重试被自己先前耗尽的预算误杀
		const 尝试读取 = async (resp) => {
			const 本次消耗 = 预算 ? { bytes: 0 } : null;
			try {
				return await readLimitedResponse(resp, 读取上限, 预算, 本次消耗);
			} catch (e) {
				if (预算 && 本次消耗 && 本次消耗.bytes > 0) 预算.remaining += 本次消耗.bytes; // 归还本次读取占用的预算
				throw e;
			}
		};
		try {
			return await 尝试读取(response);
		} catch (e) {
			if (e && (e.name === 'AbortError' || e.name === 'TimeoutError' || e.code === 'SUB_LIMIT')) throw e;
			await new Promise(r => setTimeout(r, 300)); // 网络级瞬时错误,短暂退避后重新拉取一次
			释放连接(response);
			const 重试响应 = await getUrl(request, apiUrl, 追加UA, userAgentHeader, AbortSignal.timeout(超时));
			if (!重试响应.ok) { 释放连接(重试响应); throw new Error('重试仍失败: HTTP ' + 重试响应.status); }
			return await 尝试读取(重试响应);
		}
	};
	const 已知源 = 接受的.filter(x => x.declared > 0);
	const 未知源 = 接受的.filter(x => x.declared <= 0);
	const 已预留已知 = 已知源.reduce((s, x) => s + Math.min(x.declared, 单源上限), 0);
	const 共享预算 = { remaining: Math.max(0, 总预算 - 已预留已知) };
	const 已知结果 = await Promise.allSettled(已知源.map(({ apiUrl, response }) =>
		读取重试(apiUrl, response, 单源上限, null)
			.then(content => ({ apiUrl, content }))
			.catch(err => { if (err && typeof err === 'object') err.apiUrl = apiUrl; throw err; })
	));
	const 未知结果 = await 有界并发执行(未知源, 8, async ({ apiUrl, response, 压缩 }) =>
		读取重试(apiUrl, response, 压缩 ? 总预算 : 单源上限, 共享预算)
			.then(content => ({ apiUrl, content }))
	);
	const 内容结果 = [...已知结果, ...未知结果];

	// 阶段4: 按源顺序解析并聚合(已接受的内容不再因后续预算问题丢失)
	for (const r of 内容结果) {
		if (r.status !== 'fulfilled') {
			const reason = r.reason;
			const 错误描述 = (reason && (reason.name === 'AbortError' || reason.name === 'TimeoutError'))
				? '读取超时(可调大 SUBMAXTIME)'
				: (reason?.message || reason);
			console.error(`订阅源读取失败: ${maskUrl(reason?.apiUrl || '')}, 错误: ${错误描述}`);
			continue;
		}
		const { apiUrl, content } = r.value;
		try {
			// 统一本地解析:Clash YAML / sing-box / v2ray / SS JSON / Surge / Loon / QX / base64 / 明文
			const parsed = 本地解析订阅内容(content, fileName);
			if (parsed && parsed.type === 'uris') {
				// 已本地识别并解析为节点 URI
				newapi += parsed.text + '\n';
			} else if (parsed && parsed.type === 'raw') {
				// 明文节点链接:原样保留,由后续 uriToClashProxy 统一解析
				newapi += parsed.text + '\n';
			} else {
				// 响应内容无法识别为任何节点格式(异常/站点页等),仅记录日志便于排查
				console.log(`未能识别的订阅来源: ${maskUrl(apiUrl)}`);
			}
		} catch (e) {
			// 单个订阅源解析失败不影响其他来源的聚合
			console.error(`订阅源解析失败: ${maskUrl(apiUrl)}, 错误: ${e?.message || e}`);
		}
	}

	// 将处理后的内容转换为数组(已全部本地解析,不再依赖任何第三方转换后端)
	return await ADD(newapi);
}

// 有界并发执行任务列表:按传入顺序发起(先配置的源优先开始读取、优先占用共享预算),
// 返回与 Promise.allSettled 相同结构的结果数组(顺序为完成顺序,不影响后续聚合)。
async function 有界并发执行(items, limit, fn) {
	const results = [];
	const queue = items.slice();
	await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
		while (queue.length) {
			const item = queue.shift();
			try {
				results.push({ status: 'fulfilled', value: await fn(item) });
			} catch (err) {
				if (err && typeof err === 'object') err.apiUrl = err.apiUrl || item.apiUrl;
				results.push({ status: 'rejected', reason: err });
			}
		}
	}));
	return results;
}

async function getUrl(request, targetUrl, 追加UA, userAgentHeader, signal, 条件 = null) {
	const newHeaders = new Headers();
	newHeaders.set("User-Agent", `${atob('djJyYXlOLzYuNDU=')} cliechen/CloudSub ${追加UA}(${userAgentHeader || 'null'})`);
	newHeaders.set("Accept", request.headers.get('Accept') || '*/*');

	// 条件请求:带上次拉取的 ETag / Last-Modified,上游若返回 304 表示内容未变化,
	// 从而避免重复下载 body(用于后台刷新时的“有变化才下载”)。
	if (条件) {
		if (条件.etag) newHeaders.set('If-None-Match', 条件.etag);
		if (条件.lastModified) newHeaders.set('If-Modified-Since', 条件.lastModified);
	}

	// 构建新的请求对象
	const modifiedRequest = new Request(targetUrl, {
		method: 'GET',
		headers: newHeaders,
		redirect: "follow",
		signal
	});
	return fetch(modifiedRequest);
}

function telegramEscape(value) {
	return String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])).slice(0, 2000);
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, char => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;'
	}[char]));
}

function escapeJs(value) {
	return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function readLimitedResponse(response, maxBytes, 共享预算 = null, 本次消耗 = null) {
	// 压缩响应(content-encoding)的 content-length 是压缩后大小,不代表解压后的实际读取量
	const contentLength = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length') || 0);
	if (contentLength > maxBytes) { const e = new Error('订阅响应超过大小限制(可调大 SUBMAXSIZE)'); e.code = 'SUB_LIMIT'; throw e; }
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) { const e = new Error('订阅响应超过大小限制(可调大 SUBMAXSIZE)'); e.code = 'SUB_LIMIT'; throw e; }
			// 共享预算:多个未知长度/压缩源并行读取时按到达顺序流式扣减,总读取量不超过预算
			if (共享预算) {
				if (value.byteLength > 共享预算.remaining) { const e = new Error('订阅源超出合计预算(可调大 SUBMAXTOTAL)'); e.code = 'SUB_LIMIT'; throw e; }
				共享预算.remaining -= value.byteLength;
				if (本次消耗) 本次消耗.bytes += value.byteLength;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(merged);
}

function maskUrl(value) {
	try {
		const parsed = new URL(value);
		parsed.username = '';
		parsed.password = '';
		parsed.search = '';
		return parsed.toString();
	} catch { return '[invalid-url]'; }
}

function isValidBase64(str) {
	// 先移除所有空白字符(空格、换行、回车等)
	const cleanStr = str.replace(/\s/g, '');
	const base64Regex = /^[A-Za-z0-9+/=_-]+$/; // 兼容 URL-safe base64(-/_)
	return base64Regex.test(cleanStr);
}

// ==================== Clash YAML 订阅解析 (合成大订阅) ====================
// 解析 Clash YAML 中的 proxies 列表,并将每个节点对象转换为订阅 URI,
// 从而可以把 .yaml/.yml 格式的订阅直接合并进大订阅。

function parseYamlValue(v) {
	v = String(v).trim();
	// 去掉引号(兼容行内注释,如 name: "x" # 备注);引号包裹的值始终是字符串,
	// 不会被后面的布尔/空值判断误伤(如 "off" 应保持字符串 "off")。
	// 注意逐字符扫描闭合引号并处理转义:双引号用 \" 转义,单引号用 '' 转义,
	// 否则含转义引号的名称(如 "q\"uote"、'it''s')会被错误截断。
	if (v.startsWith('"')) {
		let out = '';
		for (let i = 1; i < v.length; i++) {
			const c = v[i];
			if (c === '"') return out; // 闭合
			if (c === '\\' && i + 1 < v.length) {
				const n = v[i + 1];
				if (n === '"') { out += '"'; i++; continue; }
				if (n === '\\') { out += '\\'; i++; continue; }
				if (n === 'n') { out += '\n'; i++; continue; }
				if (n === 't') { out += '\t'; i++; continue; }
				out += c + n; i++; continue;
			}
			out += c;
		}
		// 未找到闭合引号:视为整段普通字符串(保留原样,避免误伤)
		return v.slice(1);
	}
	if (v.startsWith("'")) {
		let out = '';
		for (let i = 1; i < v.length; i++) {
			const c = v[i];
			if (c === "'") {
				if (v[i + 1] === "'") { out += "'"; i++; continue; } // '' 转义单引号
				return out; // 闭合
			}
			out += c;
		}
		return v.slice(1);
	}
	// 去掉行内注释,如 `port: 443 # 端口`、`tls: false # 关闭`(注释需先于布尔/数字解析,
	// 否则 `false # 关闭` 会被当成真值字符串 "false",导致 TLS 被错误启用)。
	const commentIdx = v.indexOf(' #');
	if (commentIdx > 0) v = v.slice(0, commentIdx).trim();
	if (v === '' || v === '~') return null;
	const lower = v.toLowerCase();
	// YAML 1.1 布尔/空值词: yes/no/on/off 与 true/false 等价(大小写不敏感)。
	// 例如 `sni: off` 应解析为布尔 false(表示未设置 SNI),而不是字符串 "off",
	// 否则聚合后会输出 `sni: "off"`,让客户端把 "off" 当作真实 SNI 使用;
	// `tls: off` 也应解析为 false,而不是被当成真值从而错误启用 TLS。
	// 注意:不把单个 y/n 视为布尔(Mihomo 的 yaml.v3 只认 true/false),
	// 避免误伤合法的单字符字符串值。
	if (['null'].includes(lower)) return null;
	if (['true', 'yes', 'on'].includes(lower)) return true;
	if (['false', 'no', 'off'].includes(lower)) return false;
	if (/^-?\d+$/.test(v)) return parseInt(v, 10);
	if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
	return v;
}

// 解析一段字典块,起始行缩进为 indent,返回 { obj, index }
function parseYamlBlock(lines, start, indent) {
	const obj = {};
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }
		const curIndent = line.search(/\S/);
		if (curIndent < indent) break;
		if (curIndent > indent) { i++; continue; }
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) { i++; continue; }
		const key = trimmed.slice(0, colonIdx).trim();
		const val = trimmed.slice(colonIdx + 1).trim();
		if (val !== '') { obj[key] = parseYamlValue(val); i++; continue; }
		// 值为空 -> 嵌套对象/列表
		if (i + 1 >= lines.length) { obj[key] = null; i++; continue; }
		const nextIndent = lines[i + 1].search(/\S/);
		if (nextIndent <= curIndent) { obj[key] = null; i++; continue; }
		if (lines[i + 1].trim().startsWith('- ')) {
			const r = parseYamlList(lines, i + 1, nextIndent);
			obj[key] = r.obj; i = r.index;
		} else {
			const r = parseYamlBlock(lines, i + 1, nextIndent);
			obj[key] = r.obj; i = r.index;
		}
	}
	return { obj, index: i };
}

// 解析一段列表块,起始行缩进为 indent,返回 { obj, index }
function parseYamlList(lines, start, indent) {
	const arr = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }
		const curIndent = line.search(/\S/);
		if (curIndent < indent) break;
		if (curIndent > indent) { i++; continue; }
		if (!trimmed.startsWith('- ')) break;
		const itemText = trimmed.slice(2).trim();
		const itemIndent = curIndent;
		if (itemText === '') {
			// 列表项是纯嵌套块
			if (i + 1 >= lines.length) { arr.push(null); i++; continue; }
			const nextIndent = lines[i + 1].search(/\S/);
			if (nextIndent <= itemIndent) { arr.push(null); i++; continue; }
			const r = lines[i + 1].trim().startsWith('- ')
				? parseYamlList(lines, i + 1, nextIndent)
				: parseYamlBlock(lines, i + 1, nextIndent);
			arr.push(r.obj); i = r.index;
			continue;
		}
		const colonIdx = itemText.indexOf(':');
		if (colonIdx === -1) { arr.push(parseYamlValue(itemText)); i++; continue; }
		const key = itemText.slice(0, colonIdx).trim();
		const val = itemText.slice(colonIdx + 1).trim();
		const item = {};
		if (val === '') {
			if (i + 1 < lines.length) {
				const nextIndent = lines[i + 1].search(/\S/);
				if (nextIndent > itemIndent) {
					const r = lines[i + 1].trim().startsWith('- ')
						? parseYamlList(lines, i + 1, nextIndent)
						: parseYamlBlock(lines, i + 1, nextIndent);
					item[key] = r.obj;
					i = r.index;
				} else { item[key] = null; i++; }
			} else { item[key] = null; i++; }
		} else {
			item[key] = parseYamlValue(val);
			i++;
		}
		// 继续解析该列表项的其余字段(缩进大于列表项本身的字段)
		if (i < lines.length) {
			const nextIndent = lines[i].search(/\S/);
			if (nextIndent > itemIndent && lines[i].trim() !== '' && !lines[i].trim().startsWith('-')) {
				const r = parseYamlBlock(lines, i, nextIndent);
				Object.assign(item, r.obj);
				i = r.index;
			}
		}
		arr.push(item);
	}
	return { obj: arr, index: i };
}

// 从 Clash YAML 文本中提取 proxies 列表
function parseProxiesYAML(yamlText) {
	try {
		const lines = String(yamlText || '').replace(/^\uFEFF/, '').split(/\r?\n/); // 去掉BOM
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === '' || trimmed.startsWith('#')) continue;
			if (/^proxies\s*:\s*(#.*)?$/.test(trimmed)) {
				const indent = lines[i].search(/\S/);
				// 跳过 proxies: 之后的空行/注释,定位列表第一项
				let j = i + 1;
				while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
				if (j >= lines.length) return [];
				const nextIndent = lines[j].search(/\S/);
				// 兼容两种格式:列表项缩进更深,或无缩进序列(- 与 proxies: 同级)
				if (nextIndent <= indent && !lines[j].trim().startsWith('- ')) return [];
				const r = parseYamlList(lines, j, nextIndent);
				return r.obj || [];
			}
		}
	} catch (e) {
		console.log('YAML解析失败: ' + e.message);
	}
	return [];
}

// UTF-8 安全的 base64 编码
function btoaUnicode(str) {
	const bytes = new TextEncoder().encode(String(str));
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

// 构造查询参数,自动跳过空值
function addQuery(q, key, value) {
	if (value === undefined || value === null || value === '') return;
	let v = String(value);
	// 已预编码的值(如 path 中的 %2F)先解码再统一编码,避免双重编码
	try { v = decodeURIComponent(v); } catch (e) { /* 保留原值 */ }
	q.push(key + '=' + encodeURIComponent(v));
}

function clashWsHost(p) {
	const ws = p['ws-opts'];
	if (ws && ws.headers && ws.headers.Host) return String(ws.headers.Host);
	const h2 = p['h2-opts'];
	if (h2 && h2.host) return String(h2.host);
	const httpOpts = p['http-opts'];
	if (httpOpts && httpOpts.headers && httpOpts.headers.Host) return String(httpOpts.headers.Host);
	const headers = p['headers'];
	if (headers && headers.Host) return String(headers.Host);
	return '';
}

function clashWsPath(p) {
	const ws = p['ws-opts'];
	if (ws && ws.path) return String(ws.path);
	const h2 = p['h2-opts'];
	if (h2 && h2.path) return String(h2.path);
	const httpOpts = p['http-opts'];
	if (httpOpts && httpOpts.path) return String(httpOpts.path);
	return '';
}

function clashGrpcServiceName(p) {
	const grpc = p['grpc-opts'];
	if (grpc) return String(grpc['grpc-service-name'] || grpc.serviceName || '');
	return '';
}

// 将单个 Clash 节点对象转换为订阅 URI,失败返回 null
function clashProxyToURI(p, fileName = DEFAULT_FILE_NAME) {
	try {
		if (!p || typeof p !== 'object') return null;
		const name = String(p.name || '');
		const server = String(p.server || '');
		const port = p.port;
		const type = String(p.type || '').toLowerCase();
		if (!server || !port) return null;
		const network = String(p.network || 'tcp').toLowerCase();

		// Shadowsocks
		if (type === 'ss') {
			const method = String(p.cipher || 'aes-256-gcm');
			const password = String(p.password || '');
			let uri = 'ss://' + btoaUnicode(method + ':' + password) + '@' + server + ':' + port;
			if (p.plugin) {
				const opts = (p['plugin-opts'] && typeof p['plugin-opts'] === 'object') ? p['plugin-opts'] : {};
				if (p.plugin === 'obfs') {
					uri += '?plugin=' + encodeURIComponent('obfs-local;obfs=' + (opts.mode || 'http') + ';obfs-host=' + (opts.host || ''));
				} else if (p.plugin === 'v2ray-plugin') {
					const parts = ['v2ray-plugin'];
					if (opts.mode === 'websocket') {
						parts.push('mode=websocket');
						if (opts.host) parts.push('host=' + opts.host);
						if (opts.path) parts.push('path=' + opts.path);
						if (opts.tls) parts.push('tls');
					}
					uri += '?plugin=' + encodeURIComponent(parts.join(';'));
				}
			}
			if (name) uri += '#' + encodeURIComponent(name);
			return uri;
		}

		// Vmess
		if (type === 'vmess') {
			const params = {
				v: '2',
				ps: name,
				add: server,
				port: String(port),
				id: String(p.uuid || p.id || ''),
				aid: String(p.alterId || 0),
				scy: String(p.cipher || 'auto'),
				net: network,
				type: String(p['header-type'] || 'none'),
				host: clashWsHost(p),
				path: clashWsPath(p),
				tls: p.tls ? 'tls' : '',
				sni: String(p.servername || p.sni || ''),
				alpn: Array.isArray(p.alpn) ? p.alpn.join(',') : String(p.alpn || ''),
				fp: String(p['client-fingerprint'] || '')
			};
			return 'vmess://' + btoaUnicode(JSON.stringify(params));
		}

		// Vless / Trojan
		if (type === 'vless' || type === 'trojan') {
			const q = [];
			if (type === 'vless') addQuery(q, 'encryption', 'none');
			if (p.flow) addQuery(q, 'flow', p.flow);
			if (p['reality-opts'] && typeof p['reality-opts'] === 'object') {
				addQuery(q, 'security', 'reality');
				const ro = p['reality-opts'];
				if (ro['public-key']) addQuery(q, 'pbk', ro['public-key']);
				if (ro['short-id']) addQuery(q, 'sid', ro['short-id']);
				addQuery(q, 'fp', ro['client-fingerprint'] || p['client-fingerprint']);
			} else if (type === 'trojan' || p.tls || p.servername || p['client-fingerprint'] || p.sni) {
				addQuery(q, 'security', 'tls');
			}
			if (p.servername) addQuery(q, 'sni', p.servername);
			if (p['skip-cert-verify']) addQuery(q, 'allowInsecure', '1');
			if (p['client-fingerprint'] && !q.some(x => x.startsWith('fp='))) addQuery(q, 'fp', p['client-fingerprint']);
			if (Array.isArray(p.alpn) && p.alpn.length) addQuery(q, 'alpn', p.alpn.join(','));
			addQuery(q, 'type', network);
			if (network === 'ws') {
				addQuery(q, 'host', clashWsHost(p));
				addQuery(q, 'path', clashWsPath(p));
			} else if (network === 'h2' || network === 'http') {
				addQuery(q, 'host', clashWsHost(p));
				addQuery(q, 'path', clashWsPath(p));
			} else if (network === 'grpc') {
				addQuery(q, 'serviceName', clashGrpcServiceName(p));
			}
			const id = type === 'vless' ? (p.uuid || p.id || '') : (p.password || '');
			return type + '://' + id + '@' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// Hysteria2
		if (type === 'hysteria2' || type === 'hy2') {
			const q = [];
			if (p.sni || p.servername) addQuery(q, 'sni', p.sni || p.servername);
			if (p['skip-cert-verify']) addQuery(q, 'insecure', '1');
			if (p.up) addQuery(q, 'up', p.up);
			if (p.down) addQuery(q, 'down', p.down);
			if (p.obfs) {
				addQuery(q, 'obfs', p.obfs);
				if (p['obfs-password']) addQuery(q, 'obfs-password', p['obfs-password']);
			}
			return 'hysteria2://' + String(p.password || '') + '@' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// SSR
		if (type === 'ssr') {
			const ssrStr = server + ':' + port + ':' + (p.protocol || 'origin') + ':' + (p.obfs || 'plain') + ':'
				+ btoaUnicode((p.cipher || 'aes-256-cfb') + ':' + (p.password || ''))
				+ '/?obfsparam=' + btoaUnicode(String(p['obfs-param'] || ''))
				+ '&protoparam=' + btoaUnicode(String(p['protocol-param'] || ''))
				+ '&remarks=' + btoaUnicode(name)
				+ '&group=' + btoaUnicode(fileName);
			return 'ssr://' + btoaUnicode(ssrStr);
		}

		// Snell
		if (type === 'snell') {
			const q = [];
			addQuery(q, 'psk', p.psk || p.password);
			if (p.obfs) {
				addQuery(q, 'obfs', p.obfs);
				const oo = p['obfs-opts'];
				if (oo && oo.host) addQuery(q, 'obfs-host', oo.host);
			}
			if (p.version) addQuery(q, 'version', p.version);
			return 'snell://' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// WireGuard
		if (type === 'wireguard') {
			const q = [];
			if (p['public-key']) addQuery(q, 'pubkey', p['public-key']);
			if (p['private-key']) addQuery(q, 'pvtkey', p['private-key']);
			if (p['pre-shared-key']) addQuery(q, 'presharedkey', p['pre-shared-key']);
			if (Array.isArray(p.reserved) && p.reserved.length) q.push('reserved=' + p.reserved.join(',')); // reserved 保持逗号分隔,不编码
			if (p.mtu) addQuery(q, 'mtu', p.mtu);
			if (p.udp) addQuery(q, 'udp', '1');
			return 'wireguard://' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// TUIC
		if (type === 'tuic') {
			const q = [];
			if (p.sni || p.servername) addQuery(q, 'sni', p.sni || p.servername);
			if (p['congestion-controller']) addQuery(q, 'congestion_control', p['congestion-controller']);
			if (p['udp-relay-mode']) addQuery(q, 'udp_relay_mode', p['udp-relay-mode']);
			if (Array.isArray(p.alpn) && p.alpn.length) addQuery(q, 'alpn', p.alpn.join(','));
			if (p['skip-cert-verify']) addQuery(q, 'allow_insecure', '1');
			if (p['reduce-rtt']) addQuery(q, 'reduce_rtt', 'true');
			return 'tuic://' + String(p.uuid || p.id || '') + ':' + String(p.password || '') + '@' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// Hysteria (v1)
		if (type === 'hysteria') {
			const q = [];
			addQuery(q, 'protocol', 'udp');
			if (p.sni || p.servername) addQuery(q, 'peer', p.sni || p.servername);
			if (p['skip-cert-verify']) addQuery(q, 'insecure', '1');
			if (p.up) addQuery(q, 'upmbps', p.up);
			if (p.down) addQuery(q, 'downmbps', p.down);
			if (p.obfs) addQuery(q, 'obfs', p.obfs);
			addQuery(q, 'auth', p.password);
			return 'hysteria://' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// AnyTLS
		if (type === 'anytls') {
			const q = [];
			addQuery(q, 'security', 'tls');
			if (p.sni || p.servername) addQuery(q, 'sni', p.sni || p.servername);
			if (p['skip-cert-verify']) addQuery(q, 'allowInsecure', '1');
			if (p.udp) addQuery(q, 'udp', '1');
			if (p['idle-session-check-interval']) addQuery(q, 'idle-session-check-interval', p['idle-session-check-interval']);
			if (p['idle-session-timeout']) addQuery(q, 'idle-session-timeout', p['idle-session-timeout']);
			if (p['min-idle-session']) addQuery(q, 'min-idle-session', p['min-idle-session']);
			return 'anytls://' + String(p.password || '') + '@' + server + ':' + port + '?' + q.join('&') + (name ? '#' + encodeURIComponent(name) : '');
		}

		// Socks5 / Http
		if (type === 'socks5' || type === 'http' || type === 'https') {
			const user = p.username ? encodeURIComponent(String(p.username)) : '';
			const pass = p.password ? encodeURIComponent(String(p.password)) : '';
			const auth = (user || pass) ? user + ':' + pass + '@' : '';
			const prefix = type === 'socks5' ? 'socks5' : (p.tls ? 'https' : 'http');
			return prefix + '://' + auth + server + ':' + port + (name ? '#' + encodeURIComponent(name) : '');
		}

		return null;
	} catch (e) {
		console.log('节点转换失败: ' + e.message);
		return null;
	}
}

// 将 Clash YAML 内容转换为订阅 URI 列表(合成大订阅)
function clashYAMLtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	const proxies = parseProxiesYAML(content);
	const uris = [];
	for (const p of proxies) {
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// ==================== sing-box (outbounds) 订阅解析 (合成大订阅) ====================
// 解析 sing-box 配置中的 outbounds 列表并转换为订阅 URI,
// 从而可以把 sing-box 格式的订阅直接合并进大订阅,不依赖订阅转换后端。

// 清理 JSON:去掉 BOM、// 与 /* */ 注释、结尾多余逗号(字符串感知,不破坏字符串内容)
function cleanJSON(src) {
	src = String(src || '').replace(/^\uFEFF/, '');
	let out = '';
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (inString) {
			out += c;
			if (c === '\\' && next !== undefined) { out += next; i += 2; continue; }
			if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') { inString = true; out += c; i++; continue; }
		if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
		if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
		if (c === ',') {
			// 去掉结尾多余逗号,如 [1,2,] 或 {"a":1,}(跳过空白与注释后再判断)
			let j = i + 1;
			for (;;) {
				while (j < src.length && /\s/.test(src[j])) j++;
				if (src[j] === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
				if (src[j] === '/' && src[j + 1] === '*') { j += 2; while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++; j += 2; continue; }
				break;
			}
			if (src[j] === '}' || src[j] === ']') { i++; continue; }
		}
		out += c;
		i++;
	}
	return out;
}

// 解析 sing-box JSON,返回 outbounds 数组
function parseSingboxJSON(content) {
	try {
		const obj = JSON.parse(cleanJSON(content));
		const outbounds = obj && Array.isArray(obj.outbounds) ? obj.outbounds : [];
		return outbounds.filter(o => o && typeof o === 'object' && o.type);
	} catch (e) {
		console.log('Singbox JSON解析失败: ' + e.message);
		return [];
	}
}

// 将 sing-box outbound 归一化为 Clash 节点对象,复用 clashProxyToURI 转换
function singboxToClashProxy(o) {
	const type = o.type || '';
	const tls = o.tls || {};
	const utls = tls.utls || {};
	const transport = o.transport || {};
	const reality = (tls.reality && tls.reality.enabled) ? tls.reality : null;
	const p = {
		name: o.tag || o.name || '',
		server: o.server || o.server_host || '',
		port: o.server_port || o.serverPort || '',
		type: type,
	};
	if (tls.enabled || tls.server_name || reality) {
		p.tls = true;
		p.servername = tls.server_name;
		p.sni = tls.server_name;
		p['skip-cert-verify'] = !!tls.insecure;
		p['client-fingerprint'] = utls.fingerprint || tls.fingerprint;
	}
	if (reality) {
		p['reality-opts'] = {
			'public-key': reality.public_key,
			'short-id': reality.short_id,
			'client-fingerprint': utls.fingerprint || tls.fingerprint,
		};
	}
	if (transport.type) {
		p.network = transport.type;
		if (transport.type === 'ws') {
			const h = transport.headers || {};
			const host = h.Host || h.host || (Array.isArray(transport.host) ? transport.host[0] : transport.host);
			p['ws-opts'] = { path: transport.path, headers: host ? { Host: host } : undefined };
		} else if (transport.type === 'http') {
			p['h2-opts'] = { host: Array.isArray(transport.host) ? transport.host[0] : transport.host, path: transport.path };
		} else if (transport.type === 'grpc') {
			p['grpc-opts'] = { 'grpc-service-name': transport.service_name || transport.serviceName };
		}
	}
	if (tls.alpn || o.alpn) p.alpn = tls.alpn || o.alpn; // 部分配置 alpn 在顶层
	switch (type) {
		case 'vless':
			p.uuid = o.uuid;
			p.flow = o.flow;
			break;
		case 'vmess':
			p.uuid = o.uuid;
			p.alterId = o.alter_id || 0;
			p.cipher = o.security || 'auto';
			break;
		case 'trojan':
			p.password = o.password;
			break;
		case 'shadowsocks':
			p.type = 'ss';
			p.cipher = o.method;
			p.password = o.password;
			if (o.plugin) {
				p.plugin = String(o.plugin).includes('v2ray') ? 'v2ray-plugin' : (String(o.plugin).includes('obfs') ? 'obfs' : String(o.plugin));
				if (o.plugin_opts) {
					// sing-box 的 plugin_opts 形如 "obfs=tls;obfs-host=x",映射为 Clash 的 mode/host
					const opts = {};
					for (const kv of String(o.plugin_opts).split(';')) {
						const idx = kv.indexOf('=');
						if (idx > 0) {
							const k = kv.slice(0, idx).trim();
							const val = kv.slice(idx + 1).trim();
							if (k === 'obfs') opts.mode = val;
							else if (k === 'obfs-host') opts.host = val;
							else opts[k] = val;
						} else if (kv.trim()) {
							opts[kv.trim()] = true; // 裸标志位,如 tls
						}
					}
					p['plugin-opts'] = opts;
				}
			}
			break;
		case 'hysteria2':
			p.password = o.password;
			p.up = o.up_mbps;
			p.down = o.down_mbps;
			if (o.obfs) {
				p.obfs = o.obfs.type;
				if (o.obfs.password) p['obfs-password'] = o.obfs.password;
			}
			break;
		case 'hysteria':
			p.password = o.auth_str || o.auth;
			p.up = o.up_mbps;
			p.down = o.down_mbps;
			if (typeof o.obfs === 'string') p.obfs = o.obfs;
			break;
		case 'anytls':
			p.password = o.password;
			p['idle-session-check-interval'] = o.idle_session_check_interval;
			p['idle-session-timeout'] = o.idle_session_timeout;
			p['min-idle-session'] = o.min_idle_session;
			break;
		case 'tuic':
			p.uuid = o.uuid;
			p.password = o.password;
			p['congestion-controller'] = o.congestion_control;
			p['udp-relay-mode'] = o.udp_relay_mode;
			p['reduce-rtt'] = o.reduce_rtt;
			break;
		case 'wireguard':
			p['public-key'] = o.peer_public_key;
			p['private-key'] = o.private_key;
			p['pre-shared-key'] = o.pre_shared_key;
			if (Array.isArray(o.reserved)) p.reserved = o.reserved;
			p.mtu = o.mtu;
			break;
		case 'socks':
			p.type = 'socks5';
			p.username = o.username;
			p.password = o.password;
			break;
		case 'http':
			p.type = 'http';
			p.username = o.username;
			p.password = o.password;
			break;
		default:
			return null; // direct/block/dns/selector/urltest/ssh/shadowtls/omni 等不转换
	}
	return p;
}

// 将 sing-box 配置转换为订阅 URI 列表(合成大订阅)
function singboxJSONtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	const outbounds = parseSingboxJSON(content);
	const uris = [];
	for (const o of outbounds) {
		const p = singboxToClashProxy(o);
		if (!p) continue;
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// ==================== 本地多格式订阅解析(零第三方依赖) ====================
// 除 Clash YAML / sing-box JSON / base64 / 明文节点外,额外本地识别:
// Surge / Loon profile、Quantumult X 配置、v2ray / Xray JSON、SS JSON 列表,
// 以及"base64 包裹的其他格式",全部就地转换为节点 URI。
// 至此,任何订阅源响应都不再需要交给第三方 SUBAPI 转换。

// 按逗号拆分配置行(尊重双引号与 []/{}/( ) 嵌套,防止 peers=[{...}] 被拆散)
function splitCSVLine(str) {
	const tokens = [];
	let cur = '';
	let inQuote = false;
	let depth = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (inQuote) {
			if (c === '"') {
				if (str[i + 1] === '"') { cur += '"'; i++; }
				else inQuote = false;
			} else cur += c;
		} else if (c === '"') inQuote = true;
		else if (c === '[' || c === '{' || c === '(') { depth++; cur += c; }
		else if (c === ']' || c === '}' || c === ')') { depth--; cur += c; }
		else if (c === ',' && depth === 0) { tokens.push(cur); cur = ''; }
		else cur += c;
	}
	tokens.push(cur);
	return tokens;
}

// 去掉配置值首尾的双引号
function unquoteSurge(v) {
	const s = String(v ?? '').trim();
	if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
	return s;
}

// 从 "Host:xxx|X-Token:yyy" 这类 Surge ws-headers 中取指定 header 值
function surgeHeaderValue(headers, key) {
	if (!headers) return '';
	for (const part of String(headers).split('|')) {
		const idx = part.indexOf(':');
		if (idx > 0 && part.slice(0, idx).trim().toLowerCase() === key.toLowerCase()) return part.slice(idx + 1).trim();
	}
	return '';
}

// 解析 "{k = v, k2 = [1,2], ...}" 或 "(k = v, ...)" 风格的对象
function parseBracedPairs(str) {
	const inner = String(str).trim().replace(/^[\[{(]/, '').replace(/[\]})]$/, '');
	const obj = {};
	for (const part of splitCSVLine(inner)) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const k = part.slice(0, eq).trim().toLowerCase();
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('[') && v.endsWith(']')) {
			obj[k] = v.slice(1, -1).split(',').map(x => Number(x.trim())).filter(n => !Number.isNaN(n));
		} else {
			obj[k] = unquoteSurge(v);
		}
	}
	return obj;
}

// 解析 Surge/Loon [Proxy] 行:Name = type, host, port, [位置参数...], k=v, ...
function parseProfileProxyLine(line) {
	const eq = line.indexOf('=');
	if (eq === -1) return null;
	const name = unquoteSurge(line.slice(0, eq));
	if (!name || name.startsWith('[') || name.startsWith('#')) return null;
	const tokens = splitCSVLine(line.slice(eq + 1));
	if (tokens.length < 2) return null;
	const type = tokens[0].trim().toLowerCase();
	// wireguard 的主机/端口位于 [WireGuard] 段的 peer endpoint 中,代理行本身不包含
	const server = tokens.length >= 3 ? unquoteSurge(tokens[1]) : '';
	const port = tokens.length >= 3 ? Number(unquoteSurge(tokens[2])) : 0;
	if (type !== 'wireguard' && (!server || !port)) return null;
	const kv = {};
	const positional = [];
	// wireguard 无行内 host/port,其 k=v 参数从第 2 个 token 开始;普通代理从第 4 个开始
	const kvStart = type === 'wireguard' ? 1 : 3;
	for (let i = kvStart; i < tokens.length; i++) {
		const t = tokens[i].trim();
		if (!t) continue;
		const eqi = t.indexOf('=');
		if (eqi > 0) kv[t.slice(0, eqi).trim().toLowerCase()] = unquoteSurge(t.slice(eqi + 1));
		else positional.push(unquoteSurge(t));
	}
	return { name, type, server, port, kv, positional };
}

// 将 Surge/Loon [Proxy] 节点行映射为 Clash 代理对象(与 uriToClashProxy 输出同构)
function profileProxyToClash(parsed) {
	const { name, type, server, port, kv, positional } = parsed;
	const base = { name: name || (server + ':' + port), server, port };
	const net = kv['transport'] || kv['network'] || (kv['ws'] === 'true' ? 'ws' : (kv['grpc'] === 'true' ? 'grpc' : 'tcp'));
	if (net !== 'tcp') base.network = net; // ws/grpc/h2 传输层必须随 URI 保留
	const wsOpts = (path, host) => ({ path: path || '/', headers: host ? { Host: host } : undefined });
	switch (type) {
		case 'ss':
		case 'shadowsocks': {
			const p = { ...base, type: 'ss', cipher: kv['encrypt-method'] || kv['method'] || kv['cipher'] || positional[0] || 'aes-256-gcm', password: kv['password'] || positional[1] || '', udp: true };
			if (kv['obfs'] && kv['obfs'] !== 'none') { p.plugin = 'obfs'; p['plugin-opts'] = { mode: kv['obfs'], host: kv['obfs-host'] || '' }; }
			return p;
		}
		case 'ssr':
		case 'shadowsocksr': {
			const p = { ...base, type: 'ssr', cipher: kv['cipher'] || kv['encrypt-method'] || positional[0] || 'aes-256-cfb', password: kv['password'] || positional[1] || '', protocol: kv['protocol'] || 'origin', obfs: kv['obfs'] || 'plain' };
			if (kv['obfs-param']) p['obfs-param'] = kv['obfs-param'];
			if (kv['protocol-param']) p['protocol-param'] = kv['protocol-param'];
			return p;
		}
		case 'vmess': {
			const p = { ...base, type: 'vmess', uuid: kv['username'] || kv['uuid'] || kv['password'] || positional[1] || '', alterId: Number(kv['alterid'] || kv['alter-id'] || 0), cipher: kv['cipher'] || kv['encrypt-method'] || kv['method'] || positional[0] || 'auto', udp: true };
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['ws-headers'] ? surgeHeaderValue(kv['ws-headers'], 'Host') : (kv['host'] || ''));
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['tls'] === 'true' || kv['over-tls'] === 'true') {
				p.tls = true;
				if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
				if (kv['skip-cert-verify'] === 'true' || kv['skip-cert-verification'] === 'true') p['skip-cert-verify'] = true;
			}
			return p;
		}
		case 'vless': {
			const p = { ...base, type: 'vless', uuid: kv['username'] || kv['uuid'] || kv['password'] || positional[0] || '', udp: true };
			if (kv['flow']) p.flow = kv['flow'];
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['host'] || '');
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['tls'] === 'true' || kv['over-tls'] === 'true') {
				p.tls = true;
				if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
				if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			}
			return p;
		}
		case 'trojan': {
			const p = { ...base, type: 'trojan', password: kv['password'] || positional[0] || '', udp: true, tls: true };
			if (net === 'ws') p['ws-opts'] = wsOpts(kv['ws-path'] || kv['path'], kv['host'] || '');
			else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': kv['grpc-service-name'] || kv['path'] || '' };
			if (kv['sni'] || kv['tls-name'] || kv['servername']) p.servername = kv['sni'] || kv['tls-name'] || kv['servername'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			return p;
		}
		case 'hysteria2':
		case 'hy2': {
			const p = { ...base, type: 'hysteria2', password: kv['password'] || positional[0] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['upload-bandwidth'] || kv['up']) p.up = kv['upload-bandwidth'] || kv['up'];
			if (kv['download-bandwidth'] || kv['down']) p.down = kv['download-bandwidth'] || kv['down'];
			if (kv['salamander-password'] || kv['obfs-password']) { p.obfs = 'salamander'; p['obfs-password'] = kv['salamander-password'] || kv['obfs-password']; }
			else if (kv['obfs'] && kv['obfs'] !== 'none') { p.obfs = kv['obfs']; }
			return p;
		}
		case 'tuic':
		case 'tuic-v5': {
			const p = { ...base, type: 'tuic', uuid: kv['uuid'] || positional[0] || '', password: kv['password'] || kv['token'] || positional[1] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['congestion-control']) p['congestion-controller'] = kv['congestion-control'];
			if (kv['alpn']) p.alpn = String(kv['alpn']).split(',');
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (type === 'tuic-v5' || kv['tuic-v5'] === 'true') p['reduce-rtt'] = true;
			return p;
		}
		case 'anytls': {
			const p = { ...base, type: 'anytls', password: kv['password'] || positional[0] || '' };
			if (kv['sni'] || kv['tls-name']) p.sni = kv['sni'] || kv['tls-name'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['udp'] === 'true') p.udp = true;
			return p;
		}
		case 'socks5':
		case 'socks': {
			const p = { ...base, type: 'socks5' };
			if (kv['username'] || positional[0]) p.username = kv['username'] || positional[0];
			if (kv['password'] || positional[1]) p.password = kv['password'] || positional[1];
			if (kv['udp'] === 'true') p.udp = true;
			return p;
		}
		case 'http':
		case 'https': {
			const p = { ...base, type: 'http' };
			if (kv['username'] || positional[0]) p.username = kv['username'] || positional[0];
			if (kv['password'] || positional[1]) p.password = kv['password'] || positional[1];
			if (type === 'https' || kv['tls'] === 'true') p.tls = true;
			return p;
		}
		default:
			return null;
	}
}

// 将 Surge/Loon wireguard 节点(行内 peers 或 [WireGuard] 段)映射为 Clash 代理对象
function profileWGToClash(parsed, wg) {
	const { name, kv } = parsed;
	const wgkv = wg || {};
	let endpoint = '';
	let publicKey = '';
	let preSharedKey = '';
	let reserved = [];
	if (kv['peers']) {
		const raw = String(kv['peers']).trim().replace(/^\[/, '').replace(/\]$/, '');
		const peers = [];
		for (const chunk of splitCSVLine(raw)) if (chunk.trim()) peers.push(parseBracedPairs(chunk));
		const peer0 = peers[0] || {};
		endpoint = peer0['endpoint'] || '';
		publicKey = peer0['public-key'] || '';
		preSharedKey = peer0['preshared-key'] || '';
		if (Array.isArray(peer0['reserved'])) reserved = peer0['reserved'];
	} else if (wgkv['peer'] && typeof wgkv['peer'] === 'object') {
		endpoint = wgkv['peer']['endpoint'] || '';
		publicKey = wgkv['peer']['public-key'] || '';
		preSharedKey = wgkv['peer']['preshared-key'] || '';
		if (wgkv['peer']['client-id']) reserved = String(wgkv['peer']['client-id']).split('/').map(Number);
	}
	// 注:allowed-ips / keepalive 等字段仅作保留,wireguard URI 方案不携带,无需引用
	if (!endpoint || !publicKey) return null;
	const hm = endpoint.match(/^\[(.+)\]:(\d+)$/) || endpoint.match(/^([^:]+):(\d+)$/);
	if (!hm) return null;
	const p = {
		name,
		type: 'wireguard',
		server: hm[1],
		port: Number(hm[2]),
		ip: kv['interface-ip'] || kv['self-ip'] || wgkv['self-ip'] || '10.0.0.2',
		'public-key': publicKey,
		'private-key': kv['private-key'] || wgkv['private-key'] || '',
		udp: true,
	};
	if (preSharedKey) p['pre-shared-key'] = preSharedKey;
	if (reserved && reserved.length) p.reserved = reserved;
	if (kv['mtu'] || wgkv['mtu']) p.mtu = Number(kv['mtu'] || wgkv['mtu']);
	return p;
}

// 解析 Surge / Loon profile 的 [Proxy] 段 + [WireGuard] 段
function surgeLoonProfileToURIs(content, fileName = DEFAULT_FILE_NAME) {
	const lines = String(content).split('\n');
	const proxyLines = [];
	const wgSections = {};
	let inProxy = false;
	let inWG = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		if (line.startsWith('[')) {
			const close = line.indexOf(']');
			const section = (close === -1 ? line.slice(1) : line.slice(1, close)).trim().toLowerCase();
			inProxy = section === 'proxy';
			if (section.startsWith('wireguard ')) {
				inWG = section.slice('wireguard'.length).trim();
				wgSections[inWG] = {};
			} else {
				inWG = null;
			}
			continue;
		}
		if (inProxy) {
			proxyLines.push(line);
		} else if (inWG) {
			const eq = line.indexOf('=');
			if (eq === -1) continue;
			const k = line.slice(0, eq).trim().toLowerCase();
			let v = line.slice(eq + 1).trim();
			if (k === 'peer') v = parseBracedPairs(v);
			wgSections[inWG][k] = v;
		}
	}
	const uris = [];
	for (const line of proxyLines) {
		const parsed = parseProfileProxyLine(line);
		if (!parsed) continue;
		const p = parsed.type === 'wireguard' ? profileWGToClash(parsed, wgSections[parsed.kv['section-name']] || wgSections[parsed.name]) : profileProxyToClash(parsed);
		if (!p) continue;
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// 解析 Quantumult X 的 [server_local] 段:proto=host:port, method=..., password=..., tag=...
function quanxServerToURIs(content, fileName = DEFAULT_FILE_NAME) {
	const lines = String(content).split('\n');
	const uris = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const proto = line.slice(0, eq).trim().toLowerCase();
		const rest = line.slice(eq + 1).trim();
		const commaIdx = rest.indexOf(',');
		const hostPort = (commaIdx === -1 ? rest : rest.slice(0, commaIdx)).trim();
		const hm = hostPort.match(/^\[(.+)\]:(\d+)$/) || hostPort.match(/^([^:]+):(\d+)$/);
		if (!hm) continue;
		const server = hm[1];
		const port = Number(hm[2]);
		if (!port) continue;
		const kv = {};
		if (commaIdx !== -1) {
			for (const part of splitCSVLine(rest.slice(commaIdx + 1))) {
				const i2 = part.indexOf('=');
				if (i2 > 0) kv[part.slice(0, i2).trim().toLowerCase()] = unquoteSurge(part.slice(i2 + 1));
			}
		}
		const base = { name: kv['tag'] || (server + ':' + port), server, port };
		let p = null;
		if (proto === 'shadowsocks') {
			p = { ...base, type: 'ss', cipher: kv['method'] || 'aes-256-gcm', password: kv['password'] || '', udp: true };
			if (kv['obfs'] === 'http' || kv['obfs'] === 'tls') {
				p.plugin = 'obfs';
				p['plugin-opts'] = { mode: kv['obfs'], host: kv['obfs-host'] || '' };
			}
			if (kv['ssr-protocol'] && kv['ssr-protocol'] !== 'origin') {
				p = { ...base, type: 'ssr', cipher: kv['method'] || 'aes-256-cfb', password: kv['password'] || '', protocol: kv['ssr-protocol'], obfs: kv['obfs'] || 'plain' };
				if (kv['ssr-protocol-param']) p['protocol-param'] = kv['ssr-protocol-param'];
				if (kv['obfs-param']) p['obfs-param'] = kv['obfs-param'];
			}
		} else if (proto === 'vmess' || proto === 'vless') {
			const isVless = proto === 'vless';
			p = { ...base, type: isVless ? 'vless' : 'vmess', uuid: kv['password'] || '', udp: kv['udp-relay'] === 'true' };
			if (!isVless) { p.alterId = Number(kv['aid'] || 0); p.cipher = kv['method'] || 'auto'; }
			const obfs = kv['obfs'];
			if (obfs === 'wss') { p.tls = true; p.network = 'ws'; }
			else if (obfs === 'ws') { p.network = 'ws'; }
			else if (obfs === 'over-tls') { p.tls = true; }
			else if (obfs === 'http' || obfs === 'h2') { p.network = 'h2'; }
			if (p.network === 'ws') p['ws-opts'] = { path: kv['obfs-uri'] || '/', headers: kv['obfs-host'] ? { Host: kv['obfs-host'] } : undefined };
			if (p.tls) {
				if (kv['obfs-host']) p.servername = kv['obfs-host'];
				if (kv['tls-verification'] === 'false') p['skip-cert-verify'] = true;
			}
		} else if (proto === 'trojan') {
			p = { ...base, type: 'trojan', password: kv['password'] || '', udp: true, tls: true };
			if (kv['obfs'] === 'wss' || kv['obfs'] === 'ws') {
				p.network = 'ws';
				p['ws-opts'] = { path: kv['obfs-uri'] || '/', headers: kv['obfs-host'] ? { Host: kv['obfs-host'] } : undefined };
			}
			if (kv['tls-host']) p.servername = kv['tls-host'];
			if (kv['tls-verification'] === 'false') p['skip-cert-verify'] = true;
		} else if (proto === 'http' || proto === 'https') {
			p = { ...base, type: 'http' };
			if (kv['username']) p.username = kv['username'];
			if (kv['password']) p.password = kv['password'];
			if (proto === 'https' || kv['over-tls'] === 'true') p.tls = true;
		} else if (proto === 'hysteria2' || proto === 'hy2') {
			p = { ...base, type: 'hysteria2', password: kv['password'] || '' };
			if (kv['sni']) p.sni = kv['sni'];
			if (kv['skip-cert-verify'] === 'true') p['skip-cert-verify'] = true;
			if (kv['up']) p.up = kv['up'];
			if (kv['down']) p.down = kv['down'];
			if (kv['obfs'] === 'salamander') { p.obfs = 'salamander'; if (kv['obfs-password']) p['obfs-password'] = kv['obfs-password']; }
		}
		if (!p) continue;
		const uri = clashProxyToURI(p, fileName);
		if (uri) uris.push(uri);
	}
	return uris;
}

// 将 v2ray / Xray 的 streamSettings 应用到 Clash 代理对象
function applyV2rayStream(p, stream, network, security) {
	if (network !== 'tcp') p.network = network; // ws/grpc/h2 传输层必须随 URI 保留
	if (network === 'ws') {
		const ws = stream.wsSettings || {};
		p['ws-opts'] = { path: ws.path || '/', headers: (ws.headers && ws.headers.Host) ? { Host: String(ws.headers.Host) } : undefined };
	} else if (network === 'grpc') {
		const g = stream.grpcSettings || {};
		p['grpc-opts'] = { 'grpc-service-name': g.serviceName || '' };
	} else if (network === 'h2' || network === 'http') {
		const h = stream.httpSettings || {};
		const hosts = Array.isArray(h.host) ? h.host : (h.host ? [h.host] : []);
		p['h2-opts'] = { host: hosts.map(String), path: h.path || '/' };
	}
	if (security === 'tls') {
		p.tls = true;
		const tls = stream.tlsSettings || {};
		if (tls.serverName) p.servername = String(tls.serverName);
		if (tls.allowInsecure) p['skip-cert-verify'] = true;
		if (Array.isArray(tls.alpn) && tls.alpn.length) p.alpn = tls.alpn.map(String);
		if (tls.fingerprint) p['client-fingerprint'] = String(tls.fingerprint);
	} else if (security === 'reality') {
		p.tls = true;
		const r = stream.realitySettings || {};
		if (r.serverName) p.servername = String(r.serverName);
		p['reality-opts'] = { 'public-key': String(r.publicKey || ''), 'short-id': String(r.shortId || ''), 'client-fingerprint': String(r.fingerprint || '') };
	}
}

// 将 v2ray / Xray 的一个 outbound 转换为 Clash 代理对象
function v2rayOutboundToClash(o) {
	try {
		if (!o || typeof o !== 'object') return null;
		const protocol = String(o.protocol || '').toLowerCase();
		const settings = o.settings || {};
		const stream = o.streamSettings || {};
		const network = String(stream.network || 'tcp').toLowerCase();
		const security = String(stream.security || '').toLowerCase();
		const tag = String(o.tag || '');
		if (protocol === 'vmess' || protocol === 'vless') {
			const vn = Array.isArray(settings.vnext) ? settings.vnext[0] : null;
			const user = vn && Array.isArray(vn.users) ? vn.users[0] : null;
			if (!vn || !user) return null;
			const server = String(vn.address || '');
			const port = Number(vn.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: protocol, server, port, uuid: String(user.id || ''), udp: true };
			if (protocol === 'vmess') { p.alterId = Number(user.alterId || 0); p.cipher = String(user.security || 'auto'); }
			if (user.flow) p.flow = String(user.flow);
			applyV2rayStream(p, stream, network, security);
			return p;
		}
		if (protocol === 'trojan') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: 'trojan', server, port, password: String(srv.password || ''), udp: true, tls: true };
			if (srv.flow) p.flow = String(srv.flow);
			applyV2rayStream(p, stream, network, security);
			return p;
		}
		if (protocol === 'shadowsocks') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const p = { name: tag || (server + ':' + port), type: 'ss', server, port, cipher: String(srv.method || 'aes-256-gcm'), password: String(srv.password || ''), udp: true };
			if (srv.plugin) {
				const pluginName = String(srv.plugin);
				if (pluginName.includes('obfs')) {
					p.plugin = 'obfs';
					const po = typeof srv.pluginOpts === 'object' ? srv.pluginOpts : {};
					p['plugin-opts'] = { mode: String(po.mode || 'http'), host: String(po.host || '') };
				} else if (pluginName.includes('v2ray')) {
					p.plugin = 'v2ray-plugin';
					p['plugin-opts'] = typeof srv.pluginOpts === 'object' ? srv.pluginOpts : {};
				}
			}
			return p;
		}
		if (protocol === 'http' || protocol === 'socks') {
			const srv = Array.isArray(settings.servers) ? settings.servers[0] : null;
			if (!srv) return null;
			const server = String(srv.address || '');
			const port = Number(srv.port || 0);
			if (!server || !port) return null;
			const user = srv.users && Array.isArray(srv.users) ? srv.users[0] : null;
			const p = { name: tag || (server + ':' + port), type: protocol === 'socks' ? 'socks5' : 'http', server, port };
			if (user) { if (user.user) p.username = String(user.user); if (user.pass) p.password = String(user.pass); }
			if (protocol === 'http' && security === 'tls') p.tls = true;
			return p;
		}
		return null;
	} catch (e) { return null; }
}

// 解析 v2ray / Xray 风格 JSON 配置(outbounds 中每项带 protocol + settings + streamSettings)
function v2rayJSONtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	try {
		const obj = JSON.parse(cleanJSON(content));
		const outbounds = obj && Array.isArray(obj.outbounds) ? obj.outbounds : [];
		const uris = [];
		for (const o of outbounds) {
			const p = v2rayOutboundToClash(o);
			if (!p) continue;
			const uri = clashProxyToURI(p, fileName);
			if (uri) uris.push(uri);
		}
		return uris;
	} catch (e) { return []; }
}

// 解析 Shadowsocks JSON 列表(单对象 / {servers:[...]} / 数组)
function ssJSONtoURIs(content, fileName = DEFAULT_FILE_NAME) {
	try {
		const obj = JSON.parse(cleanJSON(content));
		let list = [];
		if (Array.isArray(obj)) list = obj;
		else if (Array.isArray(obj.servers)) list = obj.servers;
		else if (obj.server) list = [obj];
		const uris = [];
		for (const s of list) {
			if (!s || !s.server || !s.server_port) continue;
			const p = { name: String(s.remarks || s.name || (s.server + ':' + s.server_port)), type: 'ss', server: String(s.server), port: Number(s.server_port), cipher: String(s.method || 'aes-256-gcm'), password: String(s.password || ''), udp: true };
			if (s.plugin) {
				const pluginName = String(s.plugin);
				if (pluginName.includes('obfs')) {
					p.plugin = 'obfs';
					const po = typeof s.plugin_opts === 'object' ? s.plugin_opts : {};
					p['plugin-opts'] = { mode: String(po.mode || 'http'), host: String(po.host || '') };
				} else if (pluginName.includes('v2ray')) {
					p.plugin = 'v2ray-plugin';
					p['plugin-opts'] = typeof s.plugin_opts === 'object' ? s.plugin_opts : {};
				}
			}
			const uri = clashProxyToURI(p, fileName);
			if (uri) uris.push(uri);
		}
		return uris;
	} catch (e) { return []; }
}

// 统一入口:识别并本地解析任意格式的订阅内容
// 返回 { type: 'uris', text }(已解析为节点 URI)/ { type: 'raw', text }(明文节点,原样保留)/ null(无法识别)
function 本地解析订阅内容(content, fileName = DEFAULT_FILE_NAME, depth = 0) {
	const src = String(content || '');
	if (!src.trim()) return null;
	// 1. Clash YAML
	if (/^[ \t]*proxies[ \t]*:/m.test(src)) {
		const uris = clashYAMLtoURIs(src, fileName);
		return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
	}
	// 2. JSON:sing-box / v2ray / SS 列表
	let json = null;
	try { json = JSON.parse(cleanJSON(src)); } catch (e) { json = null; }
	if (json && typeof json === 'object') {
		if (Array.isArray(json.outbounds)) {
			const first = json.outbounds[0];
			if (first && first.type) {
				const uris = singboxJSONtoURIs(src, fileName);
				return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
			}
			if (first && first.protocol) {
				const uris = v2rayJSONtoURIs(src, fileName);
				return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
			}
		}
		if (Array.isArray(json.servers) || Array.isArray(json) || json.server) {
			const uris = ssJSONtoURIs(src, fileName);
			return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
		}
		// Clash JSON 格式:{"proxies": [{type/server/port/...}]}
		if (Array.isArray(json.proxies)) {
			const uris = [];
			for (const p of json.proxies) {
				const uri = clashProxyToURI(p, fileName);
				if (uri) uris.push(uri);
			}
			return uris.length ? { type: 'uris', text: uris.join('\n') } : null;
		}
	}
	// 3. Surge / Loon profile([Proxy] 段)
	let 是配置文件 = false;
	if (/^\s*\[Proxy\]\s*$/m.test(src)) {
		是配置文件 = true;
		if (/=\s*(ss|shadowsocks|ssr|shadowsocksr|vmess|vless|trojan|hysteria2|hy2|tuic|tuic-v5|anytls|socks5|socks|http|https|wireguard)\s*,/im.test(src)) {
			const uris = surgeLoonProfileToURIs(src, fileName);
			if (uris.length) return { type: 'uris', text: uris.join('\n') };
		}
	}
	// 4. Quantumult X([server_local] 段)
	if (/^\s*\[server_local\]\s*$/m.test(src)) {
		是配置文件 = true;
		if (/^(shadowsocks|vmess|vless|trojan|http|https|hysteria2|hy2)=/im.test(src)) {
			const uris = quanxServerToURIs(src, fileName);
			if (uris.length) return { type: 'uris', text: uris.join('\n') };
		}
	}
	// 5. 明文节点(含 :// 的链接列表);已识别为配置文件但解析为空的不再按明文混入配置文本
	if (是配置文件) return null;
	if (src.includes('://')) return { type: 'raw', text: src };
	// 6. base64(可能是任意格式的编码,递归识别)
	if (depth < 2 && isValidBase64(src)) {
		let decoded;
		try { decoded = base64Decode(src); } catch (e) { return null; }
		const nested = 本地解析订阅内容(decoded, fileName, depth + 1);
		if (nested) return nested.type === 'uris' ? nested : { type: 'raw', text: decoded };
	}
	return null;
}


// ==================== 方案A:本地 sing-box 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 sing-box outbound,
// 最后组装为完整的 sing-box JSON(outbounds + route),支持 selector/urltest 策略组。

// 将 Clash 代理对象转换为 sing-box outbound,失败返回 null
function clashToSingboxOutbound(p) {
	if (!p || !p.server || !p.port) return null;
	const o = { type: '', tag: p.name, server: p.server, server_port: Number(p.port) };
	const net = String(p.network || 'tcp').toLowerCase();
	const hasTls = !!p.tls;

	// 传输层转换(ws / grpc / http)
	const transport = (() => {
		if (net === 'ws') {
			const t = { type: 'ws' };
			if (p['ws-opts']) {
				if (p['ws-opts'].path) t.path = String(p['ws-opts'].path);
				if (p['ws-opts'].headers && p['ws-opts'].headers.Host) t.headers = { Host: String(p['ws-opts'].headers.Host) };
			}
			return t;
		}
		if (net === 'grpc') {
			const t = { type: 'grpc' };
			if (p['grpc-opts'] && p['grpc-opts']['grpc-service-name']) t.service_name = String(p['grpc-opts']['grpc-service-name']);
			return t;
		}
		if (net === 'http' || net === 'h2') {
			const t = { type: 'http' };
			if (p['h2-opts']) {
				const h = p['h2-opts'].host;
				if (Array.isArray(h) && h.length) t.host = String(h[0]);
				else if (h) t.host = String(h);
				if (p['h2-opts'].path) t.path = String(p['h2-opts'].path);
			}
			return t;
		}
		return null;
	})();

	// TLS 层(标准 TLS / Reality)
	const tls = (() => {
		if (!hasTls) return null;
		const t = { enabled: true };
		if (p.servername) t.server_name = String(p.servername);
		if (p['client-fingerprint']) t.utls = { enabled: true, fingerprint: String(p['client-fingerprint']) };
		if (p['skip-cert-verify']) t.insecure = true;
		if (p['reality-opts']) {
			t.reality = { enabled: true };
			if (p['reality-opts']['public-key']) t.reality.public_key = String(p['reality-opts']['public-key']);
			if (p['reality-opts']['short-id']) t.reality.short_id = String(p['reality-opts']['short-id']);
		}
		return t;
	})();

	switch (p.type) {
		case 'vless': {
			o.type = 'vless';
			if (p.uuid) o.uuid = String(p.uuid);
			if (p.flow) o.flow = String(p.flow);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'vmess': {
			o.type = 'vmess';
			if (p.uuid) o.uuid = String(p.uuid);
			o.alter_id = Number(p.alterId || 0);
			if (p.cipher) o.security = String(p.cipher);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'trojan': {
			o.type = 'trojan';
			if (p.password) o.password = String(p.password);
			if (tls) o.tls = tls;
			if (transport) o.transport = transport;
			return o;
		}
		case 'ss': {
			o.type = 'shadowsocks';
			if (p.cipher) o.method = String(p.cipher);
			if (p.password) o.password = String(p.password);
			if (p.plugin) {
				// sing-box 需要独立的 plugin / plugin_opts 两个字段
				const opts = p['plugin-opts'] || {};
				if (p.plugin === 'obfs') {
					o.plugin = 'obfs-local';
					const parts = [];
					if (opts.mode) parts.push('obfs=' + opts.mode);
					if (opts.host) parts.push('obfs-host=' + opts.host);
					o.plugin_opts = parts.join(';');
				} else if (p.plugin === 'v2ray-plugin') {
					o.plugin = 'v2ray-plugin';
					const parts = [];
					if (opts.mode) parts.push('mode=' + opts.mode);
					if (opts.host) parts.push('host=' + opts.host);
					if (opts.path) parts.push('path=' + opts.path);
					if (opts.tls) parts.push('tls');
					o.plugin_opts = parts.join(';');
				}
			}
			return o;
		}
		case 'ssr': {
			// sing-box 1.6.0 起已移除 ShadowsocksR(SSR) 支持,输出会导致整个配置加载失败,故跳过
			return null;
		}
		case 'hysteria2':
		case 'hy2': {
			o.type = 'hysteria2';
			if (p.password) o.password = String(p.password);
			// sing-box 要求 hysteria2 必须启用 TLS,否则报 TLS required 并导致整个配置加载失败
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p.up) o.up_mbps = Number(p.up);
			if (p.down) o.down_mbps = Number(p.down);
			if (p.obfs) o.obfs = { type: String(p.obfs), password: p['obfs-password'] ? String(p['obfs-password']) : '' };
			return o;
		}
		case 'hysteria': {
			o.type = 'hysteria';
			if (p['auth_str']) o.auth_str = String(p['auth_str']);
			// sing-box 的 hysteria v1 必填 tls 与 up/down 带宽,缺失会导致整个配置加载失败
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			o.up_mbps = p.up ? Number(p.up) : 100;
			o.down_mbps = p.down ? Number(p.down) : 100;
			if (p.obfs) o.obfs = String(p.obfs);
			return o;
		}
		case 'tuic': {
			o.type = 'tuic';
			if (p.uuid) o.uuid = String(p.uuid);
			if (p.password) o.password = String(p.password);
			// sing-box 的 tuic 必须启用 TLS
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p['congestion-controller']) o.congestion_control = String(p['congestion-controller']);
			if (p['udp-relay-mode']) o.udp_relay_mode = String(p['udp-relay-mode']);
			if (p['reduce-rtt']) o.reduce_rtt = true;
			if (Array.isArray(p.alpn) && p.alpn.length) o.alpn = p.alpn.map(String);
			return o;
		}
		case 'wireguard': {
			// sing-box 1.12 起废弃旧 wireguard 出站,1.13 彻底移除;
			// 由 clashToSingboxEndpoint 生成为 endpoints 数组(见 生成本地Singbox配置)
			return null;
		}
		case 'anytls': {
			o.type = 'anytls';
			if (p.password) o.password = String(p.password);
			// sing-box 的 anytls 必须启用 TLS
			if (!o.tls) o.tls = { enabled: true };
			if (p.sni) o.tls.server_name = String(p.sni);
			if (p['skip-cert-verify']) o.tls.insecure = true;
			if (p['idle-session-check-interval']) o.idle_session_check_interval = Number(p['idle-session-check-interval']);
			if (p['idle-session-timeout']) o.idle_session_timeout = Number(p['idle-session-timeout']);
			if (p['min-idle-session']) o.min_idle_session = Number(p['min-idle-session']);
			return o;
		}
		case 'socks':
		case 'socks5': {
			o.type = 'socks';
			if (p.username) o.username = String(p.username);
			if (p.password) o.password = String(p.password);
			return o;
		}
		case 'http':
		case 'https': {
			o.type = 'http';
			if (p.username) o.username = String(p.username);
			if (p.password) o.password = String(p.password);
			if (p.tls) o.tls = { enabled: true };
			return o;
		}
		default:
			return null;
	}
}

// 将 wireguard 节点转换为 sing-box 1.12+ endpoint 对象
// (sing-box 1.12 起废弃 wireguard 出站、1.13 移除,新格式为 endpoints 数组:
//  address + private_key + peers[].address/port/public_key/allowed_ips)
function clashToSingboxEndpoint(p) {
	if (!p || p.type !== 'wireguard') return null;
	if (!p.server || !p.port) return null;
	// 缺私钥或对端公钥的节点不可用,sing-box 会拒绝该 endpoint,直接丢弃
	if (!p['private-key'] || !p['public-key']) return null;
	const ep = {
		type: 'wireguard',
		tag: String(p.name || 'wireguard'),
		mtu: p.mtu ? Number(p.mtu) : 1280,
	};
	const ipStr = String(p.ip || '10.0.0.2');
	ep.address = [ipStr.includes('/') ? ipStr : ipStr + '/32'];
	ep.private_key = String(p['private-key']);
	const peer = {
		address: String(p.server),
		port: Number(p.port),
		public_key: p['public-key'] ? String(p['public-key']) : '',
		allowed_ips: ['0.0.0.0/0'],
	};
	if (p['pre-shared-key']) peer.pre_shared_key = String(p['pre-shared-key']);
	if (Array.isArray(p.reserved) && p.reserved.length) peer.reserved = p.reserved.map(Number);
	ep.peers = [peer];
	return ep;
}

// 协议级节点校验(供各格式生成器共用,宁缺毋滥:不合格节点整条丢弃,不拖垮整份配置)
// 除 server/port 外,还校验各协议必填凭据与关键字段值域,拦截“能解析但字段残缺/非法”的节点。
// 这些字段若残缺或非法,OpenClash(mihomo)/sing-box 等对格式要求严格的客户端会直接拒绝
// 整个配置或让该节点不可用。
const 合法网络 = new Set(['tcp', 'ws', 'grpc', 'http', 'h2']);
function 校验节点(p) {
	if (!p || typeof p !== 'object') return false;
	if (!p.server) return false;
	const server = String(p.server).trim();
	if (!server || server.length > 253) return false;
	const port = Number(p.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
	const net = String(p.network || 'tcp').toLowerCase();
	if (!合法网络.has(net)) return false;
	switch (p.type) {
		case 'vmess': return !!(p.uuid && p.cipher);
		case 'vless': return !!p.uuid;
		case 'ss': return !!(p.password && p.cipher);
		case 'ssr': return !!(p.password && p.cipher && p.protocol && p.obfs);
		case 'trojan': return !!p.password;
		case 'hysteria2':
		case 'hy2': return !!p.password;
		case 'hysteria': return true; // up/down 有默认值兜底
		case 'tuic': return !!(p.uuid && p.password);
		case 'wireguard': return !!(p['public-key'] && p['private-key'] && p.ip);
		case 'anytls': return !!p.password;
		case 'socks':
		case 'socks5':
		case 'http':
		case 'https': return true;
		default: return false; // 未知协议:丢弃
	}
}

// 本地生成完整 sing-box JSON 配置
async function 生成本地Singbox配置(节点文本, env, fileName = DEFAULT_FILE_NAME) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const outbounds = [];
	const endpoints = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		if (p.type === 'wireguard') {
			const ep = clashToSingboxEndpoint(p);
			if (ep) endpoints.push(ep);
			continue;
		}
		const o = clashToSingboxOutbound(p);
		if (o) outbounds.push(o);
	}
	if (outbounds.length === 0 && endpoints.length === 0) return JSON.stringify({ log: { level: 'info' }, outbounds: [] });

	// 节点 tag 去重(出站 + 端点)
	const seenTags = new Set();
	const allNodes = [...outbounds, ...endpoints];
	for (const o of allNodes) {
		let t = o.tag;
		let i = 2;
		while (seenTags.has(t)) { t = o.tag + ' ' + i; i++; }
		seenTags.add(t);
		o.tag = t;
	}
	const nodeTags = allNodes.map(o => o.tag);

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const groups = [
		{ type: 'selector', tag: 节点选择, outbounds: [自动选择, ...nodeTags, 直连] },
		{ type: 'urltest', tag: 自动选择, outbounds: nodeTags, url: 'http://www.gstatic.com/generate_204', interval: '300s' },
		{ type: 'direct', tag: 直连 },
		{ type: 'block', tag: 拦截 },
		{ type: 'selector', tag: 媒体, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: 电报, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: Ai, outbounds: [节点选择, 直连] },
		{ type: 'selector', tag: 漏网, outbounds: [节点选择, 直连] },
	];
	outbounds.push(...groups);

	const config = {
		log: { level: 'info', timestamp: true },
		experimental: { cache_file: { enabled: true } },
		outbounds,
		// sing-box 1.12+: wireguard 由 outbound 迁移为 endpoint(1.13 起旧格式直接报错)
		...(endpoints.length ? { endpoints } : {}),
		route: {
			rules: [
				{ ip_cidr: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], outbound: 直连 },
				// sing-box 1.12+ 移除了 geoip/geosite 内置数据库规则,必须改用 rule_set(远程 .srs 文件)。
				// rule_set 自 sing-box 1.4 起全版本可用,兼容所有客户端。
				{ rule_set: ['geoip-cn'], outbound: 直连 },
				{ rule_set: ['geosite-cn'], outbound: 直连 },
			],
			rule_set: [
				{
					tag: 'geoip-cn',
					type: 'remote',
					format: 'binary',
					url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
					download_detour: 直连,
				},
				{
					tag: 'geosite-cn',
					type: 'remote',
					format: 'binary',
					url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
					download_detour: 直连,
				},
			],
			final: 漏网,
			auto_detect_interface: true,
		},
	};
	return JSON.stringify(config, null, 2);
}

// ==================== 方案A:本地 Clash 配置生成(不依赖第三方 SUBAPI) ====================
// 将聚合后的节点 URI 列表直接在 Worker 内转换为 Clash/Mihomo YAML。
// 分流规则优先读取 KV 缓存的 ACL4SSR 规则集(24小时自动刷新),无 KV 或拉取失败时回退内置精简规则。

// ACL4SSR 在线规则集列表(按 group 映射到生成的策略组)
const ACL4SSR_RULES = [
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/UnBan.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanAD.list', group: '🛑 全球拦截' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/BanProgramAD.list', group: '🛑 全球拦截' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/GoogleCN.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/SteamCN.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Telegram.list', group: '📲 电报信息' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyMedia.list', group: '🌍 国外媒体' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/AI.list', group: '💬 Ai平台' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/OpenAi.list', group: '💬 Ai平台' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list', group: '🎯 全球直连' },
	{ url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaCompanyIp.list', group: '🎯 全球直连' },
];

// 将单条节点 URI 解析为 Clash 代理对象,失败返回 null
function uriToClashProxy(uri) {
	try {
		const s = String(uri || '').trim();
		const hashIdx = s.indexOf('#');
		let name = '';
		if (hashIdx !== -1) { try { name = decodeURIComponent(s.slice(hashIdx + 1)); } catch { name = s.slice(hashIdx + 1); } }
		let body = hashIdx !== -1 ? s.slice(0, hashIdx) : s;
		const schemeIdx = body.indexOf('://');
		if (schemeIdx === -1) return null;
		const scheme = body.slice(0, schemeIdx).toLowerCase();
		body = body.slice(schemeIdx + 3);
		// vmess / ssr 的 URI 主体是纯 base64(无 @host:port 结构),需单独解析
		if (scheme === 'vmess' || scheme === 'ssr') {
			const b64 = body.split('?')[0];
			let decoded = b64;
			try { decoded = base64Decode(b64); } catch { return null; }
			if (scheme === 'vmess') {
				let json;
				try { json = JSON.parse(decoded); } catch { return null; }
				if (!json.add || !json.port) return null;
				const p = {
					name: name || json.ps || (json.add + ':' + json.port),
					type: 'vmess',
					server: json.add,
					port: Number(json.port),
					uuid: json.id || '',
					alterId: Number(json.aid || 0),
					cipher: json.scy || 'auto',
					udp: true,
				};
				const net = String(json.net || 'tcp').toLowerCase();
				if (net !== 'tcp') p.network = net;
				if (net === 'ws') p['ws-opts'] = { path: json.path || '/', headers: json.host ? { Host: json.host } : undefined };
				else if (net === 'h2' || net === 'http') p['h2-opts'] = { host: json.host ? [json.host] : [], path: json.path || '/' };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': json.path || '' };
				if (json.tls) {
					p.tls = true;
					if (json.sni) p.servername = json.sni;
					if (json.fp) p['client-fingerprint'] = json.fp;
				}
				if (json.alpn) p.alpn = String(json.alpn).split(',');
				return p;
			}
			// ssr
			const q2 = decoded.split('/?');
			const core = q2[0].split(':');
			const ssp = new URLSearchParams(q2[1] || '');
			let mp = core.slice(4).join(':');
			try { mp = base64Decode(mp); } catch { /* 保持原样 */ }
			const mci = mp.indexOf(':');
			let remarks = '';
			try { if (ssp.get('remarks')) remarks = base64Decode(ssp.get('remarks')); } catch { /* 忽略 */ }
			const protocol = (core[2] || 'origin').toLowerCase();
			const obfs = (core[3] || 'plain').toLowerCase();
			// ssr protocol/obfs 白名单:mihomo 对未知值报 initialize protocol/obfs error 并使整个配置加载失败
			const SSR_PROTOCOLS = new Set(['origin', 'auth_sha1_v4', 'auth_aes128_md5', 'auth_aes128_sha1', 'auth_chain_a', 'auth_chain_b']);
			const SSR_OBFS = new Set(['plain', 'http_simple', 'http_post', 'random_head', 'tls1.2_ticket_auth', 'tls1.2_ticket_fastauth']);
			if (!SSR_PROTOCOLS.has(protocol) || !SSR_OBFS.has(obfs)) return null; // 非法 protocol/obfs:丢弃节点
			const p = {
				name: remarks || name || (core[0] + ':' + core[1]),
				server: core[0],
				port: Number(core[1]),
				type: 'ssr',
				cipher: mci !== -1 ? mp.slice(0, mci) : 'aes-256-cfb',
				password: mci !== -1 ? mp.slice(mci + 1) : '',
				protocol,
				obfs,
			};
			if (ssp.get('obfsparam')) { try { p['obfs-param'] = base64Decode(ssp.get('obfsparam')); } catch { /* 忽略 */ } }
			if (ssp.get('protoparam')) { try { p['protocol-param'] = base64Decode(ssp.get('protoparam')); } catch { /* 忽略 */ } }
			return p;
		}
		let userInfo = '';
		let hostPort = body;
		const atIdx = body.lastIndexOf('@');
		if (atIdx !== -1) { userInfo = body.slice(0, atIdx); hostPort = body.slice(atIdx + 1); }
		const qIdx = hostPort.indexOf('?');
		let query = '';
		if (qIdx !== -1) { query = hostPort.slice(qIdx + 1); hostPort = hostPort.slice(0, qIdx); }
		const params = new URLSearchParams(query);
		let server = hostPort, port = '';
		const hm = hostPort.match(/^\[(.+)\]:(\d+)$/) || hostPort.match(/^([^:]+):(\d+)$/);
		if (hm) { server = hm[1]; port = hm[2]; }
		if (!server || !port) return null;
		const base = { name: name || (server + ':' + port), server, port: Number(port) };
		switch (scheme) {
			case 'vless': {
				const p = { ...base, type: 'vless', uuid: userInfo, udp: true };
				const net = params.get('type') || 'tcp';
				if (net !== 'tcp') p.network = net;
				const security = params.get('security') || 'none';
				if (security === 'reality') {
					p.tls = true;
					p.servername = params.get('sni') || server;
					if (params.get('fp')) p['client-fingerprint'] = params.get('fp');
					// REALITY 公钥必须为 URL-safe base64(无padding),解码后恰好 32 字节(X25519)
					// mihomo/sing-box 均用 RawURLEncoding 校验:标准 base64 的 + / 或带 = 的 padding 都会导致
					// "invalid REALITY public key" 进而使整个配置文件加载失败(OpenClash 无法启动)。
					const rawPbk = String(params.get('pbk') || '').trim();
					const urlSafePbk = rawPbk.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
					let pbkOk = false;
					try {
						const bytes = Uint8Array.from(atob(urlSafePbk.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
						pbkOk = bytes.length === 32;
					} catch { pbkOk = false; }
					if (!pbkOk) return null; // pbk 缺失/非法:丢弃该节点,避免单个坏节点拖垮整个配置
					// short-id 必须为偶数长度 hex 且解码后 ≤8 字节,否则 mihomo 报 invalid REALITY short ID
					const rawSid = String(params.get('sid') || '').trim();
					const sidOk = /^[0-9a-fA-F]{0,16}$/.test(rawSid) && rawSid.length % 2 === 0;
					p['reality-opts'] = { 'public-key': urlSafePbk };
					if (rawSid && sidOk) p['reality-opts']['short-id'] = rawSid.toLowerCase();
				} else if (security === 'tls') {
					p.tls = true;
					if (params.get('sni')) p.servername = params.get('sni');
					if (params.get('fp')) p['client-fingerprint'] = params.get('fp');
				}
				if (params.get('flow')) p.flow = params.get('flow');
				// flow 白名单防御:仅保留 mihomo/sing-box 已知合法值;垃圾 flow 直接丢弃该字段
				// (实测 mihomo v1.19.29 对任意 flow 均接受,但旧版本/未来版本可能严格校验,保守起见过滤)
				if (p.flow && !['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(p.flow)) delete p.flow;
				if (net === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') || params.get('service_name') || '' };
				else if (net === 'h2' || net === 'http') p['h2-opts'] = { host: params.get('host') ? [params.get('host')] : [], path: params.get('path') || '/' };
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				return p;
			}
			case 'trojan': {
				const p = { ...base, type: 'trojan', password: userInfo, udp: true };
				const security = params.get('security') || 'tls';
				if (security !== 'none') p.tls = true;
				if (params.get('sni')) p.servername = params.get('sni');
				if (params.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
				const net = params.get('type') || 'tcp';
				if (net !== 'tcp') p.network = net;
				if (net === 'ws') p['ws-opts'] = { path: params.get('path') || '/', headers: params.get('host') ? { Host: params.get('host') } : undefined };
				else if (net === 'grpc') p['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') || '' };
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				return p;
			}
			case 'ss': {
				let decoded = userInfo;
				try { decoded = base64Decode(userInfo); } catch { /* 保持原样 */ }
				const ci = decoded.indexOf(':');
				const cipher = ci !== -1 ? decoded.slice(0, ci) : 'aes-256-gcm';
				const password = ci !== -1 ? decoded.slice(ci + 1) : decoded;
				if (!password) return null; // ss 空密码:mihomo 报 cipher initialize error,整个配置加载失败
				// cipher 白名单:mihomo 对不认识的 cipher 报 initialize error 并使整个配置加载失败
				// (实测 salsa20/camellia-*/rc4/大写变体均被拒,2022-blake3 需 base64 密码解码为 16/32 字节 key)
				const normCipher = String(cipher).toLowerCase().trim();
				const SS_CIPHERS = new Set([
					'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
					'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
					'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
					'rc4-md5', 'chacha20-ietf', 'chacha20', 'none',
					'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
					'2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
				]);
				if (!SS_CIPHERS.has(normCipher)) return null;
				if (normCipher.startsWith('2022-blake3')) {
					// 2022-blake3 密码必须是 base64 编码的 key:128→16字节,256/chacha20→32字节
					let keyBytes = null;
					try { keyBytes = Uint8Array.from(atob(String(password)), c => c.charCodeAt(0)); } catch { /* 非法 base64 */ }
					const need = normCipher.includes('128') ? 16 : 32;
					if (!keyBytes || keyBytes.length !== need) return null; // key 长度错误:mihomo 报 bad key length,丢弃节点
				}
				const p = { ...base, type: 'ss', cipher: normCipher, password, udp: true };
				const plugin = params.get('plugin');
				if (plugin) {
					const parts = String(plugin).split(';');
					if (parts[0].includes('obfs')) {
						p.plugin = 'obfs';
						const opts = {};
						for (const kv of parts.slice(1)) {
							const eq = kv.indexOf('=');
							if (eq > 0) { const k = kv.slice(0, eq); const v = kv.slice(eq + 1); if (k === 'obfs') opts.mode = v; else if (k === 'obfs-host') opts.host = v; }
						}
						p['plugin-opts'] = opts;
					} else if (parts[0].includes('v2ray')) {
						p.plugin = 'v2ray-plugin';
						const opts = {};
						for (const kv of parts.slice(1)) {
							const eq = kv.indexOf('=');
							if (eq > 0) opts[kv.slice(0, eq)] = kv.slice(eq + 1);
							else opts[kv.trim()] = true;
						}
						p['plugin-opts'] = opts;
					}
				}
				return p;
			}
			case 'hysteria2':
			case 'hy2': {
				const p = { ...base, type: 'hysteria2', password: userInfo };
				if (params.get('sni')) p.sni = params.get('sni');
				if (params.get('insecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('up')) p.up = params.get('up');
				if (params.get('down')) p.down = params.get('down');
				if (params.get('obfs')) p.obfs = params.get('obfs');
				if (params.get('obfs-password')) p['obfs-password'] = params.get('obfs-password');
				return p;
			}
			case 'hysteria': {
				const p = { ...base, type: 'hysteria' };
				if (params.get('auth')) p['auth_str'] = params.get('auth');
				if (params.get('peer')) p.sni = params.get('peer');
				if (params.get('insecure') === '1') p['skip-cert-verify'] = true;
				// mihomo 的 hysteria v1 必填 up/down,缺失会报 has unset fields 并使整个配置失败,给默认值
				p.up = params.get('upmbps') || '100';
				p.down = params.get('downmbps') || '100';
				return p;
			}
			case 'tuic': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'tuic', uuid: ui[0] || '', password: ui[1] || '' };
				if (params.get('sni')) p.sni = params.get('sni');
				if (params.get('congestion_control')) p['congestion-controller'] = params.get('congestion_control');
				if (params.get('udp_relay_mode')) p['udp-relay-mode'] = params.get('udp_relay_mode');
				if (params.get('alpn')) p.alpn = String(params.get('alpn')).split(',');
				if (params.get('allow_insecure') === '1' || params.get('insecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('reduce_rtt') === '1' || params.get('reduce_rtt') === 'true') p['reduce-rtt'] = true;
				return p;
			}
			case 'wireguard': {
				// wireguard key 必须为标准 base64(可带 + / 与 = padding);URL-safe 无 padding 会被
				// mihomo 以 decode private key: illegal base64 data 拒绝并导致整个配置加载失败。
				const normWgKey = (v) => {
					if (!v) return '';
					const s = String(v).trim().replace(/-/g, '+').replace(/_/g, '/');
					const padded = s + '='.repeat((4 - s.length % 4) % 4);
					try { atob(padded); return padded; } catch { return ''; }
				};
				const priv = normWgKey(params.get('pvtkey'));
				if (!priv) return null; // 缺失/非法 private-key:丢弃节点
				// mihomo 会为 ip 追加 /32 后解析:非法的 ip 报 ip address parse error 并使整个配置失败
				const rawIp = String(params.get('ip') || '10.0.0.2').trim();
				const isIpCidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(rawIp) || /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(rawIp);
				if (!isIpCidr) return null; // 非法 ip:丢弃节点
				const p = { ...base, type: 'wireguard', ip: rawIp };
				p['private-key'] = priv;
				const pub = normWgKey(params.get('pubkey'));
				if (pub) p['public-key'] = pub;
				const psk = normWgKey(params.get('presharedkey'));
				if (psk) p['pre-shared-key'] = psk;
				if (params.get('reserved')) p.reserved = String(params.get('reserved')).split(',').map(Number);
				// mtu 必须为正整数,非法值 mihomo 报 cannot parse 'mtu' as int 并使整个配置失败
				const mtu = Number(params.get('mtu'));
				if (params.get('mtu') && Number.isInteger(mtu) && mtu > 0) p.mtu = mtu;
				if (params.get('udp') === '1') p.udp = true;
				return p;
			}
			case 'anytls': {
				if (!userInfo) return null; // anytls 缺密码:mihomo 报 has unset fields: password,整个配置失败
				const p = { ...base, type: 'anytls', password: userInfo };
				if (params.get('sni') || params.get('servername')) p.sni = params.get('sni') || params.get('servername');
				if (params.get('allowInsecure') === '1') p['skip-cert-verify'] = true;
				if (params.get('udp') === '1') p.udp = true;
				if (params.get('idle-session-check-interval')) p['idle-session-check-interval'] = Number(params.get('idle-session-check-interval'));
				if (params.get('idle-session-timeout')) p['idle-session-timeout'] = Number(params.get('idle-session-timeout'));
				if (params.get('min-idle-session')) p['min-idle-session'] = Number(params.get('min-idle-session'));
				return p;
			}
			case 'socks':
			case 'socks5': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'socks5' };
				if (ui[0]) p.username = decodeURIComponent(ui[0]);
				if (ui[1]) p.password = decodeURIComponent(ui[1]);
				if (params.get('udp') === '1') p.udp = true;
				return p;
			}
			case 'http':
			case 'https': {
				const ui = userInfo.split(':');
				const p = { ...base, type: 'http' };
				if (ui[0]) p.username = decodeURIComponent(ui[0]);
				if (ui[1]) p.password = decodeURIComponent(ui[1]);
				if (scheme === 'https' || params.get('tls') === '1') p.tls = true;
				return p;
			}
			default:
				return null;
		}
	} catch (e) {
		return null;
	}
}

// ===== YAML 渲染工具 =====
// 注意:YAML 1.1 会把裸词 off/on/yes/no/y/n 等解析为布尔值(例如 `sni: off` → false),
// 而 Clash/Mihomo 内核要求 sni/servername/host 等字段必须是字符串,
// 因此所有字符串值一律用双引号包裹,保证生成 `sni: "off"` 这类安全 YAML。
function yamlValue(v) {
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	// 转义反斜杠、双引号与控制字符(如节点名里的换行/制表符/行分隔符),
	// 防止生成非法 YAML 导致 OpenClash/Mihomo 无法解析整个配置。
	return '"' + String(v)
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
		+ '"';
}

function yamlInline(obj) {
	const parts = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null || v === '') continue;
		parts.push(k + ': ' + yamlValue(v));
	}
	return '{ ' + parts.join(', ') + ' }';
}

function yamlEmit(obj, indent) {
	const pad = ' '.repeat(indent);
	const out = [];
	for (const [k, v] of Object.entries(obj)) {
		// 注意:不能跳过空字符串!vmess/vless/trojan/ssr 的空 uuid/password 必须以 "" 输出,
		// 否则字段缺失会触发 mihomo 的 "has unset fields" 校验错误,导致整个配置文件加载失败。
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			if (v.length === 0) continue;
			out.push(pad + k + ':');
			for (const item of v) {
				if (item && typeof item === 'object') out.push(pad + '  - ' + yamlInline(item));
				else out.push(pad + '  - ' + yamlValue(item));
			}
		} else if (v && typeof v === 'object') {
			out.push(pad + k + ':');
			out.push(yamlEmit(v, indent + 2));
		} else {
			out.push(pad + k + ': ' + yamlValue(v));
		}
	}
	return out.join('\n');
}

// Clash 中允许布尔值的字段;其余字段若出现布尔值(如 sni: false)一律视为"未设置"丢弃,
// 避免生成 `sni: false` 这类 YAML 解析后为布尔、被 Clash 内核以"sni 必须是字符串"拒绝的配置。
const CLASH_BOOL_KEYS = new Set(['tls', 'udp', 'skip-cert-verify', 'reduce-rtt', 'allowInsecure', 'insecure']);

// 规整代理对象:递归丢弃出现在字符串字段里的布尔值,并剥离 null/undefined。
function 规整Clash代理(p) {
	if (!p || typeof p !== 'object') return p;
	const out = {};
	for (const [k, v] of Object.entries(p)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			out[k] = v.map(x => (x && typeof x === 'object') ? 规整Clash代理(x) : x);
		} else if (v && typeof v === 'object') {
			const nested = 规整Clash代理(v);
			// 嵌套对象清空(如 headers: {Host: false})后直接丢弃,避免输出悬空的空映射
			if (Object.keys(nested).length === 0) continue;
			out[k] = nested;
		} else if (typeof v === 'boolean' && !CLASH_BOOL_KEYS.has(k)) {
			continue; // 布尔值出现在非布尔字段(如 sni/servername)→ 视为未设置
		} else {
			out[k] = v;
		}
	}
	return out;
}

// 渲染单个代理
function 渲染Clash代理(p) {
	return '- ' + yamlEmit(规整Clash代理(p), 2).slice(2);
}

// 渲染策略组
function 渲染Clash策略组(g) {
	const lines = [];
	lines.push('- name: ' + yamlValue(g.name));
	lines.push('  type: ' + g.type);
	if (g.url) {
		lines.push('  url: ' + yamlValue(g.url));
		if (g.interval) lines.push('  interval: ' + g.interval);
		if (g.tolerance) lines.push('  tolerance: ' + g.tolerance);
	}
	lines.push('  proxies:');
	for (const p of g.proxies) lines.push('    - ' + yamlValue(p));
	return lines.join('\n');
}

// ===== 规则获取(KV 缓存 + ACL4SSR 在线规则集) =====
const 内置Clash规则 = [
	'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
	'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
	'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
	'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
];

// Mihomo 内置保留代理名 + 本生成器使用的策略组名。
// 规则引用了不存在的组会报 proxy [xxx] not found 并使整个配置加载失败,生成规则时必须校验。
const MIHOMO_RULE_GROUPS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼']);

// Mihomo/Meta 核心支持的规则类型白名单;其余类型(如 URL-REGEX)直接丢弃,
// 避免 OpenClash/Mihomo 因不支持的规则类型而报错或无法启动。
const MIHOMO_RULE_TYPES = new Set([
	'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
	'GEOIP', 'SRC-GEOIP', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6',
	'DST-PORT', 'SRC-PORT', 'PROCESS-NAME', 'PROCESS-PATH',
	'IP-ASN', 'SRC-IP-ASN', 'GEOSITE', 'RULE-SET', 'NETWORK', 'USER-AGENT',
	'MATCH', 'AND', 'OR', 'NOT',
]);

// 规范化规则行:
//  1. 丢弃不支持的规则类型(如 URL-REGEX);
//  2. 修正 no-resolve 位置:Mihomo 要求 no-resolve 位于行末、策略名之后。
//     同时可兼容修复旧版本写入的错误缓存(IP-CIDR,x,x.x.x.x/x,no-resolve,组 之类)。
function 规范化Clash规则(raw) {
	const parts = String(raw || '').trim().split(',').map(s => s.trim()).filter(Boolean);
	if (parts.length < 2 || !parts[0]) return '';
	const type = parts[0].toUpperCase();
	if (!MIHOMO_RULE_TYPES.has(type)) return '';
	const hasNoResolve = parts.some(p => p.toLowerCase() === 'no-resolve');
	const rest = parts.slice(1).filter(p => p.toLowerCase() !== 'no-resolve');
	if (rest.length === 0) return '';
	// 规则最后一段是策略组名,必须存在于已知组集合,否则 mihomo 报 proxy [xxx] not found
	// 并使整个配置加载失败。MATCH 规则只有策略名一个参数,同样校验。
	const groupName = rest[rest.length - 1];
	if (!MIHOMO_RULE_GROUPS.has(groupName)) return '';
	return type + ',' + rest.join(',') + (hasNoResolve ? ',no-resolve' : '');
}

// 为规则行附加策略组:若行尾已有 no-resolve(如 ACL4SSR 的 IP-CIDR 行),
// 策略名必须插在 no-resolve 之前,否则 Mihomo 会把 no-resolve 当成代理名报
// "proxy [no-resolve] not found" 错误。
function 附加策略组(line, group) {
	const t = String(line).trim();
	return /,\s*no-resolve$/i.test(t)
		? t.replace(/,\s*no-resolve$/i, '') + ',' + group + ',no-resolve'
		: t + ',' + group;
}

async function 获取Clash规则(env) {
	const 基础规则 = [...内置Clash规则];
	if (!env.KV) {
		// 无 KV:回退内置精简规则(零外部依赖)
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	}
	try {
		const now = Date.now();
		const cached = await env.KV.get('CLASH_RULES.txt');
		const cachedAt = Number(await env.KV.get('CLASH_RULES_AT') || 0);
		if (cached && now - cachedAt < 24 * 3600 * 1000) {
			// 读缓存时同样规范化,兼容修复旧版本写入的错误 no-resolve 位置
			const lines = cached.split('\n').map(规范化Clash规则).filter(Boolean);
			if (lines.length > 0) {
				基础规则.push(...lines);
				基础规则.push('MATCH,🐟 漏网之鱼');
				return 基础规则;
			}
		}
		// 最近1小时内已尝试拉取失败:跳过网络请求,避免每次请求都阻塞
		const lastTry = Number(await env.KV.get('CLASH_RULES_TRY') || 0);
		if (now - lastTry < 3600 * 1000) {
			基础规则.push('GEOIP,CN,DIRECT');
			基础规则.push('MATCH,🐟 漏网之鱼');
			return 基础规则;
		}
		await env.KV.put('CLASH_RULES_TRY', String(now));
		// 缓存缺失或过期:并行拉取 ACL4SSR 规则集
		const results = await Promise.allSettled(ACL4SSR_RULES.map(r => fetch(r.url, { signal: AbortSignal.timeout(12000) }).then(res => res.ok ? res.text() : Promise.reject(new Error('HTTP ' + res.status))).catch(() => '')));
		const rules = [];
		const seen = new Set();
		for (let i = 0; i < ACL4SSR_RULES.length; i++) {
			const text = results[i].status === 'fulfilled' ? results[i].value : '';
			if (!text) continue;
			const group = ACL4SSR_RULES[i].group;
			for (const raw of text.split('\n')) {
				const line = raw.trim();
				if (!line || line.startsWith('#') || line.startsWith('!')) continue;
				// 先附加策略组,再规范化:修正 no-resolve 位置、丢弃不支持的类型
				const r = 规范化Clash规则(附加策略组(line, group));
				if (r && !seen.has(r)) { seen.add(r); rules.push(r); }
				if (rules.length >= 3000) break;
			}
			if (rules.length >= 3000) break;
		}
		if (rules.length === 0) {
			基础规则.push('GEOIP,CN,DIRECT');
			基础规则.push('MATCH,🐟 漏网之鱼');
			return 基础规则;
		}
		// 内容和时间戳使用相同 TTL,避免失效规则长期残留在 KV。
		await env.KV.put('CLASH_RULES.txt', rules.join('\n'), { expirationTtl: 24 * 3600 });
		await env.KV.put('CLASH_RULES_AT', String(now), { expirationTtl: 24 * 3600 });
		基础规则.push(...rules);
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	} catch (e) {
		基础规则.push('GEOIP,CN,DIRECT');
		基础规则.push('MATCH,🐟 漏网之鱼');
		return 基础规则;
	}
}

// ===== 本地生成完整 Clash YAML =====
async function 生成本地Clash配置(节点文本, env, fileName = DEFAULT_FILE_NAME) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxies = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (p && 校验节点(p)) proxies.push(p); // 协议级校验:不合格节点宁缺毋滥
	}
	if (proxies.length === 0) return '# 无可用节点\n';

	// 节点名去重(Clash 要求唯一)。除节点间重名外,还必须规避:
	//  1) mihomo 内置保留名 DIRECT/REJECT/PASS/COMPATIBLE/REJECT-DROP(实测同名直接导致整个配置加载失败);
	//  2) 下方生成的策略组名(节点与组同名同样报 duplicate name)。
	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', 直连, 拦截, 媒体, 电报, Ai, 节点选择, 自动选择, 漏网]);
	for (const p of proxies) {
		let n = p.name;
		let i = 2;
		while (seenNames.has(n)) { n = p.name + ' ' + i; i++; }
		seenNames.add(n);
		p.name = n;
	}
	const nodeNames = proxies.map(p => p.name);

	const groups = [
		{ name: 节点选择, type: 'select', proxies: [自动选择, ...nodeNames, 直连] },
		{ name: 自动选择, type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: nodeNames },
		{ name: 直连, type: 'select', proxies: ['DIRECT'] },
		{ name: 拦截, type: 'select', proxies: ['REJECT', 'DIRECT'] },
		{ name: 媒体, type: 'select', proxies: [节点选择, 直连] },
		{ name: 电报, type: 'select', proxies: [节点选择, 直连] },
		{ name: Ai, type: 'select', proxies: [节点选择, 直连] },
		{ name: 漏网, type: 'select', proxies: [节点选择, 直连] },
	];

	const rules = await 获取Clash规则(env);

	const out = [];
	out.push('mixed-port: 7890');
	out.push('allow-lan: false');
	out.push('mode: rule');
	out.push('log-level: info');
	out.push('');
	out.push('proxies:');
	for (const p of proxies) {
		try { out.push(渲染Clash代理(p)); } catch (e) { /* 单节点渲染失败只跳过该节点,不拖垮整份配置 */ }
	}
	out.push('');
	out.push('proxy-groups:');
	for (const g of groups) out.push(渲染Clash策略组(g));
	out.push('');
	out.push('rules:');
	for (const r of rules) out.push('  - ' + r);
	return out.join('\n');
}

// ==================== 方案A:本地 Surge 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 Surge [Proxy] 行,
// 最后组装为完整的 Surge profile([General] + [Proxy] + [Proxy Group] + [Rule])。
// 注意:Surge 不支持 vless / ssr / hysteria(v1),这些协议的节点会被自动跳过。

// Surge 配置值:含逗号、引号或首尾空格的值需要加双引号
function surgeQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// 将 Clash 代理对象转换为 Surge [Proxy] 行;不支持的协议返回 null
// wireguard 需要额外的 [WireGuard xxx] 段,通过返回对象的 wgSection 字段带回
function clashToSurgeProxy(p, wgIndex) {
	if (!p || !p.server || !p.port) return null;
	const name = String(p.name || (p.server + ':' + p.port));
	// [Proxy] 行首的节点名若含逗号/引号需要加引号,否则整行解析失败
	const displayName = surgeQuote(name);
	const server = String(p.server);
	const port = String(p.port);
	const net = String(p.network || 'tcp').toLowerCase();

	// 传输层参数(ws)
	const wsArgs = [];
	if (net === 'ws') {
		wsArgs.push('ws=true');
		const ws = p['ws-opts'] || {};
		if (ws.path) wsArgs.push('ws-path=' + ws.path);
		if (ws.headers && ws.headers.Host) wsArgs.push('ws-headers=Host:' + ws.headers.Host);
	}

	// TLS 参数
	const tlsArgs = [];
	if (p.servername || p.sni) tlsArgs.push('sni=' + surgeQuote(p.servername || p.sni));
	if (p['skip-cert-verify']) tlsArgs.push('skip-cert-verify=true');
	if (Array.isArray(p.alpn) && p.alpn.length) tlsArgs.push('alpn=' + p.alpn.join(','));

	switch (p.type) {
		case 'ss': {
			const args = ['ss', server, port, 'encrypt-method=' + (p.cipher || 'aes-256-gcm'), 'password=' + surgeQuote(p.password || '')];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + surgeQuote(opts.host));
			}
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'vmess': {
			const args = ['vmess', server, port, 'username=' + (p.uuid || '')];
			args.push(...wsArgs);
			if (p.cipher && p.cipher !== 'auto') args.push('encrypt-method=' + p.cipher);
			if (p.tls) args.push('tls=true');
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'trojan': {
			const args = ['trojan', server, port, 'password=' + surgeQuote(p.password || '')];
			args.push(...wsArgs);
			// trojan 始终走 TLS,直接附加 TLS 参数
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'hysteria2': {
			const args = ['hysteria2', server, port, 'password=' + surgeQuote(p.password || '')];
			if (p.up) args.push('upload-bandwidth=' + p.up);
			if (p.down) args.push('download-bandwidth=' + p.down);
			if (p.obfs) args.push('salamander-password=' + surgeQuote(p['obfs-password'] || ''));
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'tuic': {
			// 同时有 uuid 和 password -> tuic-v5;只有 token -> tuic (v4)
			if (p.uuid && p.password) {
				const args = ['tuic-v5', server, port, 'uuid=' + p.uuid, 'password=' + surgeQuote(p.password)];
				if (p['udp-relay-mode']) args.push('udp-relay-mode=' + p['udp-relay-mode']);
				if (p['congestion-controller']) args.push('congestion-controller=' + p['congestion-controller']);
				if (!Array.isArray(p.alpn) || p.alpn.length === 0) args.push('alpn=h3');
				args.push(...tlsArgs);
				return { name, line: displayName + ' = ' + args.join(', ') };
			}
			const args = ['tuic', server, port, 'token=' + surgeQuote(p.password || p.uuid || '')];
			if (p['udp-relay-mode']) args.push('udp-relay-mode=' + p['udp-relay-mode']);
			if (p['congestion-controller']) args.push('congestion-controller=' + p['congestion-controller']);
			if (!Array.isArray(p.alpn) || p.alpn.length === 0) args.push('alpn=h3');
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'anytls': {
			const args = ['anytls', server, port, 'password=' + surgeQuote(p.password || '')];
			args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'socks5': {
			const args = ['socks5', server, port];
			if (p.username) args.push('username=' + surgeQuote(p.username));
			if (p.password) args.push('password=' + surgeQuote(p.password));
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'http': {
			// Surge 的 https 类型即 HTTP-over-TLS 代理
			const args = [p.tls ? 'https' : 'http', server, port];
			if (p.username) args.push('username=' + surgeQuote(p.username));
			if (p.password) args.push('password=' + surgeQuote(p.password));
			if (p.tls) args.push(...tlsArgs);
			return { name, line: displayName + ' = ' + args.join(', ') };
		}
		case 'wireguard': {
			// Surge WireGuard 需要 section-name + [WireGuard xxx] 独立段落
			const section = 'wg-' + (wgIndex || 0);
			const peerArgs = [];
			if (p['public-key']) peerArgs.push('public-key = ' + p['public-key']);
			peerArgs.push('allowed-ips = 0.0.0.0/0');
			peerArgs.push('endpoint = ' + server + ':' + port);
			if (Array.isArray(p.reserved) && p.reserved.length === 3) peerArgs.push('client-id = ' + p.reserved.join('/'));
			const wgSection = [
				'[WireGuard ' + section + ']',
				'private-key = ' + (p['private-key'] || ''),
				'self-ip = ' + (p.ip || '10.0.0.2'),
				'dns-server = 1.1.1.1',
				'peer = (' + peerArgs.join(', ') + ')',
			].join('\n');
			return { name, line: name + ' = wireguard, section-name=' + section, wgSection };
		}
		default:
			// vless / ssr / hysteria / snell 等 Surge 不支持的协议跳过
			return null;
	}
}

// 本地生成完整 Surge 配置文本
async function 生成本地Surge配置(节点文本, env, fileName = DEFAULT_FILE_NAME, 订阅地址 = '') {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxyLines = [];
	const wgSections = [];
	const names = [];
	let wgIndex = 0;
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		const r = clashToSurgeProxy(p, wgIndex);
		if (!r) continue;
		if (r.wgSection) { wgSections.push(r.wgSection); wgIndex++; }
		proxyLines.push(r.line);
		names.push(r.name);
	}
	if (proxyLines.length === 0) return '# 无可用节点\n';

	// 节点名去重(Surge 要求唯一),同步更新对应的 [Proxy] 行;同时规避 DIRECT/REJECT 等内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		if (n !== names[i]) {
			names[i] = n;
			// 从引号包裹后的原名字之后定位 ' = '(防止名字本身含该子串)
			const eq = proxyLines[i].indexOf(' = ', surgeQuote(names[i]).length);
			proxyLines[i] = surgeQuote(n) + proxyLines[i].slice(eq);
		}
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';
	const q = v => surgeQuote(v);

	const groups = [
		节点选择 + ' = select, ' + [自动选择, ...names, 直连].map(q).join(', '),
		自动选择 + ' = url-test, ' + names.map(q).join(', ') + ', url=http://www.gstatic.com/generate_204, interval=300, tolerance=100',
		直连 + ' = select, DIRECT',
		拦截 + ' = select, REJECT',
		媒体 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		电报 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		Ai + ' = select, ' + [节点选择, 直连].map(q).join(', '),
		漏网 + ' = select, ' + [节点选择, 直连].map(q).join(', '),
	];

	// 规则复用 Clash 的 KV 缓存规则集,只需把结尾的 MATCH 换成 Surge 的 FINAL
	const rules = (await 获取Clash规则(env)).map(r => r.startsWith('MATCH,') ? 'FINAL,' + r.slice(6) : r);

	const out = [];
	if (订阅地址) out.push('#!MANAGED-CONFIG ' + 订阅地址 + ' interval=86400');
	out.push('[General]');
	out.push('loglevel = notify');
	out.push('dns-server = 223.5.5.5, 8.8.8.8');
	out.push('');
	out.push('[Proxy]');
	for (const l of proxyLines) out.push(l);
	if (wgSections.length) {
		out.push('');
		out.push(...wgSections);
	}
	out.push('');
	out.push('[Proxy Group]');
	for (const g of groups) out.push(g);
	out.push('');
	out.push('[Rule]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}


// ==================== 方案A:本地 Quantumult X / Loon 配置生成(不依赖第三方 SUBAPI) ====================
// 复用 uriToClashProxy 将节点 URI 解析为 Clash 代理对象,再转换为 QX/Loon 节点行,
// 最后组装为完整配置([server_local]/[policy]/[filter_local] 或 [Proxy]/[Proxy Group]/[Rule])。
// 注意:Quantumult X 不支持 tuic/wireguard/socks5/anytls;Loon 不支持 socks5/tuic/anytls。
//       这些协议的节点会被自动跳过(与 Surge 跳过 vless/ssr/hysteria 同理)。

// ===== Quantumult X =====
// QX 配置值:含逗号/引号的值加引号
function qxQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// 将 Clash 代理对象转换为 QX [server_local] 行;不支持的协议返回 null
function clashToQuanxServer(p) {
	if (!p || !p.server || !p.port) return null;
	const server = String(p.server);
	const port = String(p.port);
	const tag = p.name || (server + ':' + port);
	const net = String(p.network || 'tcp').toLowerCase();

	switch (p.type) {
		case 'ss': {
			const args = ['shadowsocks=' + server + ':' + port, 'method=' + (p.cipher || 'aes-256-gcm'), 'password=' + qxQuote(p.password || '')];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + qxQuote(opts.host));
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'ssr': {
			// QX 的 ssr 复用 shadowsocks= 前缀 + ssr-protocol 参数
			const args = ['shadowsocks=' + server + ':' + port, 'method=' + (p.cipher || 'aes-256-cfb'), 'password=' + qxQuote(p.password || '')];
			if (p.protocol) args.push('ssr-protocol=' + qxQuote(p.protocol));
			if (p['protocol-param']) args.push('ssr-protocol-param=' + qxQuote(p['protocol-param']));
			args.push('obfs=' + (p.obfs || 'plain'));
			if (p['obfs-param']) args.push('obfs-host=' + qxQuote(p['obfs-param']));
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'vmess':
		case 'vless': {
			const type = p.type;
			const args = [type + '=' + server + ':' + port];
			if (type === 'vmess') {
				args.push('method=' + (p.cipher && p.cipher !== 'auto' ? p.cipher : 'chacha20-poly1305'), 'password=' + (p.uuid || ''));
			} else {
				args.push('method=none', 'password=' + (p.uuid || ''));
			}
			// obfs 映射: tcp+tls → over-tls; ws → ws; ws+tls → wss; grpc/h2 无对应则降级
			if (net === 'tcp' && p.tls) args.push('obfs=over-tls');
			else if (net === 'ws' && p.tls) args.push('obfs=wss');
			else if (net === 'ws') args.push('obfs=ws');
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				if (ws.path) args.push('obfs-uri=' + ws.path);
				if (ws.headers && ws.headers.Host) args.push('obfs-host=' + qxQuote(ws.headers.Host));
			} else if (p.servername || p.sni) {
				args.push('obfs-host=' + qxQuote(p.servername || p.sni));
			}
			if (p.tls) args.push('tls-verification=false');
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'trojan': {
			const args = ['trojan=' + server + ':' + port, 'password=' + qxQuote(p.password || ''), 'over-tls=true'];
			if (p.servername || p.sni) args.push('tls-host=' + qxQuote(p.servername || p.sni));
			args.push('tls-verification=false');
			if (net === 'ws') {
				args.push('obfs=wss');
				const ws = p['ws-opts'] || {};
				if (ws.path) args.push('obfs-uri=' + ws.path);
				if (ws.headers && ws.headers.Host) args.push('obfs-host=' + qxQuote(ws.headers.Host));
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'http': {
			const args = ['http=' + server + ':' + port];
			if (p.username) args.push('username=' + qxQuote(p.username));
			if (p.password) args.push('password=' + qxQuote(p.password));
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-host=' + qxQuote(p.servername || p.sni));
				args.push('tls-verification=false');
			}
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		case 'hysteria2': {
			// QX 新版支持 hysteria2(社区公认语法)
			const args = ['hysteria2=' + server + ':' + port, 'password=' + qxQuote(p.password || '')];
			if (p.obfs) {
				args.push('obfs=salamander');
				if (p['obfs-password']) args.push('obfs-password=' + qxQuote(p['obfs-password']));
			}
			if (p.up) args.push('up=' + p.up);
			if (p.down) args.push('down=' + p.down);
			if (p.sni) args.push('sni=' + qxQuote(p.sni));
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			args.push('fast-open=false', 'udp-relay=' + (p.udp ? 'true' : 'false'), 'tag=' + qxQuote(tag));
			return args.join(', ');
		}
		default:
			// tuic / wireguard / socks5 / anytls / hysteria(v1) 等 QX 不支持的协议跳过
			return null;
	}
}

// QX 规则转换:Clash 规则行 -> QX [filter_local] 行;不支持的规则类型返回 null
function clashRuleToQuanx(r) {
	const parts = String(r).split(',').map(s => s.trim());
	const type = String(parts[0] || '').toLowerCase();
	// 规范化后的规则形如 IP-CIDR,x.x.x.x/x,策略名,no-resolve:
	// no-resolve 位于行末,策略名需取最后一个非 no-resolve 字段
	const hasNoResolve = parts.some(x => x.toLowerCase() === 'no-resolve');
	const meaningful = parts.slice(1).filter(x => x.toLowerCase() !== 'no-resolve');
	const value = String(meaningful[0] || '').trim();
	const policy = String(meaningful[meaningful.length - 1] || '').trim();
	switch (type) {
		case 'domain-suffix': return 'host-suffix, ' + value + ', ' + policy;
		case 'domain-keyword': return 'host-keyword, ' + value + ', ' + policy;
		case 'domain': return 'host, ' + value + ', ' + policy;
		case 'ip-cidr': return 'ip-cidr, ' + value + ', ' + policy + (hasNoResolve ? ', no-resolve' : '');
		case 'ip-cidr6': return 'ip6-cidr, ' + value + ', ' + policy + (hasNoResolve ? ', no-resolve' : '');
		case 'geoip': return 'geoip, ' + value.toLowerCase() + ', ' + policy;
		case 'match': return 'final, ' + policy;
		default: return null; // 跳过不支持的规则类型
	}
}

// 本地生成完整 Quantumult X 配置
async function 生成本地Quanx配置(节点文本, env, fileName = DEFAULT_FILE_NAME) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const servers = [];
	const names = [];
	for (const line of lines) {
		let p;
		try { p = uriToClashProxy(line); } catch (e) { p = null; } // 单节点解析失败只跳过该节点
		if (!p || !校验节点(p)) continue; // 协议级校验:不合格节点宁缺毋滥
		const s = clashToQuanxServer(p);
		if (!s) continue;
		servers.push(s);
		names.push(p.name || (p.server + ':' + p.port));
	}
	if (servers.length === 0) return '# 无可用节点\n';

	// 节点名去重(QX 的 tag 需唯一);同时规避内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', 'direct', 'reject', 'proxy', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		names[i] = n;
		const tagIdx = servers[i].lastIndexOf('tag=');
		servers[i] = servers[i].slice(0, tagIdx) + 'tag=' + qxQuote(n);
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const qxq = v => qxQuote(v);
	const policies = [
		'static=' + 节点选择 + ', ' + [自动选择, ...names, 直连].map(qxq).join(', '),
		'url-latency-benchmark=' + 自动选择 + ', ' + names.map(qxq).join(', ') + ', check-interval=300, alive-checking=true, tolerance=0',
		'static=' + 直连 + ', direct',
		'static=' + 拦截 + ', reject',
		'static=' + 媒体 + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + 电报 + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + Ai + ', ' + [节点选择, 直连].map(qxq).join(', '),
		'static=' + 漏网 + ', ' + [节点选择, 直连].map(qxq).join(', '),
	];

	// 规则复用 Clash 的 KV 缓存规则集,转换为 QX 语法
	const rules = (await 获取Clash规则(env))
		.map(clashRuleToQuanx)
		.filter(Boolean);
	// 兜底:内置局域网直连 + geoip cn
	const builtin = ['ip-cidr, 127.0.0.0/8, direct, no-resolve', 'ip-cidr, 10.0.0.0/8, direct, no-resolve', 'ip-cidr, 172.16.0.0/12, direct, no-resolve', 'ip-cidr, 192.168.0.0/16, direct, no-resolve', 'geoip, cn, direct'];
	for (const b of builtin) if (!rules.includes(b)) rules.unshift(b);
	if (!rules.some(r => r.startsWith('final,'))) rules.push('final, ' + 漏网);

	const out = [];
	out.push('[server_local]');
	for (const s of servers) out.push(s);
	out.push('');
	out.push('[policy]');
	for (const pol of policies) out.push(pol);
	out.push('');
	out.push('[filter_local]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}

// ===== Loon =====
// Loon 配置值:含逗号/引号的值加引号(官方示例中密码均带引号)
function loonQuote(v) {
	v = String(v ?? '');
	if (/[",]/.test(v) || /^\s|\s$/.test(v)) return '"' + v.replace(/"/g, '\\"') + '"';
	return v;
}

// Loon 官方示例中密码/UUID 始终带引号,避免密码含逗号时整行解析失败
function loonPass(v) {
	return '"' + String(v ?? '').replace(/"/g, '\\"') + '"';
}

// 将 Clash 代理对象转换为 Loon [Proxy] 行;不支持的协议返回 null
function clashToLoonProxy(p) {
	if (!p || !p.server || !p.port) return null;
	const name = String(p.name || (p.server + ':' + p.port));
	// [Proxy] 行首的节点名若含逗号/引号需要加引号,否则整行解析失败
	const displayName = loonQuote(name);
	const server = String(p.server);
	const port = String(p.port);
	const net = String(p.network || 'tcp').toLowerCase();

	switch (p.type) {
		case 'ss': {
			const args = ['Shadowsocks', server, port, p.cipher || 'aes-256-gcm', loonPass(p.password)];
			if (p.plugin === 'obfs') {
				const opts = p['plugin-opts'] || {};
				args.push('obfs-name=' + (opts.mode || 'http'));
				if (opts.host) args.push('obfs-host=' + loonQuote(opts.host));
				args.push('obfs-uri=/');
			}
			args.push('fast-open=false', 'udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'ssr': {
			const args = ['ShadowsocksR', server, port, p.cipher || 'aes-256-cfb', loonPass(p.password)];
			args.push('protocol=' + (p.protocol || 'origin'));
			if (p['protocol-param']) args.push('protocol-param=' + loonQuote(p['protocol-param']));
			args.push('obfs=' + (p.obfs || 'plain'));
			if (p['obfs-param']) args.push('obfs-param=' + loonQuote(p['obfs-param']));
			args.push('fast-open=false', 'udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'vmess': {
			const args = ['vmess', server, port, p.cipher && p.cipher !== 'auto' ? p.cipher : 'auto', loonPass(p.uuid)];
			args.push('transport=' + (net === 'tcp' ? 'tcp' : net));
			args.push('alterId=' + (p.alterId || 0));
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		case 'vless': {
			const args = ['VLESS', server, port, loonPass(p.uuid)];
			args.push('transport=' + (net === 'tcp' ? 'tcp' : net));
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.tls) {
				args.push('over-tls=true');
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		case 'trojan': {
			const args = ['trojan', server, port, loonPass(p.password)];
			if (net === 'ws') {
				const ws = p['ws-opts'] || {};
				args.push('transport=ws', 'path=' + (ws.path || '/'));
				if (ws.headers && ws.headers.Host) args.push('host=' + loonQuote(ws.headers.Host));
			}
			if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			args.push('udp=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'hysteria2': {
			const args = ['Hysteria2', server, port, loonPass(p.password)];
			if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			if (p.sni) args.push('tls-name=' + loonQuote(p.sni));
			args.push('udp=true', 'fast-open=true');
			return displayName + ' = ' + args.join(',');
		}
		case 'wireguard': {
			// Loon wireguard 官方格式(interface-ip + private-key + peers 数组)
			const args = ['wireguard'];
			if (p.ip) args.push('interface-ip=' + p.ip);
			if (p['private-key']) args.push('private-key="' + p['private-key'] + '"');
			if (p.mtu) args.push('mtu=' + p.mtu);
			const peer = [];
			if (p['public-key']) peer.push('public-key="' + p['public-key'] + '"');
			if (p['pre-shared-key']) peer.push('preshared-key="' + p['pre-shared-key'] + '"');
			if (Array.isArray(p.reserved) && p.reserved.length) peer.push('reserved=[' + p.reserved.join(',') + ']');
			peer.push('allowed-ips="0.0.0.0/0"');
			peer.push('endpoint=' + server + ':' + port);
			args.push('peers=[{' + peer.join(',') + '}]');
			args.push('keeyalive=45');
			return displayName + ' = ' + args.join(',');
		}
		case 'http': {
			const args = [p.tls ? 'https' : 'http', server, port];
			if (p.username) args.push(loonPass(p.username));
			if (p.password) args.push(loonPass(p.password));
			if (p.tls) {
				if (p.servername || p.sni) args.push('tls-name=' + loonQuote(p.servername || p.sni));
				if (p['skip-cert-verify']) args.push('skip-cert-verify=true');
			}
			return displayName + ' = ' + args.join(',');
		}
		default:
			// socks5 / tuic / anytls / hysteria(v1) 等 Loon 不支持的协议跳过
			return null;
	}
}

// Loon 规则转换:Clash 规则行 -> Loon [Rule] 行(Loon 规则与 Surge 几乎一致)
function clashRuleToLoon(r) {
	const parts = String(r).split(',');
	const type = String(parts[0] || '').trim().toLowerCase();
	if (type === 'match') return 'FINAL,' + parts.slice(1).join(',').trim();
	return String(r).trim();
}

// 本地生成完整 Loon 配置
async function 生成本地Loon配置(节点文本, env, fileName = DEFAULT_FILE_NAME) {
	const lines = String(节点文本 || '').split('\n').map(s => s.trim()).filter(Boolean);
	const proxies = [];
	const names = [];
	for (const line of lines) {
		const p = uriToClashProxy(line);
		if (!p) continue;
		const pr = clashToLoonProxy(p);
		if (!pr) continue;
		proxies.push(pr);
		names.push(p.name || (p.server + ':' + p.port));
	}
	if (proxies.length === 0) return '# 无可用节点\n';

	// 节点名去重(Loon 要求唯一),同步更新 [Proxy] 行;同时规避 DIRECT/REJECT 等内置保留名
	const seenNames = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'REJECT-DROP', '🎯 全球直连', '🛑 全球拦截', '🌍 国外媒体', '📲 电报信息', '💬 Ai平台', '🚀 节点选择', '♻️ 自动选择', '🐟 漏网之鱼']);
	for (let i = 0; i < names.length; i++) {
		let n = names[i];
		let k = 2;
		while (seenNames.has(n)) { n = names[i] + ' ' + k; k++; }
		seenNames.add(n);
		if (n !== names[i]) {
			names[i] = n;
			// 从引号包裹后的原名字之后定位 ' = '(防止名字本身含该子串)
			const eq = proxies[i].indexOf(' = ', loonQuote(names[i]).length);
			proxies[i] = loonQuote(n) + proxies[i].slice(eq);
		}
	}

	const 直连 = '🎯 全球直连';
	const 拦截 = '🛑 全球拦截';
	const 媒体 = '🌍 国外媒体';
	const 电报 = '📲 电报信息';
	const Ai = '💬 Ai平台';
	const 节点选择 = '🚀 节点选择';
	const 自动选择 = '♻️ 自动选择';
	const 漏网 = '🐟 漏网之鱼';

	const loonq = v => loonQuote(v);
	const groups = [
		节点选择 + ' = select, ' + [自动选择, ...names, 直连].map(loonq).join(', '),
		自动选择 + ' = url-test, ' + names.map(loonq).join(', ') + ', url=http://www.gstatic.com/generate_204, interval=300, tolerance=100',
		直连 + ' = select, DIRECT',
		拦截 + ' = select, REJECT',
		媒体 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		电报 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		Ai + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
		漏网 + ' = select, ' + [节点选择, 直连].map(loonq).join(', '),
	];

	const rules = (await 获取Clash规则(env)).map(clashRuleToLoon);
	if (!rules.some(r => r.startsWith('FINAL,'))) rules.push('FINAL,' + 漏网);

	const out = [];
	out.push('[Proxy]');
	for (const pr of proxies) out.push(pr);
	out.push('');
	out.push('[Proxy Group]');
	for (const g of groups) out.push(g);
	out.push('');
	out.push('[Rule]');
	for (const r of rules) out.push(r);
	return out.join('\n');
}


// ==================== 按协议过滤大订阅 ====================
// 识别一行节点链接的协议类型(取 :// 前的 scheme,小写),非节点行返回空串
function 节点协议(line) {
	const s = String(line).trim();
	const idx = s.indexOf('://');
	if (idx === -1) return '';
	let scheme = s.slice(0, idx).toLowerCase().trim();
	if (scheme === 'hy2') scheme = 'hysteria2';
	return scheme;
}

// 按允许的协议集合过滤大订阅内容;协议过滤为空(未设置)时返回原文,即全部显示
function 过滤协议节点(text, allowed) {
	const src = String(text || '');
	if (!allowed || allowed.size === 0) return src;
	return src.split('\n').filter(line => {
		const s = line.trim();
		if (!s) return false;
		return allowed.has(节点协议(s));
	}).join('\n');
}

// ==================== 节点去重 ====================
// 生成节点的去重身份键:忽略 #名称 片段、排序 query 参数、归一化 vmess/ssr,
// 这样不同来源订阅中“一模一样”的节点(仅名称或参数顺序不同)也能被识别为重复。

function 节点去重身份(line) {
	try {
		if (line.startsWith('vmess://')) {
			// 解码 JSON,剔除 ps(名称)字段后按排序键重新序列化
			const json = JSON.parse(base64Decode(line.slice(8)));
			delete json.ps;
			const obj = {};
			for (const k of Object.keys(json).sort()) obj[k] = json[k];
			return 'vmess://' + JSON.stringify(obj);
		}
		if (line.startsWith('ssr://')) {
			// 解码后剔除 remarks(名称)参数
			const decoded = base64Decode(line.slice(6));
			const m = decoded.split('/?');
			const params = (m[1] || '').split('&').filter(p => !p.startsWith('remarks=')).sort();
			const clean = m[0] + (params.length ? '/?' + params.join('&') : '');
			return 'ssr://' + btoaUnicode(clean);
		}
		let base = line.split('#')[0]; // 去掉 #名称 片段
		const qIdx = base.indexOf('?');
		if (qIdx !== -1) {
			// 排序 query 参数,避免顺序不同导致误判为不同节点
			base = base.slice(0, qIdx) + '?' + base.slice(qIdx + 1).split('&').filter(Boolean).sort().join('&');
		}
		return base;
	} catch (e) {
		return line; // 解析失败按整行比较
	}
}

// ==================== 剔除中国大陆节点 ====================
// 简单策略:节点名称命中「大陆关键词」即剔除,不做境外优化标记等额外判断。
//   1. 关键词包含:省份/直辖市/重点城市/中国/大陆/内地/国内/境内 等地域词,以及
//      大陆运营商词(移动/联通/电信/天翼/铁通)。
//   2. 故意不包含 香港/澳门/台湾,因此这些地区节点不会误删。
const 大陆地域词 = /北京|上海|广州|深圳|天津|重庆|成都|杭州|南京|武汉|西安|长沙|郑州|青岛|大连|东莞|福州|厦门|昆明|长春|沈阳|哈尔滨|乌鲁木齐|呼和浩特|南宁|贵阳|兰州|拉萨|银川|西宁|石家庄|太原|济南|合肥|南昌|苏州|无锡|宁波|温州|佛山|珠海|中山|惠州|汕头|湛江|三亚|常州|南通|徐州|扬州|嘉兴|绍兴|金华|台州|泉州|烟台|潍坊|临沂|淄博|济宁|泰安|洛阳|襄阳|宜昌|株洲|湘潭|岳阳|衡阳|绵阳|德阳|宜宾|南充|赣州|上饶|遵义|保定|廊坊|秦皇岛|唐山|邯郸|咸阳|宝鸡|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|中国|大陆|内地|国内|境内|移动|联通|电信|天翼|铁通/;

// 安全解码:仅当字符串含 % 时才尝试 URL 解码(vmess ps / # 片段可能被百分号编码),
// 解码失败时保留原始字符串,避免误报。
function 安全解码(v) {
	if (typeof v !== 'string') return '';
	if (v.includes('%')) { try { return decodeURIComponent(v); } catch (e) { /* 保留原样 */ } }
	return v;
}

// 解析一行节点链接的「显示名称」:vmess 取 base64 JSON 的 ps,ssr 取 remarks,
// 其余协议取 # 后的片段(尽量做 URL 解码);解析不到名称返回空串。
function 解析节点名(line) {
	const s = String(line || '').trim();
	if (!s) return '';
	try {
		if (s.startsWith('vmess://')) {
			const json = JSON.parse(base64Decode(s.slice(8)));
			if (json && json.ps) return 安全解码(String(json.ps));
			// vmess 无 ps 时回退到 # 片段
		}
		if (s.startsWith('ssr://')) {
			const decoded = base64Decode(s.slice(6));
			const m = decoded.match(/remarks=([^&]*)/);
			if (m) return 安全解码(m[1]);
		}
	} catch (e) { /* 解析失败回退到 # 片段 */ }
	const hash = s.lastIndexOf('#');
	if (hash !== -1) return 安全解码(s.slice(hash + 1));
	return '';
}

// 剔除「大陆节点」:名称命中「大陆关键词」的节点直接剔除,其余一律保留(宁缺毋滥)。
// 特例:名称含「香港/澳门/台湾」的节点(如「中国香港-01」「中国台湾」)不影响跨境使用,一律保留。
function 剔除大陆节点(text) {
	const src = String(text || '');
	return src.split('\n').filter(line => {
		const s = line.trim();
		if (!s) return true; // 保留空行
		const 名 = 解析节点名(s);
		if (!名) return true; // 取不到名称(注释等)一律保留
		if (/香港|澳门|台湾/.test(名)) return true; // 港澳台节点保留(如「中国香港」)
		return !大陆地域词.test(名);
	}).join('\n');
}

// 文本去重:同一节点(忽略名称差异)仅保留第一次出现的行
function 节点去重(text) {
	const uniqueLines = [];
	const seen = new Set();
	for (const line of text.split('\n')) {
		const id = 节点去重身份(line);
		if (!line || !id) {
			// 空行/注释等非节点行:按原始行去重(与旧行为一致)
			if (seen.has('RAW:' + line)) continue;
			seen.add('RAW:' + line);
			uniqueLines.push(line);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		uniqueLines.push(line);
	}
	return uniqueLines.join('\n');
}

async function 迁移地址列表(env, txt = 'ADD.txt') {
	const 旧数据 = await env.KV.get(`/${txt}`);
	const 新数据 = await env.KV.get(txt);

	if (旧数据 && !新数据) {
		// 写入新位置
		await env.KV.put(txt, 旧数据);
		// 删除旧数据
		await env.KV.delete(`/${txt}`);
		return true;
	}
	return false;
}

async function KV(request, env, txt = 'ADD.txt', { subscriptionToken, fileName } = {}) {
	const url = new URL(request.url);
	try {
		// POST请求处理
		if (request.method === "POST") {
			if (!env.KV) return new Response("未绑定KV空间", { status: 400 });
			try {
				const content = await request.text();
				if (new TextEncoder().encode(content).byteLength > MAX_KV_CONTENT_BYTES) {
					return new Response('提交内容超过大小限制', { status: 413 });
				}
				// 协议过滤配置: 使用 ?save=protocol 区分,保存到 PROTOCOL.txt
				if (url.searchParams.get('save') === 'protocol') {
					const clean = String(content).split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean).join(',');
					await env.KV.put('PROTOCOL.txt', clean);
					return new Response("协议过滤设置已保存");
				}
				// 剔除大陆节点开关: 使用 ?save=nocn 区分,保存到 NOCN.txt
				if (url.searchParams.get('save') === 'nocn') {
					await env.KV.put('NOCN.txt', String(content).trim());
					return new Response("剔除大陆节点设置已保存");
				}
				await env.KV.put(txt, content);
				return new Response("保存成功");
			} catch (error) {
				console.error('保存KV时发生错误:', error);
				return new Response("保存失败: " + error.message, { status: 500 });
			}
		}

		// GET请求部分
		let content = '';
		let hasKV = !!env.KV;

		if (hasKV) {
			try {
				content = await env.KV.get(txt) || '';
			} catch (error) {
				console.error('读取KV时发生错误:', error);
				content = '读取数据时发生错误: ' + error.message;
			}
		}

		// 读取协议过滤配置并生成勾选项
		let protoConfig = '';
		if (hasKV) {
			try { protoConfig = await env.KV.get('PROTOCOL.txt') || ''; } catch (e) { protoConfig = ''; }
		}
		const 已选协议 = new Set(String(protoConfig).split(/[,;\n]+/).map(x => x.trim().toLowerCase()).filter(Boolean));
		const 协议选项HTML = 支持协议.map(p => {
			const checked = 已选协议.has(p) ? 'checked' : '';
			return `<label style="margin-right:12px;display:inline-block;white-space:nowrap;"><input type="checkbox" class="proto-cb" value="${p}" ${checked}> ${p}</label>`;
		}).join('');
		// 读取「剔除大陆节点」开关并生成勾选状态
		let nocnConfig = '';
		if (hasKV) {
			try { nocnConfig = await env.KV.get('NOCN.txt') || ''; } catch (e) { nocnConfig = ''; }
		}
		const 剔除大陆已开 = /^(1|true|on|yes|开|是)$/i.test(String(nocnConfig || '').trim());

		const safeFileName = escapeHtml(fileName);
		const safeContent = '';
		const contentLiteral = escapeJs(content);
		const safeUserAgent = escapeHtml(request.headers.get('User-Agent') || '');

		const html = `
			<!DOCTYPE html>
			<html>
				<head>
					<title>${safeFileName} 订阅编辑</title>
					<meta charset="utf-8">
					<meta name="viewport" content="width=device-width, initial-scale=1">
					<style>
						:root { color-scheme: light; --ink:#172033; --muted:#687386; --line:#e5eaf1; --brand:#3857e8; --brand-dark:#2943c7; --soft:#f6f8fc; --success:#16835b; }
						* { box-sizing: border-box; }
						body { margin:0; min-height:100vh; color:var(--ink); background:#f3f6fb; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
						body:before { content:""; display:block; height:5px; background:linear-gradient(90deg,#3857e8,#7b61ff 55%,#20b486); }
						.page { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:42px 0 56px; }
						.hero { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; margin-bottom:28px; }
						.eyebrow { margin:0 0 8px; color:var(--brand); font-size:12px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; }
						h1 { margin:0; font-size:clamp(26px,4vw,38px); line-height:1.2; letter-spacing:-.04em; }
						.subtitle { max-width:650px; margin:11px 0 0; color:var(--muted); font-size:15px; }
						.badge { flex:none; padding:8px 13px; border:1px solid #dce3ff; border-radius:999px; color:var(--brand); background:#f0f3ff; font-size:12px; font-weight:700; }
						.grid { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(320px,.65fr); gap:20px; align-items:start; }
						.card { min-width:0; padding:24px; border:1px solid rgba(220,226,237,.9); border-radius:18px; background:#fff; box-shadow:0 12px 35px rgba(35,49,87,.06); }
						.card + .card { margin-top:20px; }
						.card-title { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 5px; font-size:18px; letter-spacing:-.02em; }
						.card-title span { color:var(--muted); font-size:12px; font-weight:500; letter-spacing:0; }
						.card-intro { margin:0 0 18px; color:var(--muted); }
						.link-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
						.link-card { min-width:0; padding:15px; border:1px solid var(--line); border-radius:12px; background:var(--soft); transition:.2s ease; }
						.link-card:hover { border-color:#b7c4ff; background:#f7f8ff; transform:translateY(-1px); }
						.link-label { display:block; margin-bottom:7px; color:var(--muted); font-size:12px; font-weight:700; }
						.sub-link { display:block; overflow:hidden; color:var(--brand); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-decoration:none; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
						.sub-link:hover { color:var(--brand-dark); text-decoration:underline; }
						.qr { display:flex; min-height:0; margin-top:12px; justify-content:center; }
						.qr:empty { display:none; }
						.qr img { max-width:150px; height:auto; padding:7px; border-radius:8px; background:#fff; }
						.notice-toggle { display:inline-flex; margin-top:18px; color:var(--brand); font-weight:700; text-decoration:none; }
						.notice-content { margin-top:16px; padding:16px; border:1px solid #dce3ff; border-radius:12px; background:#f7f8ff; }
						.info-row { display:grid; gap:5px; padding:13px 0; border-bottom:1px solid var(--line); }
						.info-row:last-child { border-bottom:0; padding-bottom:0; }
						.info-label { color:var(--muted); font-size:12px; font-weight:700; }
						.info-value { overflow-wrap:anywhere; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
						.editor:focus { border-color:#8799f5; box-shadow:0 0 0 4px rgba(56,87,232,.11); background:#fff; }
						.divider { height:1px; margin:25px 0; border:0; background:var(--line); }
						.proto-container { padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--soft); }
						.proto-options { display:flex; flex-wrap:wrap; gap:8px; }
						.proto-options label { display:inline-flex !important; align-items:center; gap:6px; margin:0 !important; padding:6px 10px; border:1px solid var(--line); border-radius:7px; color:#4c5870; background:#fff; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
						.proto-options input { accent-color:var(--brand); }
						.helper { margin:12px 0 0; color:var(--muted); font-size:12px; }
						.footer { margin-top:22px; color:#9aa3b2; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
						@media (max-width:760px) { .page { width:min(100% - 24px,600px); padding:28px 0 36px; } .hero { display:block; } .badge { display:inline-block; margin-top:18px; } .grid { display:block; } .card { padding:18px; border-radius:14px; } .link-list { grid-template-columns:1fr; } .editor { min-height:280px; } }
						.editor-container {
							width: 100%;
							max-width: 100%;
							margin: 0 auto;
						}
						.editor {
							width: 100%;
							height: 300px; /* 调整高度 */
							margin: 15px 0; /* 调整margin */
							padding: 10px; /* 调整padding */
							box-sizing: border-box;
							border: 1px solid #ccc;
							border-radius: 4px;
							font-size: 13px;
							line-height: 1.5;
							overflow-y: auto;
							resize: none;
						}
						.save-container {
							margin-top: 8px; /* 调整margin */
							display: flex;
							align-items: center;
							gap: 10px; /* 调整gap */
						}
						.save-btn, .back-btn {
							padding: 6px 15px; /* 调整padding */
							color: white;
							border: none;
							border-radius: 4px;
							cursor: pointer;
						}
						.save-btn {
							background: #4CAF50;
						}
						.save-btn:hover {
							background: #45a049;
						}
						.back-btn {
							background: #666;
						}
						.back-btn:hover {
							background: #555;
						}
						.save-status {
							color: #666;
						}
						/* Responsive dashboard overrides for the existing editor markup. */
						body { max-width:none; }
						body > .page { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:42px 0 56px; }
						.page > h1 { margin:0 0 24px; color:#172033; font-size:clamp(26px,4vw,38px); letter-spacing:-.04em; }
						.page > .section-label { margin:26px 0 8px; color:#687386; font-size:12px; font-weight:700; }
						.page > a:not(.section-label) { display:inline-block; max-width:100%; margin:3px 0; padding:7px 11px; overflow:hidden; border:1px solid #e5eaf1; border-radius:8px; color:#3857e8 !important; background:#fff; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; vertical-align:middle; white-space:nowrap; }
						#noticeToggle { border:0; background:transparent; font-family:inherit; }
						#noticeContent { max-width:760px; padding:20px; border:1px solid #dce3ff; border-radius:14px; background:#f7f8ff; }
						.editor-container { max-width:760px; padding:24px; border:1px solid #dce2ec; border-radius:18px; background:#fff; box-shadow:0 12px 35px rgba(35,49,87,.06); }
						.editor { width:100%; height:340px; margin:18px 0 14px; padding:16px; resize:vertical; border:1px solid #dbe1eb; border-radius:12px; outline:none; color:#27324a; background:#fbfcfe; font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; }
						.save-container { margin-top:12px; }
						.save-btn { background:#3857e8; border-radius:9px; box-shadow:0 5px 12px rgba(56,87,232,.2); }
						.save-btn:hover { background:#2943c7; }
						.proto-container { margin-top:22px; padding:18px; border:1px solid #e5eaf1; border-radius:12px; background:#f6f8fc; }
						@media (max-width:760px) { body > .page { width:calc(100% - 24px); padding:28px 0 36px; } .editor-container { padding:18px; } .editor { height:280px; } }
					</style>
					<script src="https://cdn.jsdelivr.net/npm/@keeex/qrcodejs-kx@1.0.2/qrcode.min.js"></script>
				</head>
				<body><main class="page">
					<p class="eyebrow">Subscription control center</p>
					<h1>${safeFileName} <span style="color:#3857e8">订阅控制台</span></h1>
					<p class="subtitle">集中管理你的节点与订阅链接，点击任意地址即可复制并生成二维码。</p>
					<div style="margin-top:14px;padding:10px 14px;border:1px dashed #ffb3b3;border-radius:10px;background:#fff5f5;color:#c0392b;font-size:12px;">
						<strong>部署版本:</strong> ${DEPLOY_VERSION}
					</div>
					################################################################<br>
					Subscribe / sub 订阅地址, 点击链接自动 <strong>复制订阅链接</strong> 并 <strong>生成订阅二维码</strong> <br>
					---------------------------------------------------------------<br>
					自适应订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}','qrcode_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}</a><br>
					<div id="qrcode_0" style="margin: 10px 10px 10px 10px;"></div>
					Base64订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&b64','qrcode_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&b64</a><br>
					<div id="qrcode_1" style="margin: 10px 10px 10px 10px;"></div>
					clash订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&clash','qrcode_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&clash</a><br>
					<div id="qrcode_2" style="margin: 10px 10px 10px 10px;"></div>
					singbox订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&sb','qrcode_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&sb</a><br>
					<div id="qrcode_3" style="margin: 10px 10px 10px 10px;"></div>
					surge订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&surge','qrcode_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&surge</a><br>
					<div id="qrcode_4" style="margin: 10px 10px 10px 10px;"></div>
					loon订阅地址:<br>
					<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&loon','qrcode_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&loon</a><br>
					<div id="qrcode_5" style="margin: 10px 10px 10px 10px;"></div>
					&nbsp;&nbsp;<strong><a href="javascript:void(0);" id="noticeToggle" onclick="toggleNotice()">查看访客订阅∨</a></strong><br>
					<div id="noticeContent" class="notice-content" style="display: none;">
						---------------------------------------------------------------<br>
						访客订阅只能使用订阅功能，无法查看配置页！<br>
						SUBTOKEN（订阅 UUID）: <strong>${subscriptionToken}</strong><br>
						---------------------------------------------------------------<br>
						自适应订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}','guest_0')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}</a><br>
						<div id="guest_0" style="margin: 10px 10px 10px 10px;"></div>
						Base64订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&b64','guest_1')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&b64</a><br>
						<div id="guest_1" style="margin: 10px 10px 10px 10px;"></div>
						clash订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&clash','guest_2')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&clash</a><br>
						<div id="guest_2" style="margin: 10px 10px 10px 10px;"></div>
						singbox订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&sb','guest_3')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&sb</a><br>
						<div id="guest_3" style="margin: 10px 10px 10px 10px;"></div>
						surge订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&surge','guest_4')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&surge</a><br>
						<div id="guest_4" style="margin: 10px 10px 10px 10px;"></div>
						loon订阅地址:<br>
						<a href="javascript:void(0)" onclick="copyToClipboard('https://${url.hostname}/sub?token=${subscriptionToken}&loon','guest_5')" style="color:blue;text-decoration:underline;cursor:pointer;">https://${url.hostname}/sub?token=${subscriptionToken}&loon</a><br>
						<div id="guest_5" style="margin: 10px 10px 10px 10px;"></div>
					</div>
					---------------------------------------------------------------<br>
					################################################################<br>
					订阅转换配置<br>
					---------------------------------------------------------------<br>
					✅ 全部订阅格式(base64 / Clash / sing-box / Surge / Quantumult X / Loon)均已由 Worker 本地生成,<br>
					订阅源解析不依赖任何第三方转换后端(零外部依赖)。<br>
					---------------------------------------------------------------<br>
					################################################################<br>
					${safeFileName} 汇聚订阅编辑: 
					<div class="editor-container">
						${hasKV ? `
						<textarea class="editor" 
							placeholder="${decodeURIComponent(atob('TElOSyVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNCVCOCVBQSVFOCU4QSU4MiVFNyU4MiVCOSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQp2bGVzcyUzQSUyRiUyRjI0NmFhNzk1LTA2MzctNGY0Yy04ZjY0LTJjOGZiMjRjMWJhZCU0MDEyNy4wLjAuMSUzQTEyMzQlM0ZlbmNyeXB0aW9uJTNEbm9uZSUyNnNlY3VyaXR5JTNEdGxzJTI2c25pJTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2YWxsb3dJbnNlY3VyZSUzRDElMjZ0eXBlJTNEd3MlMjZob3N0JTNEVEcuQ01MaXVzc3NzLmxvc2V5b3VyaXAuY29tJTI2cGF0aCUzRCUyNTJGJTI1M0ZlZCUyNTNEMjU2MCUyM0NGbmF0CnRyb2phbiUzQSUyRiUyRmFhNmRkZDJmLWQxY2YtNGE1Mi1iYTFiLTI2NDBjNDFhNzg1NiU0MDIxOC4xOTAuMjMwLjIwNyUzQTQxMjg4JTNGc2VjdXJpdHklM0R0bHMlMjZzbmklM0RoazEyLmJpbGliaWxpLmNvbSUyNmFsbG93SW5zZWN1cmUlM0QxJTI2dHlwZSUzRHRjcCUyNmhlYWRlclR5cGUlM0Rub25lJTIzSEsKc3MlM0ElMkYlMkZZMmhoWTJoaE1qQXRhV1YwWmkxd2IyeDVNVE13TlRveVJYUlFjVzQyU0ZscVZVNWpTRzlvVEdaVmNFWlJkMjVtYWtORFVUVnRhREZ0U21SRlRVTkNkV04xVjFvNVVERjFaR3RTUzBodVZuaDFielUxYXpGTFdIb3lSbTgyYW5KbmRERTRWelkyYjNCMGVURmxOR0p0TVdwNlprTm1RbUklMjUzRCU0MDg0LjE5LjMxLjYzJTNBNTA4NDElMjNERQoKCiVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNyVBNCVCQSVFNCVCRSU4QiVFRiVCQyU4OCVFNCVCOCU4MCVFOCVBMSU4QyVFNCVCOCU4MCVFNiU5RCVBMSVFOCVBRSVBMiVFOSU5OCU4NSVFOSU5MyVCRSVFNiU4RSVBNSVFNSU4RCVCMyVFNSU4RiVBRiVFRiVCQyU4OSVFRiVCQyU5QQpodHRwcyUzQSUyRiUyRnN1Yi54Zi5mcmVlLmhyJTJGYXV0bw=='))}"
							id="content">${safeContent}</textarea>
						<script>document.getElementById('content').value = ${contentLiteral};</script>
						<div class="save-container">
							<button class="save-btn" onclick="saveContent(this)">保存</button>
							<span class="save-status" id="saveStatus"></span>
						</div>
						<hr>
						<div class="proto-container">
							<strong>按协议过滤（最后合成大订阅只保留勾选的协议，未勾选的隐藏）：</strong><br>
							<div style="margin:8px 0;">${协议选项HTML}</div>
							<div class="save-container">
								<button class="save-btn" onclick="saveProtocol(this)">保存协议设置</button>
								<span class="save-status" id="protoStatus"></span>
							</div>
							<div style="font-size:12px;color:#888;">提示：一个都不勾选并保存 = 不过滤，显示全部协议节点。</div>
						</div>
						<hr>
						<div class="proto-container">
							<strong>剔除中国大陆节点：</strong><br>
							<label style="margin:8px 0;display:inline-block;white-space:nowrap;">
								<input type="checkbox" id="nocnCb" ${剔除大陆已开 ? 'checked' : ''}> 剔除名称含「省份/城市/中国/大陆/移动/联通/电信」等关键词的节点（名称含香港/澳门/台湾的不受影响）
							</label>
							<div class="save-container">
								<button class="save-btn" onclick="saveNocn(this)">保存剔除设置</button>
								<span class="save-status" id="nocnStatus"></span>
							</div>
						</div>
						` : '<p>请绑定 <strong>变量名称</strong> 为 <strong>KV</strong> 的KV命名空间</p>'}
					</div>
					<br>
					<br><br>UA: <strong>${safeUserAgent}</strong>
					<script>
					function copyToClipboard(text, qrcode) {
						navigator.clipboard.writeText(text).then(() => {
							alert('已复制到剪贴板');
						}).catch(err => {
							console.error('复制失败:', err);
						});
						const qrcodeDiv = document.getElementById(qrcode);
						qrcodeDiv.innerHTML = '';
						new QRCode(qrcodeDiv, {
							text: text,
							width: 220, // 调整宽度
							height: 220, // 调整高度
							colorDark: "#000000", // 二维码颜色
							colorLight: "#ffffff", // 背景颜色
							correctLevel: QRCode.CorrectLevel.Q, // 设置纠错级别
							scale: 1 // 调整像素颗粒度
						});
					}

					// 收集勾选的协议
					function collectProtocols() {
						return Array.from(document.querySelectorAll('.proto-cb'))
							.filter(cb => cb.checked)
							.map(cb => cb.value)
							.join(',');
					}

					// 保存协议过滤设置
					function saveProtocol(button) {
						if (!button) return;
						button.disabled = true;
						const status = document.getElementById('protoStatus');
						const setStatus = (msg, color) => {
							if (status) { status.textContent = msg; status.style.color = color || '#666'; }
						};
						setStatus('保存中...');
						fetch(window.location.pathname + '?save=protocol', {
							method: 'POST',
							body: collectProtocols(),
							headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
							cache: 'no-cache'
						}).then(res => {
							if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
							return res.text();
						}).then(t => {
							setStatus('已保存: ' + t, '#4CAF50');
						}).catch(e => {
							console.error('保存协议设置失败:', e);
							setStatus('保存失败: ' + e.message, 'red');
						}).finally(() => {
							button.disabled = false;
						});
					}

// 保存「剔除大陆节点」开关
					function saveNocn(button) {
						if (!button) return;
						button.disabled = true;
						const status = document.getElementById('nocnStatus');
						const setStatus = (msg, color) => {
							if (status) { status.textContent = msg; status.style.color = color || '#666'; }
						};
						setStatus('保存中...');
						const cb = document.getElementById('nocnCb');
						// 保留当前 URL 的 token 等参数,避免经 /?token= 打开的页在保存时丢掉鉴权参数
					const saveUrl = new URL(window.location.href);
					saveUrl.search = '';
					saveUrl.searchParams.set('save', 'nocn');
					fetch(saveUrl.toString(), {
							method: 'POST',
							body: cb && cb.checked ? '1' : '0',
							headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
							cache: 'no-cache'
						}).then(res => {
							if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
							return res.text();
						}).then(t => {
							setStatus('已保存: ' + t, '#4CAF50');
						}).catch(e => {
							console.error('保存剔除设置失败:', e);
							setStatus('保存失败: ' + e.message, 'red');
						}).finally(() => {
							button.disabled = false;
						});
					}
						
					if (document.querySelector('.editor')) {
						let timer;
						const textarea = document.getElementById('content');
						const originalContent = textarea.value;
		
						function goBack() {
							const currentUrl = window.location.href;
							const parentUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/'));
							window.location.href = parentUrl;
						}
		
						function replaceFullwidthColon() {
							const text = textarea.value;
							textarea.value = text.replace(/：/g, ':');
						}
						
						function saveContent(button) {
							try {
								const updateButtonText = (step) => {
									button.textContent = \`保存中: \${step}\`;
								};
								// 检测是否为iOS设备
								const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
								
								// 仅在非iOS设备上执行replaceFullwidthColon
								if (!isIOS) {
									replaceFullwidthColon();
								}
								updateButtonText('开始保存');
								button.disabled = true;

								// 获取textarea内容和原始内容
								const textarea = document.getElementById('content');
								if (!textarea) {
									throw new Error('找不到文本编辑区域');
								}

								updateButtonText('获取内容');
								let newContent;
								let originalContent;
								try {
									newContent = textarea.value || '';
									originalContent = textarea.defaultValue || '';
								} catch (e) {
									console.error('获取内容错误:', e);
									throw new Error('无法获取编辑内容');
								}

								updateButtonText('准备状态更新函数');
								const updateStatus = (message, isError = false) => {
									const statusElem = document.getElementById('saveStatus');
									if (statusElem) {
										statusElem.textContent = message;
										statusElem.style.color = isError ? 'red' : '#666';
									}
								};

								updateButtonText('准备按钮重置函数');
								const resetButton = () => {
									button.textContent = '保存';
									button.disabled = false;
								};

								if (newContent !== originalContent) {
									updateButtonText('发送保存请求');
									fetch(window.location.href, {
										method: 'POST',
										body: newContent,
										headers: {
											'Content-Type': 'text/plain;charset=UTF-8'
										},
										cache: 'no-cache'
									})
									.then(response => {
										updateButtonText('检查响应状态');
										if (!response.ok) {
											throw new Error(\`HTTP error! status: \${response.status}\`);
										}
										updateButtonText('更新保存状态');
										const now = new Date().toLocaleString();
										document.title = \`编辑已保存 \${now}\`;
										updateStatus(\`已保存 \${now}\`);
									})
									.catch(error => {
										updateButtonText('处理错误');
										console.error('Save error:', error);
										updateStatus(\`保存失败: \${error.message}\`, true);
									})
									.finally(() => {
										resetButton();
									});
								} else {
									updateButtonText('检查内容变化');
									updateStatus('内容未变化');
									resetButton();
								}
							} catch (error) {
								console.error('保存过程出错:', error);
								button.textContent = '保存';
								button.disabled = false;
								const statusElem = document.getElementById('saveStatus');
								if (statusElem) {
									statusElem.textContent = \`错误: \${error.message}\`;
									statusElem.style.color = 'red';
								}
							}
						}
		
						textarea.addEventListener('blur', saveContent);
						textarea.addEventListener('input', () => {
							clearTimeout(timer);
							timer = setTimeout(saveContent, 5000);
						});
					}

					function toggleNotice() {
						const noticeContent = document.getElementById('noticeContent');
						const noticeToggle = document.getElementById('noticeToggle');
						if (noticeContent.style.display === 'none' || noticeContent.style.display === '') {
							noticeContent.style.display = 'block';
							noticeToggle.textContent = '隐藏访客订阅∧';
						} else {
							noticeContent.style.display = 'none';
							noticeToggle.textContent = '查看访客订阅∨';
						}
					}
			
					// 初始化 noticeContent 的 display 属性
					document.addEventListener('DOMContentLoaded', () => {
						document.getElementById('noticeContent').style.display = 'none';
					});
					</script></main>
				</body>
			</html>
		`;

		return new Response(html, {
			headers: {
				"Content-Type": "text/html;charset=utf-8",
				"Cache-Control": "no-store",
				"Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options": "DENY",
				"Referrer-Policy": "no-referrer"
			}
		});
	} catch (error) {
		console.error('处理请求时发生错误:', error);
		return new Response("服务器错误: " + error.message, {
			status: 500,
			headers: { "Content-Type": "text/plain;charset=utf-8" }
		});
	}
}
