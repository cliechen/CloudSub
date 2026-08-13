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

