/* Service worker: офлайн-доступ и установка сайта как приложения.
   Работает только на localhost или по HTTPS — так устроены браузеры. */
'use strict';

const CACHE = 'umpk-v15';

// Сколько ждать сеть, прежде чем показать сохранённую копию. Нужен потому,
// что «интернета нет» и «сеть не отвечает» — разные вещи: при выключенном
// интернете, но живом wi-fi запрос не обрывается, а висит до собственного
// таймаута телефона (это минуты), и всё это время экран пустой.
const NETWORK_TIMEOUT = 5000;
const SHELL = [
  './',
  'index.html',
  'styles.css?v=15',
  'app.js?v=15',
  'manifest.webmanifest',
  // Само расписание: без него офлайн открылся бы пустой сайт.
  'data/schedule.json',
  'assets/logo.png',
  'assets/favicon.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Картинки почти не меняются — отдаём из кэша сразу.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetchAndStore(request))
    );
    return;
  }

  // Остальное — сначала сеть, кэш только как запасной вариант,
  // иначе после обновления сайта у людей осталась бы старая версия.
  event.respondWith(networkFirst(request));
});

/**
 * Ответ из сети, а если её нет, она молчит дольше NETWORK_TIMEOUT или
 * отвечает ошибкой — из сохранённой копии. Запрос при этом не отменяем:
 * дойдёт с опозданием — обновит копию к следующему разу.
 *
 * Ошибка сервера — тоже повод достать копию. GitHub Pages в момент выкладки
 * умеет отдать 404 или 5xx на живой файл; без этой проверки такой ответ
 * уходил наверх, сайт получал «404» вместо расписания и показывал ошибку —
 * при том что рядом в кэше лежала рабочая копия.
 */
function networkFirst(request) {
  const network = fetchAndStore(request).catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT, null));
  return Promise.race([network, timeout]).then(async (response) => {
    if (response && response.ok) return response;
    const saved = await fromCache(request);
    if (saved) return saved;
    // Копии нет: отдаём, что ответила сеть, а если не ответила ничего —
    // честную ошибку. Подсунуть страницу вместо data/schedule.json нельзя:
    // разбор упадёт.
    //
    // statusText только латиницей: в заголовке ответа допустим лишь
    // ISO-8859-1, и на кириллице конструктор Response бросает TypeError —
    // ровно там, где мы и так в худшем положении (нет ни сети, ни копии).
    return response || new Response('', { status: 504, statusText: 'Offline' });
  });
}

/**
 * Сохранённая копия с пометкой в заголовке: по ней сайт понимает, что
 * расписание могло устареть, и поднимает полоску «нет сети». Вместо
 * страницы, которой нет в кэше, отдаём index.html — тогда откроется любая
 * ссылка. Копии нет — возвращаем null, решение за вызывающим.
 */
async function fromCache(request) {
  const hit = await caches.match(request)
    || (request.mode === 'navigate' ? await caches.match('index.html') : null);
  if (!hit) return null;

  const headers = new Headers(hit.headers);
  headers.set('X-From-Cache', '1');
  return new Response(await hit.blob(), {
    status: hit.status,
    statusText: hit.statusText,
    headers,
  });
}

/**
 * Расписание меняется раз в час, а GitHub Pages просит держать файлы десять
 * минут — и обычный fetch эти десять минут сервер даже не спрашивает, отдавая
 * своё. Для файла расписания требуем проверку: телефон показывал бы вчерашние
 * пары, считая их свежими. Лишнего трафика нет — не изменился, придёт пустой
 * ответ 304.
 */
function freshen(request) {
  const isSchedule = new URL(request.url).pathname.endsWith('/data/schedule.json');
  if (!isSchedule || request.mode === 'navigate') return request;
  return new Request(request, { cache: 'no-cache' });
}

function fetchAndStore(request) {
  return fetch(freshen(request)).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}
