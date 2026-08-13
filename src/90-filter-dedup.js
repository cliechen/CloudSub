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

