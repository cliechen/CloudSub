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

