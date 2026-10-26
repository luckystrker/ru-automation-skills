/**
 * Поиск рабочего Playwright: в кэше npx бывает несколько версий, а браузеры
 * установлены не под все. Выбираем ту, чья ревизия chromium уже скачана.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");

function chromiumRevision(packageDir) {
	try {
		const manifest = JSON.parse(readFileSync(join(packageDir, "..", "playwright-core", "browsers.json"), "utf8"));
		return manifest.browsers.find((browser) => browser.name === "chromium")?.revision;
	} catch {
		return undefined;
	}
}

export function playwrightCandidates() {
	const found = [];
	const npxRoot = join(homedir(), ".npm", "_npx");
	try {
		for (const entry of readdirSync(npxRoot)) found.push(join(npxRoot, entry, "node_modules", "playwright"));
	} catch {
		/* нет кэша npx */
	}
	found.push(join(homedir(), ".pi", "agent", "npm", "node_modules", "playwright"));
	return found.filter((dir) => existsSync(join(dir, "index.mjs")));
}

/** Версия, под которую браузер уже установлен. */
export function resolvePlaywrightDir() {
	const candidates = playwrightCandidates();
	const withBrowser = candidates.find((dir) => {
		const revision = chromiumRevision(dir);
		return revision !== undefined && existsSync(join(browsersRoot, `chromium-${revision}`));
	});
	if (withBrowser !== undefined) return withBrowser;
	if (candidates.length > 0) return candidates[0];
	throw new Error("playwright не найден: запусти `npx -y playwright@latest install chromium`");
}

/** Путь к установленному Chromium — передаём его MCP, чтобы версии не разъезжались. */
export function chromiumExecutable() {
	const dirs = existsSync(browsersRoot) ? readdirSync(browsersRoot) : [];
	const candidates = dirs
		.filter((name) => /^chromium-\d+$/.test(name))
		.sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
	for (const dir of candidates) {
		for (const relative of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
			const path = join(browsersRoot, dir, relative);
			if (existsSync(path)) return path;
		}
	}
	return undefined;
}

export async function loadPlaywright() {
	return import(pathToFileURL(join(resolvePlaywrightDir(), "index.mjs")).href);
}
