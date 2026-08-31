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
	// Node/undici 等环境对挂起的连接可能不遵守 AbortSignal.timeout(无限阻塞),导致阶段1 的
	// Promise.allSettled 也随之无限等待,整个订阅被拖垮(表现为订阅数偏少/卡死)。
	// 这里用 JS 计时器为每个源的「请求 + 读取」提供硬超时兑底:到点即抛 TimeoutError,
	// 保证任一挂起源都不会阻塞整份聚合,其余正常源照常聚合返回。
	const 带超时 = (p, ms) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Object.assign(new Error('超时(可调大 SUBMAXTIME)'), { name: 'TimeoutError' })), ms);
		Promise.resolve(p).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
	});
	const 请求一个源 = async (apiUrl) => {
		// AbortSignal.timeout 交由环境处理;JS 计时器兜底硬限时,挂起也不无限阻塞
		const 尝试 = () => 带超时(getUrl(request, apiUrl, 追加UA, userAgentHeader, AbortSignal.timeout(超时), (etags && etags[apiUrl]) || null), 超时);
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
			// 超时(AbortError/TimeoutError)与网络级错误都允许重试:raw/GitHub 等源在冷启动或高峰时
			// 常见瞬时慢到超时,若是「不重试」会直接把该源整份丢弃,订阅漏掉大量节点(实测单次可差数百行)。
			// 每次尝试都经 带超时 硬限时且共享 剩余重试 预算全局封顶,不会无限拉长总耗时。
			if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
				const 重试请求 = 若可重试();
				if (!重试请求) throw e;
				return await 重试请求; // 瞬时超时重试一次(额度耗尽则放弃)
			}
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
				return await 带超时(readLimitedResponse(resp, 读取上限, 预算, 本次消耗), 超时);
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
			const 重试响应 = await 带超时(getUrl(request, apiUrl, 追加UA, userAgentHeader, AbortSignal.timeout(超时)), 超时);
			if (!重试响应.ok) { 释放连接(重试响应); throw new Error('重试仍失败: HTTP ' + 重试响应.status); }
			// 重试响应也必须使用本源的读取上限和同一共享预算；否则重试会绕过限制，
			// 或在共享预算不足时继续读取并造成结果不稳定。
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
	newHeaders.set("User-Agent", `${atob('djJyYXlOLzYuNDU=')} CloudSub ${追加UA}(${userAgentHeader || 'null'})`);
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

