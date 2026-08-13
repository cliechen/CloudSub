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

