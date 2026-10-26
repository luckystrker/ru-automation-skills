#!/usr/bin/env node
/**
 * magnit-login.mjs — вход в «Магнит» по телефону (headed Chromium под xvfb).
 *
 * Магнит требует Яндекс SmartCaptcha перед отправкой SMS; в headless она не проходится,
 * в headed (xvfb) проходит сама. Скрипт проходит капчу, жмёт «Далее», ждёт код в файле
 * /tmp/magnit-code.txt (до 15 минут), вводит его и сохраняет сессию в профиль браузера.
 *
 * Запуск:  xvfb-run -a node stores/magnit-login.mjs <телефон>
 * Код:     printf '123456' > /tmp/magnit-code.txt
 * Лог:     /tmp/magnit-login.log
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Магнит ждёт 10 цифр: маска сама подставляет +7. Если дали 11 цифр с 7/8 — отбрасываем первую.
const RAW_PHONE = (process.argv[2] ?? "").replace(/\D/g, "");
const PHONE = RAW_PHONE.length === 11 && /^[78]/.test(RAW_PHONE) ? RAW_PHONE.slice(1) : RAW_PHONE;
const CODE_FILE = process.env.MAGNIT_CODE_FILE ?? "/tmp/magnit-code.txt";
const PROFILE = process.env.MAGNIT_PROFILE ?? join(HERE, "browser-profile-magnit");
const LOG = "/tmp/magnit-login.log";
const BASE = "https://magnit.ru";

const log = (line) => {
	const text = `${new Date().toISOString()} ${line}\n`;
	appendFileSync(LOG, text);
	process.stdout.write(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCode(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(CODE_FILE)) {
			const raw = readFileSync(CODE_FILE, "utf8").replace(/\D/g, "").trim();
			if (raw.length >= 4) return raw;
		}
		await sleep(3000);
	}
	return "";
}

if (PHONE.length < 10) {
	log("нужен телефон: 10 цифр без +7");
	process.exit(2);
}

const { chromium } = await loadPlaywright();
const context = await chromium.launchPersistentContext(PROFILE, {
	headless: false,
	args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
	proxy: { server: process.env.MAGNIT_PROXY ?? "socks5://127.0.0.1:8890" },
	locale: "ru-RU",
	timezoneId: "Asia/Novosibirsk",
	viewport: { width: 1400, height: 1000 },
	userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const page = context.pages()[0] ?? (await context.newPage());

try {
	await page.goto(`${BASE}/`, { timeout: 90_000, waitUntil: "domcontentloaded" });
	await page.waitForTimeout(7000);
	for (let i = 0; i < 4; i++) {
		const skip = page.locator('button:has-text("Не сейчас"), button:has-text("Хорошо, закрыть")').first();
		if ((await skip.count()) === 0) break;
		await skip.click().catch(() => {});
		await page.waitForTimeout(1200);
	}
	log("главная открыта");

	const login = page.locator('button[aria-label="Войти"]').first();
	await login.click({ timeout: 15_000 }).catch((e) => log(`клик «Войти»: ${e.message.slice(0, 80)}`));
	await page.waitForTimeout(7000);
	const modal = page.locator("div.pl-modal").first();
	if ((await modal.count()) === 0) throw new Error("модалка входа не открылась");
	log("модалка входа открыта");

	const phone = modal.locator("input").first();
	await phone.click().catch(() => {});
	// Профиль мог сохранить прошлый номер — поле чистим целиком, иначе маска склеит значения.
	await phone.press("Control+A").catch(() => {});
	await phone.press("Backspace").catch(() => {});
	await phone.fill("").catch(() => {});
	await page.waitForTimeout(500);
	const before = await phone.inputValue().catch(() => "?");
	if (before !== "") log(`поле не очистилось: «${before}»`);
	await phone.type(PHONE, { delay: 90 });
	await page.waitForTimeout(2000);
	log(`телефон введён: ${await phone.inputValue().catch(() => "?")}`);

	// Яндекс SmartCaptcha: в headed-режиме обычно проходит сама, но иногда нужен клик по чекбоксу.
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		const next = page.getByRole("button", { name: "Далее" }).first();
		if (!(await next.isDisabled().catch(() => true))) break;
		const frame = page.frames().find((f) => /captcha-api\.yandex\.ru\/checkbox/.test(f.url()));
		if (frame !== undefined) {
			const button = frame.locator(".CheckboxCaptcha-Button").first();
			if ((await button.count()) > 0) {
				await button.click({ timeout: 8000 }).catch(() => {});
				log(`капча: клик по чекбоксу (попытка ${attempt})`);
			}
		}
		await page.waitForTimeout(6000);
	}
	const token = await page.locator('input[name="smart-token"]').first().inputValue().catch(() => "");
	log(`капча: токен ${token === "" ? "нет" : "получен"}`);

	const next = page.getByRole("button", { name: "Далее" }).first();
	if (await next.isDisabled().catch(() => true)) {
		log("кнопка «Далее» всё ещё недоступна — капча не пройдена");
		await page.screenshot({ path: "/tmp/magnit-login-stuck.png" });
		await context.close();
		process.exit(3);
	}
	await next.click({ timeout: 15_000 }).catch((e) => log(`клик «Далее»: ${e.message.slice(0, 80)}`));
	await page.waitForTimeout(8000);
	log(`после «Далее»: ${(await modal.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}`);
	await page.screenshot({ path: "/tmp/magnit-after-next.png" });

	log(`жду SMS-код в ${CODE_FILE} (до 15 минут)`);
	const code = await waitForCode(15 * 60 * 1000);
	if (code === "") {
		log("код не появился — выход");
		await context.close();
		process.exit(4);
	}
	log(`получен код из ${code.length} цифр`);

	// Поле кода: либо один input, либо несколько однозначных
	const single = page.locator("input[maxlength='1']");
	if ((await single.count()) >= 4) {
		for (let i = 0; i < code.length && i < (await single.count()); i += 1) {
			await single.nth(i).fill(code[i]).catch(() => {});
			await page.waitForTimeout(150);
		}
	} else {
		const field = page.locator('div.pl-modal input:not([type="hidden"])').last();
		await field.click().catch(() => {});
		await field.type(code, { delay: 120 }).catch((e) => log(`ввод кода: ${e.message.slice(0, 80)}`));
	}
	await page.waitForTimeout(3000);
	for (const label of ["Войти", "Подтвердить", "Далее", "Продолжить"]) {
		const button = page.getByRole("button", { name: label }).first();
		if ((await button.count()) > 0 && !(await button.isDisabled().catch(() => true))) {
			await button.click({ timeout: 8000 }).catch(() => {});
			log(`нажала «${label}»`);
			break;
		}
	}
	await page.waitForTimeout(10_000);

	const session = await page.evaluate(async () => {
		const response = await fetch("/_auth/session", { headers: { "x-magnit-bff": "1" } }).catch(() => null);
		return response ? await response.json().catch(() => null) : null;
	});
	log(`сессия: ${JSON.stringify(session)?.slice(0, 200)}`);
	await page.screenshot({ path: "/tmp/magnit-login-done.png" });
	if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);
	await context.close();
	process.exit(session?.authorized === true ? 0 : 5);
} catch (error) {
	log(`ошибка: ${error?.message ?? error}`);
	await page.screenshot({ path: "/tmp/magnit-login-error.png" }).catch(() => {});
	await context.close().catch(() => {});
	process.exit(1);
}
