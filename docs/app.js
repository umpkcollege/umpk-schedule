/* Расписание УМПК — клиентская часть (без сборки и зависимостей) */
'use strict';

const App = {
  data: null,            // всё расписание, прочитанное из data/schedule.json
  meta: null,            // справочник для экранов: группы, преподаватели, недели
  root: document.getElementById('app'),
  weekIndex: null,       // какая из опубликованных недель открыта
  tick: null,          // перерисовка раз в минуту, чтобы «сейчас» и «прошло» не устаревали
};

// Поднимается вручную при заметных правках сайта — по нему видно,
// подхватило ли устройство новую версию. Показывается в «О расписании».
const SITE_VERSION = 'umpk-v15';

const RECENT_KEY = 'umpk.recent.v1';
const PINNED_KEY = 'umpk.pinned.v1';
const THEME_KEY = 'umpk.theme';
const MAX_RECENT = 3;
// Закреплённых обычно одна-две. Предел нужен не человеку, а чтобы список
// на главной не разросся, если по нему кто-то пройдётся подряд.
const MAX_PINNED = 12;

/* ----------------------------------------------------------- утилиты ---- */

const tpl = (id) => document.getElementById(id).content.cloneNode(true);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function isoDate(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dayLabel(date) {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

/**
 * Дата, которой помечено расписание: когда сборка последний раз забрала
 * таблицы из облака.
 * У файлов старых сборок поля updated_at нет — тогда берём дату сборки,
 * иначе подвал и главная показывали бы разные даты про одно и то же.
 */
function scheduleDate(meta) {
  if (!meta) return null;
  if (meta.updated_at) {
    const when = new Date(meta.updated_at);
    if (!Number.isNaN(when.getTime())) return when;
  }
  return meta.built_on ? new Date(meta.built_on + 'T00:00:00') : null;
}

/**
 * «сегодня в 18:27», «вчера в 09:40» или «9 сентября» — когда расписание
 * последний раз обновляли. Время в поясе устройства: в файле оно записано
 * с часовым поясом, и Date переводит само.
 */
function updatedLabel(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  const time = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const today = isoDate(new Date());
  if (isoDate(when) === today) return `сегодня в ${time}`;
  if (isoDate(when) === isoDate(addDays(new Date(), -1))) return `вчера в ${time}`;

  const sameYear = when.getFullYear() === new Date().getFullYear();
  return when.toLocaleDateString('ru-RU',
    sameYear ? { day: 'numeric', month: 'long' }
             : { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ------------------------------------------------------------- данные --- */

const DATA_URL = 'data/schedule.json';
const WEEKDAY_NAMES = {
  1: 'Понедельник', 2: 'Вторник', 3: 'Среда',
  4: 'Четверг', 5: 'Пятница', 6: 'Суббота', 7: 'Воскресенье',
};

/**
 * Читает расписание одним файлом и раскладывает по группам и преподавателям.
 * Сервер не нужен: весь семестр — около 50 КБ в сжатом виде.
 */
async function loadData() {
  const response = await fetch(DATA_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = await response.json();
  // Заголовок ставит service worker, когда сеть не ответила и файл взят из кэша.
  data.fromCache = response.headers.get('X-From-Cache') === '1';

  data.byGroup = new Map();
  data.byTeacher = new Map();
  data.byRoom = new Map();

  const put = (map, key, lesson) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(lesson);
  };

  for (const lesson of data.lessons) {
    put(data.byGroup, lesson.group, lesson);
    if (lesson.teacher) put(data.byTeacher, lesson.teacher, lesson);
    if (lesson.room) put(data.byRoom, roomKey(lesson.building, lesson.room), lesson);
  }
  return data;
}

/** 1 — нечётная неделя, 2 — чётная. Отсчёт от первого понедельника из таблиц. */
/**
 * Номер недели — из дат, проставленных в самих таблицах.
 *
 * Раньше здесь считалась чётность: недели чередовались, первая и третья
 * были одним и тем же. Колледж выкладывает их иначе — подряд, по листу
 * на неделю: «1 неделя» 31.08, «2 неделя» 07.09, «3 неделя» 14.09.
 * Чётность на третьей неделе разошлась с таблицами и называла 14 сентября
 * первой неделей.
 *
 * null — для недели, которой в таблицах ещё нет: угадать её номер нельзя,
 * и делать вид, что расписание известно, хуже, чем честно сказать.
 */
function weekNumber(date) {
  const monday = isoDate(mondayOf(date));
  const found = ((App.data && App.data.weeks) || []).find((item) => item.monday === monday);
  return found ? found.week : null;
}

const shortDate = (date) =>
  `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;

/**
 * Недели, которые колледж выложил — у них в таблицах проставлены даты.
 * Текущей недели среди них может не быть, если таблицы отстали от
 * календаря: кнопку для неё не рисуем, номер всё равно неизвестен.
 * currentWeekIndex тогда откроет последнюю выложенную.
 */
function publishedWeeks() {
  const weeks = new Map();
  for (const item of (App.data && App.data.weeks) || []) weeks.set(item.monday, item.week);

  return [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([iso, week]) => {
      const start = new Date(iso + 'T00:00:00');
      const end = addDays(start, 5);
      return {
        monday: iso,
        week,
        label: `${dayLabel(start)} — ${dayLabel(end)}`,
        short: `${shortDate(start)} — ${shortDate(end)}`,
      };
    });
}

function scheduleFor(kind, name, start, days) {
  const index = kind === 'group' ? App.data.byGroup
    : kind === 'room' ? App.data.byRoom
    : App.data.byTeacher;
  const source = index.get(name) || [];

  const onDay = (list, weekday, week) => list
    .filter((l) => l.weekday === weekday && (l.week === 0 || l.week === week))
    .sort((a, b) => a.pair - b.pair || (a.subgroup || 0) - (b.subgroup || 0));

  const result = [];
  for (let offset = 0; offset < days; offset++) {
    const day = addDays(start, offset);
    const weekday = ((day.getDay() + 6) % 7) + 1;      // 1 = понедельник
    const week = weekNumber(day);
    result.push({
      date: isoDate(day),
      weekday,
      weekday_name: WEEKDAY_NAMES[weekday],
      date_label: dayLabel(day),
      week,
      // Недели нет в таблицах — показывать нечего, и «занятий нет» тут
      // было бы неправдой: они, скорее всего, есть, просто не выложены.
      published: week !== null,
      lessons: week === null || weekday === 7 ? [] : onDay(source, weekday, week),
    });
  }
  return { kind, name, found: source.length > 0, days: result };
}

function currentWeekIndex(list) {
  const monday = isoDate(mondayOf(new Date()));
  const index = list.findIndex((item) => item.monday === monday);
  return index >= 0 ? index : list.length - 1;
}

/** Нормализация для поиска: регистр, ё, лишние пробелы. */
function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * «1 БД» -> { course: 1, speciality: 'БД' }
 * «2 ОИБАС А» -> { course: 2, speciality: 'ОИБАС' } — литера потока не влияет
 * на специальность, иначе список распался бы на «ОИБАС А», «ОИБАС Б» и т.д.
 */
function splitGroup(name) {
  const match = name.match(/^\s*(\d+)\s+(.*)$/);
  const course = match ? Number(match[1]) : 0;
  let rest = (match ? match[2] : name).trim();
  rest = rest.replace(/\s*\(\d+\)\s*$/, '');      // «3 ТИК А (2)» — дубль в исходнике
  rest = rest.replace(/\s+[А-ЯЁ]$/, '');          // литера потока: А, Б, В
  return { course, speciality: rest || name.trim() };
}

/**
 * Кабинет опознаётся парой «корпус + номер»: «204» есть и в первом здании,
 * и во втором, и это разные комнаты. Ключ храним одной строкой, чтобы он
 * ложился в те же Map и «Недавние», что группы и преподаватели.
 */
const roomKey = (building, room) => `${building}|${room}`;

function parseRoomKey(key) {
  const cut = String(key).indexOf('|');
  return { building: Number(key.slice(0, cut)), room: key.slice(cut + 1) };
}

function roomLabel(key) {
  const { building, room } = parseRoomKey(key);
  return `${room} · ${building} корпус`;
}

/** Подпись на экране: у групп и преподавателей это само название. */
const displayName = (kind, name) => (kind === 'room' ? roomLabel(name) : name);

/** Кабинеты по корпусам: сперва номера по возрастанию, потом залы. */
function compareRooms(a, b) {
  const x = parseRoomKey(a);
  const y = parseRoomKey(b);
  if (x.building !== y.building) return x.building - y.building;
  // Номером считаем только то, что целиком номер: «204», «230/1», «12а».
  // «3 этаж 7» под это не подходит и уходит к залам, а не встаёт между 2 и 4.
  const isNumber = (room) => /^[0-9]+([/][0-9]+)?[а-яё]?$/i.test(room);
  const numX = isNumber(x.room);
  const numY = isNumber(y.room);
  if (numX !== numY) return numX ? -1 : 1;
  const nx = parseInt(x.room, 10);
  const ny = parseInt(y.room, 10);
  if (numX && nx !== ny) return nx - ny;
  return x.room.localeCompare(y.room, 'ru', { numeric: true });
}

const roomList = () => (App.data ? [...App.data.byRoom.keys()].sort(compareRooms) : []);

function readRecent() {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function pushRecent(kind, name) {
  const list = readRecent().filter((item) => !(item.kind === kind && item.name === name));
  list.unshift({ kind, name });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); } catch { /* приватный режим */ }
}

function readPinned() {
  try {
    const stored = JSON.parse(localStorage.getItem(PINNED_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

const isPinned = (kind, name) =>
  readPinned().some((item) => item.kind === kind && item.name === name);

/** Переключает закрепление и возвращает новое состояние. */
function togglePinned(kind, name) {
  const rest = readPinned().filter((item) => !(item.kind === kind && item.name === name));
  const pinning = rest.length === readPinned().length;
  if (pinning) rest.unshift({ kind, name });
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(rest.slice(0, MAX_PINNED)));
  } catch { /* приватный режим */ }
  return pinning;
}

const routeFor = (kind, name) => {
  if (kind === 'room') {
    const { building, room } = parseRoomKey(name);
    return `#/r/${building}/${encodeURIComponent(room)}`;
  }
  return `#/${kind === 'group' ? 'g' : 't'}/${encodeURIComponent(name)}`;
};

/* ------------------------------------------------------------- шапка ---- */

document.getElementById('year').textContent = String(new Date().getFullYear());

/* --------------------------------------------------------------- тема --- */

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** Выбранная человеком тема или null, пока он не выбирал. */
function storedTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch { return null; }
}

/** Тема, которая сейчас на экране: свой выбор, а пока его нет — системная. */
function activeTheme() {
  return storedTheme() || (systemDark.matches ? 'dark' : 'light');
}

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice) {
    root.setAttribute('data-theme', choice);
    try { localStorage.setItem(THEME_KEY, choice); } catch { /* приватный режим */ }
  } else {
    root.removeAttribute('data-theme');
  }

  // На кнопке — та тема, в которую она переключит: так понятно, что будет.
  // У SVG нет свойства hidden, поэтому переключаем именно атрибут.
  const dark = activeTheme() === 'dark';
  const button = document.getElementById('theme-toggle');
  if (button) {
    button.querySelector('.theme-toggle__sun').toggleAttribute('hidden', !dark);
    button.querySelector('.theme-toggle__moon').toggleAttribute('hidden', dark);
    const label = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  // Цвет строки состояния в мобильных браузерах — под фон шапки.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const surface = getComputedStyle(root).getPropertyValue('--surface').trim();
    if (surface) meta.content = surface;
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest('.theme-toggle')) {
    applyTheme(activeTheme() === 'dark' ? 'light' : 'dark');
    return;
  }
  if (event.target.closest('.install')) openInstallModal();
});

// Пока человек не выбрал тему сам, идём за настройкой системы.
systemDark.addEventListener('change', () => {
  if (!storedTheme()) applyTheme(null);
});

applyTheme(storedTheme());

/* ---------------------------------------------------------- установка --- */

const INSTALL_GUIDES = {
  ios: {
    title: 'iPhone и iPad — Safari',
    items: [
      'Нажмите <b>Поделиться</b> — квадрат со стрелкой вверх внизу экрана.',
      'Пролистайте список вниз.',
      'Выберите <b>«На экран „Домой“»</b>.',
      'Нажмите <b>«Добавить»</b> в правом верхнем углу.',
    ],
  },
  android: {
    title: 'Android — Chrome',
    items: [
      'Нажмите <b>⋮</b> в правом верхнем углу браузера.',
      'Выберите <b>«Установить приложение»</b> или <b>«Добавить на главный экран»</b>.',
      'Подтвердите установку.',
    ],
  },
  desktop: {
    title: 'Компьютер — Chrome, Edge, Яндекс Браузер',
    items: [
      'Нажмите значок установки в правой части адресной строки.',
      'Или откройте меню браузера и выберите <b>«Установить „Расписание УМПК“»</b>.',
      'Ярлык появится на рабочем столе и в меню «Пуск».',
    ],
  },
};

let installPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

function detectPlatform() {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || iPadOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

const installModal = document.getElementById('install-modal');

function openInstallModal() {
  const platform = detectPlatform();
  const order = [platform, ...Object.keys(INSTALL_GUIDES).filter((key) => key !== platform)];

  const steps = document.getElementById('install-steps');
  steps.replaceChildren(...order.map((key) => {
    const guide = INSTALL_GUIDES[key];
    const block = el('div', 'step');
    block.append(el('h3', 'step__title', guide.title));
    const list = el('ol', 'step__list');
    for (const item of guide.items) {
      const li = document.createElement('li');
      li.innerHTML = item;          // строки заданы здесь же, данных снаружи нет
      list.append(li);
    }
    block.append(list);
    return block;
  }));

  const action = document.getElementById('install-now');
  action.hidden = !installPrompt;

  // Chrome и Edge разрешают установку только на localhost или по HTTPS.
  const note = document.getElementById('install-note');
  if (!window.isSecureContext && platform !== 'ios') {
    note.textContent = 'Сайт открыт по обычному http, поэтому браузер может не предложить ' +
      'установку. Ярлык на рабочий стол всё равно можно создать вручную, а для полноценной ' +
      'установки сайт нужно открыть по адресу https://';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  installModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeInstallModal() {
  installModal.hidden = true;
  document.body.style.overflow = '';
}

installModal.addEventListener('click', (event) => {
  if (event.target.hasAttribute('data-close')) closeInstallModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !installModal.hidden) closeInstallModal();
});

document.getElementById('install-now').addEventListener('click', async () => {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  closeInstallModal();
  prompt.prompt();
  await prompt.userChoice;
});

window.addEventListener('appinstalled', () => { installPrompt = null; });

/* ------------------------------------------------------------ главная --- */

function renderHome() {
  App.root.replaceChildren(tpl('tpl-home'));

  const note = document.getElementById('home-note');
  if (App.meta) {
    note.textContent = App.meta.ready
      ? (App.meta.current_week
          ? `Сейчас идёт ${App.meta.current_week}-я неделя`
          : 'Расписание на эту неделю ещё не выложили')
      : 'Расписание не загрузилось — обновите страницу.';
  }

  // Старые файлы расписания поля updated_at не содержат — тогда строки просто нет.
  const updated = document.getElementById('home-updated');
  const label = App.meta && App.meta.ready && App.meta.updated_at
    ? updatedLabel(App.meta.updated_at) : '';
  if (label) {
    updated.textContent = `Расписание обновлено ${label}`;
    updated.hidden = false;
  }

  // На главной — закреплённое. «Недавние» остались на экранах выбора:
  // там они к месту, а здесь человек хочет не последнее, а своё.
  fillRecent(document.getElementById('home-pinned'), readPinned());
}

function fillRecent(box, items) {
  if (!box || !items.length) return;
  box.querySelector('.recent__items').replaceChildren(...items.map((item) => {
    const link = el('a', null, displayName(item.kind, item.name));
    link.href = routeFor(item.kind, item.name);
    return link;
  }));
  box.hidden = false;
}

/* ------------------------------------------------------- выбор группы --- */

// Три экрана выбора устроены одинаково и отличаются только подписями,
// источником списка и тем, как он разбит на разделы.
const PICKERS = {
  group: {
    title: 'Выберите группу',
    lead: 'Начните вводить название группы или найдите её в списке ниже.',
    placeholder: 'Например: 2 ИСиП',
    items: () => (App.meta ? App.meta.groups : []),
    render: groupedBySpeciality,
  },
  teacher: {
    title: 'Выберите преподавателя',
    lead: 'Начните вводить фамилию или выберите из списка.',
    placeholder: 'Например: Иванов',
    items: () => (App.meta ? App.meta.teachers : []),
    render: groupedByLetter,
  },
  room: {
    title: 'Выберите аудиторию',
    lead: 'Начните вводить номер кабинета или найдите его в списке ниже. '
        + 'Номера в двух корпусах совпадают, поэтому они разделены по зданиям.',
    placeholder: 'Например: 204',
    items: roomList,
    render: groupedByBuilding,
  },
};

function renderPicker(kind) {
  App.root.replaceChildren(tpl('tpl-picker'));
  const picker = PICKERS[kind];
  const title = App.root.querySelector('.picker__title');
  const lead = App.root.querySelector('.picker__lead');
  const input = document.getElementById('search');
  const results = document.getElementById('results');

  title.textContent = picker.title;
  lead.textContent = picker.lead;
  input.placeholder = picker.placeholder;

  renderRecent(kind);

  const items = picker.items();

  const draw = () => {
    const query = normalize(input.value);
    // Ищем по тому, что человек видит: у кабинета это «204 · 1 корпус»,
    // а не внутренний ключ.
    const matched = query
      ? items.filter((name) => normalize(displayName(kind, name)).includes(query))
      : items;
    results.replaceChildren(
      matched.length
        ? picker.render(matched)
        : el('div', 'empty', 'Ничего не найдено. Проверьте написание.')
    );
  };

  input.addEventListener('input', draw);
  draw();
  if (window.matchMedia('(min-width: 900px)').matches) input.focus();
}

function renderRecent(kind) {
  fillRecent(document.getElementById('recent'),
             readRecent().filter((item) => item.kind === kind));
}

function section(title, names) {
  const wrap = el('div', 'result-group');
  wrap.append(el('h2', 'result-group__title', title));
  const items = el('div', 'result-group__items');
  for (const name of names) {
    const link = el('a', 'pill', name);
    link.href = routeFor('group', name);
    items.append(link);
  }
  wrap.append(items);
  return wrap;
}

function groupedBySpeciality(names) {
  const buckets = new Map();
  for (const name of names) {
    const { speciality } = splitGroup(name);
    if (!buckets.has(speciality)) buckets.set(speciality, []);
    buckets.get(speciality).push(name);
  }
  const fragment = document.createDocumentFragment();
  for (const [speciality, groups] of [...buckets].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
    groups.sort((a, b) =>
      splitGroup(a).course - splitGroup(b).course || a.localeCompare(b, 'ru', { numeric: true }));
    fragment.append(section(speciality, groups));
  }
  return fragment;
}

function groupedByBuilding(keys) {
  const buckets = new Map();
  for (const key of keys) {
    const { building } = parseRoomKey(key);
    if (!buckets.has(building)) buckets.set(building, []);
    buckets.get(building).push(key);
  }
  const fragment = document.createDocumentFragment();
  for (const [building, rooms] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const wrap = el('div', 'result-group');
    wrap.append(el('h2', 'result-group__title', `${building} корпус`));
    const items = el('div', 'result-group__items');
    for (const key of rooms) {
      // Внутри раздела корпус уже назван — на плитке только номер.
      const link = el('a', 'pill', parseRoomKey(key).room);
      link.href = routeFor('room', key);
      items.append(link);
    }
    wrap.append(items);
    fragment.append(wrap);
  }
  return fragment;
}

function groupedByLetter(names) {
  const buckets = new Map();
  for (const name of names) {
    const letter = name.charAt(0).toUpperCase();
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push(name);
  }
  const fragment = document.createDocumentFragment();
  for (const [letter, people] of [...buckets].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
    const wrap = el('div', 'result-group');
    wrap.append(el('h2', 'result-group__title', letter));
    const items = el('div', 'result-group__items');
    for (const person of people.sort((a, b) => a.localeCompare(b, 'ru'))) {
      const link = el('a', 'pill pill--wide', person);
      link.href = routeFor('teacher', person);
      items.append(link);
    }
    wrap.append(items);
    fragment.append(wrap);
  }
  return fragment;
}

/* --------------------------------------------------------- расписание --- */

const BACK_LINKS = {
  group: { href: '#/student', text: '← К списку групп' },
  teacher: { href: '#/teacher', text: '← К списку преподавателей' },
  room: { href: '#/rooms', text: '← К списку аудиторий' },
};

async function renderSchedule(kind, name) {
  App.root.replaceChildren(tpl('tpl-schedule'));
  const label = displayName(kind, name);
  App.root.querySelector('.schedule__name').textContent = label;
  const backLink = document.getElementById('back-link');
  backLink.href = BACK_LINKS[kind].href;
  backLink.textContent = BACK_LINKS[kind].text;

  pushRecent(kind, name);

  const tabs = [...App.root.querySelectorAll('.tab')];
  const weekpick = document.getElementById('weekpick');
  const days = document.getElementById('days');
  const shareButton = document.getElementById('share-btn');
  const shareText = shareButton.querySelector('.share__text');
  let shareDayData = null;
  let view = sessionStorage.getItem('umpk.view') || 'today';

  // Текста на кнопке больше нет, поэтому о ходе дела она сообщает значком
  // и подсказкой: галочка — получилось, красный контур — нет.
  const sayShare = (text, state) => {
    shareText.textContent = text;
    shareButton.title = text;
    shareButton.setAttribute('aria-label', text);
    shareButton.classList.toggle('act--busy', state === 'busy');
    shareButton.classList.toggle('act--done', state === 'done');
    shareButton.classList.toggle('act--error', state === 'error');
  };
  sayShare('Поделиться');

  shareButton.addEventListener('click', async () => {
    if (!shareDayData || shareButton.disabled) return;
    shareButton.disabled = true;
    sayShare('Готовим…', 'busy');
    try {
      const how = await shareDay(shareDayData, label, kind);
      sayShare(how === 'downloaded' ? 'Картинка сохранена' : 'Готово', 'done');
    } catch (error) {
      sayShare('Не вышло', 'error');
      console.error('Поделиться не получилось:', error);
    }
    setTimeout(() => { sayShare('Поделиться'); shareButton.disabled = false; }, 2500);
  });

  const pinButton = document.getElementById('pin-btn');
  const pinText = document.getElementById('pin-text');
  const showPinned = (pinned) => {
    const text = pinned ? 'Открепить от главной' : 'Закрепить на главной';
    pinText.textContent = text;
    pinButton.title = text;
    pinButton.setAttribute('aria-label', text);
    pinButton.setAttribute('aria-pressed', String(pinned));
    pinButton.classList.toggle('act--pinned', pinned);
  };
  showPinned(isPinned(kind, name));
  pinButton.hidden = false;
  pinButton.addEventListener('click', () => showPinned(togglePinned(kind, name)));

  const load = () => {
    const now = new Date();
    tabs.forEach((tab) => {
      if (tab.dataset.view === 'today') tab.textContent = dayLabel(now);
      if (tab.dataset.view === 'tomorrow') tab.textContent = dayLabel(addDays(now, 1));
    });
    tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === view));
    weekpick.hidden = view !== 'week';
    days.classList.toggle('days--single', view !== 'week');
    days.replaceChildren(el('div', 'loading', 'Загружаем расписание…'));

    const loadedOn = isoDate(now);
    let from = now;
    let count = 1;

    if (view === 'tomorrow') {
      from = addDays(now, 1);
    } else if (view === 'week') {
      // Выбирать можно только те недели, которые колледж выложил.
      const list = publishedWeeks();
      if (!list.length) {
        // Ни одной недели с датами — открывать нечего. Такое возможно,
        // если в таблицах не оказалось дат в шапках дней.
        weekpick.replaceChildren();
        days.replaceChildren(el('div', 'empty',
          'Расписание на эту неделю ещё не выложили.'));
        shareButton.hidden = true;
        return;
      }
      if (App.weekIndex === null) App.weekIndex = currentWeekIndex(list);
      App.weekIndex = Math.min(Math.max(App.weekIndex, 0), list.length - 1);
      from = new Date(list[App.weekIndex].monday + 'T00:00:00');
      count = 6;
      renderWeekPicker(weekpick, list, App.weekIndex, (index) => {
        App.weekIndex = index;
        load();
      });
    }

    try {
      const data = scheduleFor(kind, name, from, count);
      renderDays(days, data, view);

      // Картинкой отправляем один день: неделя вышла бы длинной простынёй,
      // которую в переписке всё равно не разглядеть.
      shareDayData = count === 1 && data.found ? data.days[0] : null;
      shareButton.hidden = !shareDayData;

      // Раз в минуту перерисовываем то же самое: меняются отметки
      // «идёт сейчас» и «пара прошла». А если страницу оставили открытой
      // до полуночи — перезапрашиваем: даты на вкладках уже другие.
      clearInterval(App.tick);
      App.tick = setInterval(() => {
        if (isoDate(new Date()) !== loadedOn) load();
        else renderDays(days, data, view);
      }, 60000);
    } catch (error) {
      clearInterval(App.tick);
      days.replaceChildren(el('div', 'empty', `Не удалось загрузить расписание: ${error.message}`));
    }
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    view = tab.dataset.view;
    if (view !== 'week') App.weekIndex = null;
    sessionStorage.setItem('umpk.view', view);
    load();
  }));

  load();
}

function renderWeekPicker(box, list, active, onPick) {
  box.replaceChildren(...list.map((item, index) => {
    const button = el('button', `weekpick__btn${index === active ? ' is-active' : ''}`);
    button.type = 'button';
    button.append(el('span', 'weekpick__name', `${item.week} неделя`));
    const dates = item.short || item.label;
    if (dates) button.append(el('span', 'weekpick__dates', dates));
    button.addEventListener('click', () => {
      if (index !== active) onPick(index);
    });
    return button;
  }));
}

function renderDays(container, data, view) {
  const todayIso = isoDate(new Date());

  if (!data.found) {
    container.replaceChildren(el('div', 'empty',
      'Для этого имени расписание не найдено. Возможно, оно ещё не опубликовано.'));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const day of data.days) {
    fragment.append(renderDay(day, day.date === todayIso, data.kind));
  }
  container.replaceChildren(fragment);

  if (view !== 'week' && data.days.some((day) => day.published)
      && !data.days.some((day) => day.lessons.length)) {
    container.append(el('div', 'empty', 'Свободный день — занятий нет.'));
  }
}

function renderDay(day, isToday, kind) {
  const card = el('article', `day${isToday ? ' day--today' : ''}`);
  const head = el('header', 'day__head');
  head.append(el('span', 'day__name', day.weekday_name));
  head.append(el('span', 'day__date',
    day.week ? `${day.date_label} · ${day.week}-я неделя` : day.date_label));
  if (isToday) head.append(el('span', 'day__today', 'сегодня'));
  card.append(head);

  if (!day.lessons.length) {
    card.append(el('div', 'day__empty',
      day.weekday === 7 ? 'Воскресенье — выходной'
        : !day.published ? 'Расписание на эту неделю ещё не выложили'
        : 'Занятий нет'));
    return card;
  }

  const nowMinutes = isToday ? currentMinutes() : -1;
  for (const lesson of day.lessons) {
    card.append(renderLesson(lesson, nowMinutes, kind));
  }
  return card;
}

function currentMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** «08:30–09:15» -> [510, 555] в минутах от полуночи. */
function lessonRange(time) {
  const match = time.match(/(\d{1,2}):(\d{2}).(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return [
    Number(match[1]) * 60 + Number(match[2]),
    Number(match[3]) * 60 + Number(match[4]),
  ];
}

/* ------------------------------------------------- картинка на день ---- */

/**
 * Рисует расписание дня картинкой, чтобы отправить в переписку.
 *
 * Рисуем сами на canvas, а не фотографируем страницу: так картинка выходит
 * одинаковой на всех устройствах и не тянет за собой стороннюю библиотеку.
 * Размер удваиваем — иначе на телефонах текст выйдет мыльным.
 */
function drawDay(day, title, kind) {
  const S = 2;                       // множитель чёткости
  const W = 720;                     // ширина картинки в «обычных» точках
  const PAD = 36;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = (size, weight = 400) =>
    `${weight} ${size}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;

  const wrap = (text, maxWidth, size, weight) => {
    ctx.font = font(size, weight);
    const words = String(text).split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const lessons = day.lessons;
  const textLeft = PAD + 96;
  const textWidth = W - textLeft - PAD;

  // Первый проход — считаем высоту, чтобы не резать содержимое.
  const rows = lessons.map((l) => {
    const subject = wrap(l.subject, textWidth, 21, 700);
    const meta = [
      kind !== 'group' && l.group,
      kind !== 'teacher' && l.teacher,
      l.room && kind !== 'room' && 'ауд. ' + l.room,
      l.subgroup && `${l.subgroup}-я подгруппа`,
    ].filter(Boolean).join('   ');
    return {
      lesson: l, subject, meta,
      height: subject.length * 27 + (meta ? 26 : 4) + 22,
    };
  });

  const headHeight = 132;
  const footHeight = 54;
  const bodyHeight = rows.length
    ? rows.reduce((sum, r) => sum + r.height, 0)
    : 70;
  const H = headHeight + bodyHeight + footHeight;

  canvas.width = W * S;
  canvas.height = H * S;
  ctx.scale(S, S);

  // Фон и шапка — всегда светлые: картинку смотрят в чужой переписке.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1a4ed0';
  ctx.fillRect(0, 0, W, 8);

  ctx.fillStyle = '#17233c';
  ctx.font = font(30, 800);
  ctx.fillText(title, PAD, 62);

  ctx.fillStyle = '#41506d';
  ctx.font = font(19);
  ctx.fillText(`${day.weekday_name}, ${day.date_label} · ${day.week}-я неделя`, PAD, 94);

  ctx.strokeStyle = '#e3e8f2';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, 114);
  ctx.lineTo(W - PAD, 114);
  ctx.stroke();

  let y = headHeight;
  if (!rows.length) {
    ctx.fillStyle = '#7b88a1';
    ctx.font = font(20);
    ctx.fillText(day.weekday === 7 ? 'Воскресенье — выходной' : 'Занятий нет', PAD, y + 20);
  }

  for (const row of rows) {
    const [start, end] = row.lesson.time.split(/[-–—]/).map((p) => p.trim());

    ctx.fillStyle = '#17233c';
    ctx.font = font(21, 700);
    ctx.fillText(start, PAD, y + 21);
    ctx.fillStyle = '#7b88a1';
    ctx.font = font(17);
    if (end) ctx.fillText(end, PAD, y + 44);

    ctx.fillStyle = '#17233c';
    ctx.font = font(21, 700);
    let ty = y + 21;
    for (const line of row.subject) {
      ctx.fillText(line, textLeft, ty);
      ty += 27;
    }

    if (row.meta) {
      ctx.fillStyle = '#41506d';
      ctx.font = font(17);
      ctx.fillText(row.meta, textLeft, ty + 2);
    }

    y += row.height;
    ctx.strokeStyle = '#eef1f7';
    ctx.beginPath();
    ctx.moveTo(PAD, y - 11);
    ctx.lineTo(W - PAD, y - 11);
    ctx.stroke();
  }

  ctx.fillStyle = '#7b88a1';
  ctx.font = font(16);
  ctx.fillText('umpksch.ru · расписание УМПК', PAD, H - 22);

  return canvas;
}

/** Отдаёт картинку в системное «Поделиться», а где его нет — просто скачивает. */
async function shareDay(day, title, kind) {
  const canvas = drawDay(day, title, kind);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('не удалось нарисовать картинку');

  const safe = `${title} ${day.date}`.replace(/[^\wа-яёА-ЯЁ\- ]+/gi, '').trim();
  const file = new File([blob], `${safe}.png`, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${title} — ${day.date_label}` });
      return 'shared';
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';   // человек закрыл окно
      // Не получилось поделиться — уходим на скачивание.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

/** Занятие идёт в чужом для группы корпусе — значит, надо предупредить. */
function awayBuilding(lesson) {
  const home = App.meta && App.meta.buildings ? App.meta.buildings[lesson.group] : null;
  return home && lesson.building && lesson.building !== home;
}


function renderLesson(lesson, nowMinutes, kind) {
  // nowMinutes < 0 — день не сегодняшний, отмечать нечего.
  const range = lessonRange(lesson.time);
  const isNow = range && nowMinutes >= range[0] && nowMinutes <= range[1];
  const isDone = range && nowMinutes >= 0 && nowMinutes > range[1];

  const row = el('div',
    `lesson${isNow ? ' lesson--now' : ''}${isDone ? ' lesson--done' : ''}`);

  const [start, end] = lesson.time.split(/[-–—]/).map((part) => part.trim());
  const slot = el('div', 'lesson__slot');
  slot.append(el('span', 'lesson__start', start));
  if (end) slot.append(el('span', 'lesson__end', end));
  if (lesson.pair) slot.append(el('span', 'lesson__pair', `${lesson.pair} урок`));
  row.append(slot);

  const body = el('div');
  body.append(el('div', 'lesson__subject', lesson.subject));

  const meta = el('div', 'lesson__meta');
  // Не повторяем то, что написано в заголовке экрана: на странице группы
  // не нужна группа, на странице преподавателя — фамилия, в кабинете — номер.
  if (kind !== 'group') meta.append(el('span', 'lesson__group', lesson.group));
  if (lesson.teacher && kind !== 'teacher') meta.append(el('span', 'lesson__teacher', lesson.teacher));
  if (lesson.room && kind !== 'room') meta.append(el('span', 'lesson__room', lesson.room));
  // Корпус пишем только когда он чужой для группы — так же, как это делают
  // в самих таблицах. Писать его у каждой пары значило бы зашумить экран
  // ради сведения, которое студент и так знает.
  if (kind !== 'room' && awayBuilding(lesson)) {
    meta.append(el('span', 'badge badge--building', `${lesson.building} корпус`));
  }
  if (lesson.subgroup) meta.append(el('span', 'badge badge--sub', `${lesson.subgroup}-я подгруппа`));
  if (lesson.note) meta.append(el('span', 'badge badge--note', lesson.note));

  if (meta.childNodes.length) body.append(meta);

  row.append(body);
  return row;
}

/* --------------------------------------------------------------- инфо --- */

/**
 * Что сайт может показать без сети. Собирается на самом устройстве: с телефона
 * иначе не понять, встал ли service worker и сохранилось ли расписание.
 */
async function offlineReport() {
  const report = {
    address: location.origin,
    secure: window.isSecureContext,
    worker: 'не поддерживается браузером',
    saved: 'нет',
    source: App.data ? (App.data.fromCache ? 'из памяти устройства' : 'из сети') : 'не загрузилось',
  };

  if (!('serviceWorker' in navigator)) return report;
  if (!window.isSecureContext) {
    // Браузеры разрешают service worker только на localhost или по https.
    report.worker = 'не может встать: соединение не защищено';
    return report;
  }

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) report.worker = 'не установлен';
  else if (!navigator.serviceWorker.controller) report.worker = 'ставится, нужна перезагрузка';
  else report.worker = 'работает';

  try {
    const names = await caches.keys();
    const hit = await caches.match(DATA_URL);
    const files = names.length ? (await (await caches.open(names[0])).keys()).length : 0;
    report.saved = hit ? `да, файлов сохранено: ${files}` : 'нет — расписание без сети не откроется';
  } catch {
    report.saved = 'проверить не удалось';
  }
  return report;
}

function renderOfflineBlock(body) {
  const block = el('div', 'info__block');
  block.append(el('h2', null, 'Работа без сети'));
  const list = el('dl');
  list.append(el('dt', null, 'Проверяем…'), el('dd', null, ''));
  block.append(list);
  body.append(block);

  offlineReport().then((report) => {
    list.replaceChildren();
    const rows = [
      ['Адрес', report.address],
      ['Защищённое соединение', report.secure ? 'да' : 'нет'],
      ['Сохранённая копия сайта', report.worker],
      ['Расписание сохранено', report.saved],
      ['Открытое расписание', report.source],
      ['Версия сайта', SITE_VERSION],
    ];
    for (const [term, value] of rows) {
      list.append(el('dt', null, term), el('dd', null, value));
    }
  });
}

function renderInfo() {
  App.root.replaceChildren(tpl('tpl-info'));
  const body = document.getElementById('info-body');
  const meta = App.meta;
  // Блок «без сети» рисуем всегда: когда расписание не загрузилось, он и нужен.
  renderOfflineBlock(body);
  if (!meta) {
    body.append(el('div', 'empty', 'Расписание не загрузилось. Обновите страницу.'));
    return;
  }

  const about = el('div', 'info__block');
  about.append(el('h2', null, 'Откуда берутся данные'));
  about.append(el('p', null,
    'Каждые полчаса GitHub Actions скачивает таблицы расписания из публичной папки облака ' +
    'колледжа, разбирает их и обновляет файл, который читает сайт. Сервер для этого не нужен.'));
  if (meta.weeks && meta.weeks.length) {
    // В файле у недели есть только понедельник и номер — подпись собираем здесь.
    const weeks = meta.weeks.map((w) => {
      const start = new Date(w.monday + 'T00:00:00');
      return `${shortDate(start)} — ${shortDate(addDays(start, 5))} (${w.week}-я)`;
    }).join(', ');
    about.append(el('p', null,
      `Листать можно по неделям, у которых в таблицах проставлены даты: ${weeks}.`));
  }
  const list = el('dl');
  const rows = [
    ['Расписание обновлено', meta.updated_at
      ? new Date(meta.updated_at).toLocaleString('ru-RU',
          { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : (meta.built_on
          ? new Date(meta.built_on + 'T00:00:00').toLocaleDateString('ru-RU') : '—')],
    ['Периодичность', 'каждые полчаса'],
    ['Групп', String(meta.groups.length)],
    ['Преподавателей', String(meta.teachers.length)],
    ['Текущая неделя', meta.current_week ? `${meta.current_week}-я` : 'не выложена'],
    ['Первая неделя семестра', meta.anchor_monday],
  ];
  for (const [term, value] of rows) {
    list.append(el('dt', null, term), el('dd', null, value));
  }
  about.append(list);
  body.append(about);

  if (meta.files && meta.files.length) {
    const files = el('div', 'info__block');
    files.append(el('h2', null, 'Файлы расписания'));
    const items = el('ul');
    for (const file of meta.files) {
      items.append(el('li', null,
        `${file.name} — ${file.groups} групп, ${file.lessons} занятий ` +
        `(изменён ${new Date(file.mtime).toLocaleString('ru-RU')})`));
    }
    files.append(items);
    body.append(files);
  }

  if (meta.warnings && meta.warnings.length) {
    const warn = el('div', 'info__block');
    warn.append(el('h2', null, 'Замечания к исходным таблицам'));
    const items = el('ul', 'warnings');
    for (const message of meta.warnings) items.append(el('li', null, message));
    warn.append(items);
    body.append(warn);
  }

}

/* ---------------------------------------------------------- маршруты ---- */

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  clearInterval(App.tick);

  if (!parts.length) return renderHome();
  switch (parts[0]) {
    case 'student': return renderPicker('group');
    case 'teacher': return renderPicker('teacher');
    case 'rooms': return renderPicker('room');
    case 'info': return renderInfo();
    case 'g': return renderSchedule('group', decodeURIComponent(parts[1] || ''));
    case 't': return renderSchedule('teacher', decodeURIComponent(parts[1] || ''));
    case 'r': return renderSchedule('room',
      roomKey(Number(parts[1]) || 1, decodeURIComponent(parts[2] || '')));
    default: return renderHome();
  }
}

function updateFooter() {
  const line = document.getElementById('footer-meta');
  if (!App.meta) { line.textContent = 'Не удалось загрузить расписание.'; return; }
  const when = scheduleDate(App.meta);
  line.textContent = when
    ? `Расписание от ${when.toLocaleDateString('ru-RU')}`
    : '';
}

/* ----------------------------------------------------------- нет сети --- */

/**
 * Полоска сверху. Поднимается, когда расписание пришло из сохранённой копии
 * или браузер сообщает, что сети нет: без неё человек не отличит вчерашнее
 * расписание от сегодняшнего и может прийти на отменённую пару.
 */
function updateOffline() {
  const bar = document.getElementById('offline');
  const show = !navigator.onLine || Boolean(App.data && App.data.fromCache);
  bar.hidden = !show;
  if (show) document.getElementById('offline-text').textContent = offlineText();
}

function offlineText() {
  if (!App.data) return 'Нет сети — расписание не загрузилось';
  const when = scheduleDate(App.meta);
  const built = when ? ` от ${when.toLocaleDateString('ru-RU')}` : '';
  // Сеть есть, а файл всё равно из кэша — значит, обновление не доехало.
  return navigator.onLine
    ? `Не удалось проверить обновления — расписание${built} из памяти устройства`
    : `Нет сети — показано сохранённое расписание${built}`;
}

/** Сеть вернулась — перечитываем файл и перерисовываем открытый экран. */
async function refresh() {
  let data;
  try {
    data = await loadData();
  } catch (error) {
    console.error('Не удалось обновить расписание:', error);
    updateOffline();
    return;
  }
  App.data = data;
  App.meta = buildMeta(data);
  updateFooter();
  updateOffline();
  await route();
}

function buildMeta(data) {
  return {
    ready: true,
    groups: data.groups,
    buildings: data.buildings || {},
    teachers: data.teachers,
    current_week: weekNumber(new Date()),
    built_on: data.built_on,
    updated_at: data.updated_at,
    anchor_monday: data.anchor_monday,
    weeks: data.weeks,
    files: data.files,
    warnings: data.warnings,
  };
}

async function start() {
  App.root.replaceChildren(el('div', 'loading', 'Загружаем расписание…'));
  try {
    App.data = await loadData();
    App.meta = buildMeta(App.data);
  } catch (error) {
    App.data = null;
    App.meta = null;
    console.error('Не удалось прочитать', DATA_URL, error);
  }
  updateFooter();
  updateOffline();
  window.addEventListener('hashchange', route);
  window.addEventListener('offline', updateOffline);
  window.addEventListener('online', refresh);
  await route();
}

// Нужен для установки сайта как приложения и для работы без сети.
// Браузеры разрешают service worker только на localhost или по HTTPS.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* не критично */ });
  });
}

start();
