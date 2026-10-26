/**
 * Настройки прокси для магазинов: читаются из stores/proxy.env.
 * Одна точка правды и для скриптов, и для MCP-сервера Playwright.
 */
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = join(HERE, "proxy.env");

export function loadStoreEnv(env = process.env) {
	const values = { ...env };
	try {
		for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
			const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
			if (match === null) continue;
			const value = match[2].trim().replace(/^["']|["']$/g, "");
			if (value !== "") values[match[1]] = value;
		}
	} catch {
		/* файла нет — работаем с тем, что есть */
	}
	return values;
}

/** Разбор строки прокси (апстрима) из STORE_PROXY. */
export function upstreamProxy(env = loadStoreEnv()) {
	const raw = (env.STORE_PROXY ?? "").trim();
	if (raw === "") return undefined;
	const url = new URL(raw);
	const proxy = { server: `${url.protocol}//${url.host}` };
	if (url.username !== "") proxy.username = decodeURIComponent(url.username);
	if (url.password !== "") proxy.password = decodeURIComponent(url.password);
	const bypass = (env.STORE_PROXY_BYPASS ?? "").trim();
	if (bypass !== "") proxy.bypass = bypass;
	return proxy;
}

/**
 * Что должен использовать браузер: локальный мостик (без авторизации, слушает 127.0.0.1),
 * потому что Chromium не умеет SOCKS5 с паролем и не принимает учётку отдельно.
 * Если мостик выключен (BROWSER_PROXY=none) — отдаём апстрим как есть.
 */
export function proxyFor(env = loadStoreEnv()) {
	const explicit = (env.BROWSER_PROXY ?? "").trim();
	if (explicit !== "") return explicit === "none" ? undefined : { server: explicit };
	if (upstreamProxy(env) === undefined) return undefined;
	return { server: `http://127.0.0.1:${Number(env.BROWSER_PROXY_PORT ?? 8890)}` };
}

export function profileDir(env = loadStoreEnv()) {
	return env.BROWSER_PROFILE ?? join(HERE, "browser-profile");
}

/** Путь к Chromium, установленному в кэше Playwright (сборки MCP и браузера часто расходятся). */
export function chromiumPath() {
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? homedir(), ".cache", "ms-playwright");
	if (!existsSync(root)) return undefined;
	const candidates = readdirSync(root)
		.filter((name) => /^chromium-\d+$/.test(name))
		.sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
	for (const dir of candidates) {
		for (const relative of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
			const path = join(root, dir, relative);
			if (existsSync(path)) return path;
		}
	}
	return undefined;
}

/** Аргументы для @playwright/mcp (обёртка stores/playwright-mcp.sh). */
export function mcpArgs(env = loadStoreEnv()) {
	// --no-sandbox обязателен: на сервере нет прав на user-namespaces (Ubuntu 24.04 + AppArmor)
	const args = ["-y", "@playwright/mcp@latest", "--no-sandbox", "--user-data-dir", profileDir(env)];
	const executable = chromiumPath();
	if (executable !== undefined) args.push("--executable-path", executable);
	const proxy = proxyFor(env);
	if (proxy === undefined) return [...args, "--headless"];
	// с прокси запускаем видимый браузер под xvfb: антибот-системы охотнее пропускают не-headless
	return [...args, "--proxy-server", proxy.server, ...(proxy.bypass ? ["--proxy-bypass", proxy.bypass] : [])];
}
