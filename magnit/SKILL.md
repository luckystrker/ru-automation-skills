---
name: magnit
description: Магнит (magnit.ru) — заказ продуктов через внутренний API: поиск с ценами, магазины по координатам, вход по SMS, корзина и сборка заказа по списку. Используй, когда просят найти продукты в Магните, сравнить цены, собрать корзину или заказать доставку.
---

# Магнит — внутренний API и процесс заказа

> API публичный, без ключей, но с обязательными заголовками и российским прокси.
> Это внутренний API сайта: формат может измениться в любой момент. Проверялось на версии
> `x-app-version: 2026.10.21-11.6`.

## Быстрый старт

```sh
# магазины вокруг точки (координаты — центра города или адреса)
node tools/magnit.mjs stores --lat <широта> --lon <долгота> --radius 0.03

# поиск с ценами (цена в копейках → делим на 100)
node tools/magnit.mjs search "молоко 2,5%" --store <storeCode>

# категории магазина
node tools/magnit.mjs categories --store <storeCode>

# вход по SMS (только headed под xvfb; код кладётся в /tmp/magnit-code.txt)
xvfb-run -a node stores/magnit-login.mjs <10 цифр телефона без +7>

# собрать корзину по списку (нужна живая сессия)
xvfb-run -a node tools/magnit-fill.mjs --store <storeCode> --items "молоко 2,5%,хлеб ржаной,творог"
xvfb-run -a node tools/magnit-fill.mjs --store <storeCode> --list <список.json> --dry
```

## Общее

- База: `https://magnit.ru/webgate/...`
- Ходить только через российский прокси: `--proxy socks5h://127.0.0.1:8890` (curl) или
  `socks5://127.0.0.1:8890` (Playwright). Без него сайт отдаёт заглушку.
- Обязательные заголовки (без `x-magnit-bff` → `403 bff_header_required`, без `x-device-id` → 400):

```http
content-type: application/json
accept: application/json
origin: https://magnit.ru
referer: https://magnit.ru/
x-client-name: magnit
x-service: dostavka
x-magnit-bff: 1
x-new-magnit: true
x-app-version: <актуальная версия сайта>
x-device-id: <uuid устройства — см. раздел «Корзина»>
x-device-platform: Web
x-platform-version: Linux Chrome 131
user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
```

- Цены везде **в копейках** (`9299` = 92,99 ₽).
- `storeType` — строка **`dostavka`**; с `"1"` будет `422 invalid_service_pair`.

## Эндпоинты

### Город по IP
`GET /webgate/v1/cities/define?ipAddr=<ip>` → `city`, `cityFiasId`.
`GET /webgate/v1/cities/getbyfiasid?fiasId=<uuid>` → координаты, регион, таймзона.

### Магазины: по координатам (bbox)
`POST /webgate/v1/stores-facade/search/detail`

```json
{"filters":{"geo":{"typeName":"box",
  "leftTopPoint":{"latitude":<lat+>,"longitude":<lon->},
  "rightBottomPoint":{"latitude":<lat->,"longitude":<lon+>}},
  "storeTypeListV2":["MM","GM","DG","MO","ME","MC","DARKSTORE","MM_MINI","ZARYAD"]},
 "pagination":{"offset":0,"size":50},
 "sorting":{"sortBy":"SORT_BY_CITY","sortType":"SORT_TYPE_ASC"}}
```

Ответ: `data[]` — `address`, `coordinates`, `externalId.storeCode`, `storeTypeV2`,
`deliveryTypeList` (`DELIVERY_TYPE_DELIVERY|PICKUP|OFFLINE`), `timetableList`, `isActive`.

### Магазины: поиск по тексту
Тот же `/search` или `/search/detail`, но фильтр `{"query":"<город>, <улица>"}` —
сайт так ищет магазины, когда адрес вводят в панели выбора.

### Магазин по коду
`POST /webgate/v1/stores-facade/store` → `{"externalId":{"owner":"OWNER_MAGNIT","storeCode":"<code>"}}`

### Поиск товаров
`POST /webgate/v2/goods/search`

```json
{"includeAdultGoods":true,
 "pagination":{"offset":0,"limit":36},
 "sort":{"order":"desc","type":"popularity"},
 "term":"молоко 2,5%",
 "storeCode":"<code>",
 "storeType":"dostavka",
 "catalogType":"3"}
```

Ответ: `items[]` — `id` (= `goodId` для корзины), `name`, `price`, `oldPrice`, `rating`,
`weight`/`volume`, `image`. `pagination.total` — всего найдено, `correctedTerm` — исправление.

### Фильтры
`POST /webgate/v1/goods/filters` —
`{"term":"","onlyAvailable":false,"onlyDiscount":false,"filters":[],"categoryIDs":[],"storeCodes":["<code>"],"catalogType":"3","storeType":"","includeAdultGoods":true}`

### Категории
`GET /webgate/v3/categories/store/<code>?storetype=dostavka&catalogtype=3` → `{"items":[...]}`,
дерево `children[]` с `id`, `name`. ⚠ `storetype=1&catalogtype=3` даёт **422**.

### Подсказки и акции
- `GET /webgate/v2/suggestions/popular?storetype=dostavka&catalogtype=3`
- `GET /webgate/v2/promotions/categories?storeCode=<code>`

### Рекомендации
`POST /webgate/recoms/v1/recommendations` —
`{"catalogType":"3","goodsIds":[],"limit":36,"offset":0,"service":"express","stores":[{"code":"<code>","catalogType":"3","service":"express"}],"type":"empty_search"}`

### Корзина
Запросы — с `x-service: dostavka` (как сайт; `express` — отдельная корзина) и магазином в query:

```http
GET /webgate/v1/carts/lite?storeCode=<code>&storeType=dostavka
PUT /webgate/v1/carts/lite?storeCode=<code>&storeType=dostavka
    {"items":[{"goodId":"<id>","offerId":"<id>","qnty":1}]}
```

- `PUT` — **замена** содержимого корзины целиком (не добавление), отвечает `201`.
- `GET` → `{"id":"<uuid>.dostavka","items":[{"goodId","offerId","qnty"}],"totalGoodsCount":N}`.
- Корзина привязана к паре **«устройство + магазин»**: `id` = `<x-device-id>.<service>`.
  `x-device-id` надо брать **из cookie `mg_ksid`** (вид `<uuid>_N`) и передавать один и тот же,
  иначе каждый запрос создаёт новую корзину (`crypto.randomUUID()` в каждом запросе = корзина-призрак).
- **В мобильном приложении эта корзина не появится**: у приложения свой `mg_ksid`, корзина
  не в аккаунте. Собирать и оформлять нужно в одном «устройстве» — в том же профиле браузера.

### Адресная книга
`GET /webgate/customer_addresses/v1/address_book` (с сессией) →
`{"data":[{"id":"<uuid>","attributes":{"fullFormatted":"RU, … <город>, <улица>, <дом>",
"apartment","entrance","floor","latitude","longitude","isActive"}}]}`.

⚠ Из `page.evaluate` этот эндпоинт сначала отдаёт `401 invalid jwt` — перед запросом сделать
`POST /_auth/refresh`, потом читать.

## Авторизация (вход по SMS)

- `GET /_auth/session` (заголовок `x-magnit-bff: 1`) → `{"authorized":true,"userId":...}`.
- `POST /_auth/refresh` продлевает токены; `POST /_auth/signin {"magnitIdCode":"..."}` — обмен кода
  Magnit ID; `/_auth/signout`, `/_auth/cross-token`.
- Вход на сайте: модалка «Вход и регистрация» → телефон → **Яндекс SmartCaptcha** → «Далее» → SMS.
- **SmartCaptcha проходится только в headed-браузере под xvfb** (в headless кнопка «Далее» серая).
- Скрипт `stores/magnit-login.mjs`: `xvfb-run -a node stores/magnit-login.mjs <10 цифр>`
  (вводит **10 цифр без 7** — маска добавит `+7`; 11 цифр с 7 дадут лишнюю семёрку — ошибка).
  Код — в `/tmp/magnit-code.txt`, лог — `/tmp/magnit-login.log`,
  сессия — в профиле `stores/browser-profile-magnit`, повторный SMS не нужен.

## Полный процесс заказа

1. **Вход** (если сессии нет): `xvfb-run -a node stores/magnit-login.mjs <10 цифр>`,
   код приходит владельцу аккаунта → `/tmp/magnit-code.txt`.
2. **Магазин**: `node tools/magnit.mjs stores --lat … --lon …` → выбрать `storeCode`
   (проверить, что в `deliveryTypeList` есть `DELIVERY_TYPE_DELIVERY`).
3. **Список**: JSON-файл `[{"query":"молоко 2,5%","qty":1}, …]` или `--items "a,b,c"`.
   Формулировки уточнять: по «молоко» первой вылезает сгущёнка (сортировка по популярности).
4. **Подбор и проверка**: `magnit-fill.mjs … --dry` → глазами проверить, что подобралось.
5. **Корзина**: тот же скрипт без `--dry` — один `PUT` со всем списком.
6. **Проверка**: `GET carts/lite` → `totalGoodsCount`; сумма — по ценам из поиска.
7. **Оформление**: в том же браузерном профиле (адрес из адресной книги, оплата владельца).
   Агент доводит до корзины и списка, оплату не делает.

## Готовые скрипты

| Файл | Что делает |
|---|---|
| `stores/magnit-login.mjs` | вход по телефону + капча + SMS, сессия в профиль |
| `tools/magnit.mjs` | `stores` / `search` / `categories` / `product` — API без браузера |
| `tools/magnit-fill.mjs` | сборка корзины по списку: `--items`, `--list`, `--store`, `--dry`, `--json` |

## Грабли

- **Магазин в браузере не переключается**: сайт берёт его из серверного состояния (SSR/сессия),
  куки `shopCode` (значение — JSON-строка в кавычках, `%22<code>%22`) восстанавливаются,
  `stores-facade/store` на это не влияет, карта выбора магазина в headless пуста.
  **Обход: работать через API с явным `storeCode`** в query и теле запроса.
- Рядом с `shopCode` живут `x_shop_type=ME|MM` и `nmg_dt=DELIVERY_TYPE_PICKUP|DELIVERY_TYPE_DELIVERY`.
- Антибот: `magnit-id/anti-fraud/api/fl` + `idw-magnit-rux`. Вход — один запрос SMS, без ретраев.
- `x-app-version` со временем устаревает → ошибки версии; актуальное значение видно в любом живом
  запросе сайта (DevTools → Network → любой `/webgate/`).
- Не спамить: поиск отдаёт до 36 товаров, пагинация — `offset`; между запросами пауза ~300 мс.

## Соседние скиллы

- `lavka` — Яндекс Лавка (доставка 15–40 мин, цены в рублях, API через вкладку браузера).
- `yarche` — Ярче+ (Chromium, антибот QRATOR, цены в рублях).
