#!/usr/bin/env node
/**
 * magnit.mjs — клиент внутреннего API «Магнита» (webgate).
 *
 *   node tools/magnit.mjs stores --lat 55.03 --lon 82.92 [--radius 0.02]
 *   node tools/magnit.mjs search "молоко" --store <код> [--limit 10] [--json]
 *   node tools/magnit.mjs categories --store <код>
 *   node tools/magnit.mjs product <id> --store <код>
 *
 * Магазин задаётся --store или переменной MAGNIT_STORE (код магазина из stores).
 * или переменной MAGNIT_STORE. Ходит через российский прокси socks5://127.0.0.1:8890
 * (переопределить: MAGNIT_PROXY).
 */
import { randomUUID } from "node:crypto";

const BASE = "https://magnit.ru";
const APP_VERSION = process.env.MAGNIT_APP_VERSION ?? "2026.10.21-11.6";
const DEFAULT_STORE = process.env.MAGNIT_STORE ?? "";
const PROXY = process.env.MAGNIT_PROXY ?? "socks5h://127.0.0.1:8890";

const args = process.argv.slice(2);
const command = args[0];
const value = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const positional = args.slice(1).filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i]?.startsWith("--")) && !args.includes(`--${args[i - 1]?.replace(/^--/, "")}`));

const store = value("store", DEFAULT_STORE);
if (!["stores"].includes(command) && store === "") {
	console.error("нужен магазин: --store <код> или MAGNIT_STORE");
	process.exit(1);
}

const headers = (extra = {}) => ({
	"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	accept: "application/json",
	"accept-language": "ru-RU",
	"content-type": "application/json",
	origin: BASE,
	referer: `${BASE}/`,
	"x-client-name": "magnit",
	"x-magnit-bff": "1",
	"x-new-magnit": "true",
	"x-app-version": APP_VERSION,
	"x-device-id": randomUUID(),
	"x-device-platform": "Web",
	"x-platform-version": "Linux Chrome 131",
	"x-device-tag": "disabled",
	cookie: `shopCode=${store}; x_shop_type=dostavka`,
	...extra,
});

async function call(path, { method = "GET", body } = {}) {
	const { ProxyAgent } = await import("undici").catch(() => ({}));
	const options = { method, headers: headers() };
	if (body !== undefined) options.body = JSON.stringify(body);
	if (ProxyAgent !== undefined) options.dispatcher = new ProxyAgent(PROXY);
	const response = await fetch(`${BASE}${path}`, options);
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error(`${path}: не JSON (${response.status}) — ${text.slice(0, 120)}`);
	}
	if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
	return data;
}

const money = (cents) => (Number(cents) / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function stores() {
	const lat = Number(value("lat", 55.03));
	const lon = Number(value("lon", 82.92));
	const radius = Number(value("radius", 0.03));
	const data = await call("/webgate/v1/stores-facade/search/detail", {
		method: "POST",
		body: {
			filters: {
				geo: {
					typeName: "box",
					leftTopPoint: { latitude: lat + radius, longitude: lon - radius },
					rightBottomPoint: { latitude: lat - radius, longitude: lon + radius },
				},
				storeTypeListV2: ["MM", "GM", "DG", "MO", "ME", "MC", "DARKSTORE", "MM_MINI", "ZARYAD"],
			},
			pagination: { offset: 0, size: Number(value("limit", 20)) },
			sorting: { sortBy: "SORT_BY_CITY", sortType: "SORT_TYPE_ASC" },
		},
	});
	const list = data.data ?? [];
	if (has("json")) return console.log(JSON.stringify(list, null, 1));
	for (const s of list) {
		console.log(`${s.externalId?.storeCode}  ${s.storeTypeV2}  ${s.address}${s.isActive ? "" : "  (закрыт)"}`);
	}
}

async function search() {
	const term = positional[0];
	if (term === undefined) throw new Error('нужен запрос: node tools/magnit.mjs search "молоко"');
	const limit = Math.min(Number(value("limit", 10)), 36);
	const data = await call("/webgate/v2/goods/search", {
		method: "POST",
		body: {
			includeAdultGoods: true,
			pagination: { offset: Number(value("offset", 0)), limit },
			sort: { order: "desc", type: "popularity" },
			term,
			storeCode: store,
			storeType: "dostavka",
			catalogType: "3",
		},
	});
	const items = data.items ?? [];
	if (has("json")) return console.log(JSON.stringify(items, null, 1));
	const total = data.pagination?.total ?? items.length;
	console.log(`«${data.term ?? term}» в магазине ${store}: найдено ${total}`);
	for (const item of items) {
		const old = item.oldPrice && Number(item.oldPrice) > Number(item.price) ? ` (было ${money(item.oldPrice)})` : "";
		console.log(`${money(item.price)} ₽${old}  ${item.name}  [id ${item.id}]`);
	}
}

async function categories() {
	const data = await call(`/webgate/v3/categories/store/${store}?storetype=dostavka&catalogtype=3`);
	const list = Array.isArray(data) ? data : (data.items ?? data.data ?? []);
	if (has("json")) return console.log(JSON.stringify(list, null, 1));
	const walk = (nodes, depth = 0) => {
		for (const node of nodes ?? []) {
			console.log(`${"  ".repeat(depth)}${node.name}${node.id ? `  [${node.id}]` : ""}`);
			walk(node.children ?? node.categories, depth + 1);
		}
	};
	walk(list);
}

async function product() {
	const id = positional[0];
	if (id === undefined) throw new Error("нужен id товара");
	const data = await call("/webgate/recoms/v1/recommendations", {
		method: "POST",
		body: {
			catalogType: "3",
			goodsIds: [String(id)],
			limit: 1,
			offset: 0,
			service: "express",
			stores: [{ code: store, catalogType: "3", service: "express" }],
			type: "goods",
		},
	});
	console.log(JSON.stringify(data, null, 1).slice(0, 2000));
}

const commands = { stores, search, categories, product };
try {
	if (command === undefined || commands[command] === undefined) {
		console.log("команды: stores | search | categories | product\nпример: node tools/magnit.mjs search \"молоко\" --store <код>");
		process.exit(command === undefined ? 0 : 1);
	}
	await commands[command]();
} catch (error) {
	process.stderr.write(`magnit: ${error?.message ?? error}\n`);
	process.exit(1);
}
