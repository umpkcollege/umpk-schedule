"""Счётчик посещений и страница /admin для umpksch.ru.

Сайт раз в минуту, пока вкладка открыта, шлёт сюда POST /api/hit со
случайным номером устройства. По этим сигналам считаем:
  * сколько людей открыто прямо сейчас (сигнал был за последние ONLINE_WINDOW);
  * сколько разных устройств заходило за день и сколько из них впервые;
  * сколько было заходов (перерыв больше VISIT_GAP — новый заход);
  * пик одновременных посетителей за день и заходы по часам.

Ни IP, ни имён, ни выбранных групп не храним — только случайный номер.

Без зависимостей: стандартная библиотека Python 3.9+. Запуск на сервере —
см. server/deploy/. Для проверки на своём компьютере:

    set ADMIN_LOGIN=admin
    set ADMIN_PASSWORD=test
    python server/stats.py --static docs

и открыть http://localhost:8090/ (сайт) и http://localhost:8090/admin.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADMIN_PAGE = HERE / 'admin.html'

# Уфа круглый год живёт по UTC+5, перехода на летнее время нет — день
# в статистике начинается в полночь по Уфе, а не по Гринвичу.
TZ = timezone(timedelta(hours=5))

ONLINE_WINDOW = 150     # сек: сайт пингует раз в 60 с, запас на медленную сеть
VISIT_GAP = 30 * 60     # сек тишины, после которых заход считается новым
DAYS_SHOWN = 30
SESSION_DAYS = 30       # сколько живёт вход в админку

VISITOR_RE = re.compile(r'^[a-z0-9]{16,40}$')
MAX_BODY = 512
MAX_TRACKED = 50_000    # страховка от того, кто зальёт нас выдуманными номерами

# Перебор пароля: не больше LOGIN_TRIES ошибок с одного адреса за LOGIN_WINDOW.
LOGIN_TRIES = 10
LOGIN_WINDOW = 15 * 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
    day      TEXT PRIMARY KEY,
    visits   INTEGER NOT NULL DEFAULT 0,
    peak     INTEGER NOT NULL DEFAULT 0,
    peak_at  TEXT
);
CREATE TABLE IF NOT EXISTS day_visitors (
    day      TEXT NOT NULL,
    visitor  TEXT NOT NULL,
    PRIMARY KEY (day, visitor)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS visitors (
    visitor    TEXT PRIMARY KEY,
    first_day  TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hours (
    day      TEXT NOT NULL,
    hour     INTEGER NOT NULL,
    visits   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, hour)
) WITHOUT ROWID;
"""


class Stats:
    """Всё состояние счётчика. Методы вызываются из разных потоков."""

    def __init__(self, db_path):
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.lock = threading.Lock()
        self.last_seen = {}     # номер устройства -> время последнего сигнала
        self.seen_today = set() # уже записанные в day_visitors сегодня
        self.today = None

    def hit(self, visitor, bye=False):
        now = time.time()
        local = datetime.fromtimestamp(now, TZ)
        day = local.date().isoformat()
        with self.lock:
            if day != self.today:
                self.today = day
                self.seen_today.clear()

            previous = self.last_seen.get(visitor)
            if bye:
                # Вкладку закрыли или свернули: сразу убираем из «онлайн»,
                # но время оставляем — вернётся через минуту, это тот же заход.
                if previous is not None:
                    self.last_seen[visitor] = now - ONLINE_WINDOW
                return

            if previous is None and len(self.last_seen) >= MAX_TRACKED:
                self._forget(now)
                if len(self.last_seen) >= MAX_TRACKED:
                    return
            self.last_seen[visitor] = now

            new_visit = (
                previous is None
                or now - previous > VISIT_GAP
                or datetime.fromtimestamp(previous, TZ).date() != local.date()
            )
            with self.db:
                self.db.execute('INSERT OR IGNORE INTO days (day) VALUES (?)', (day,))
                if new_visit:
                    self.db.execute('UPDATE days SET visits = visits + 1 WHERE day = ?', (day,))
                    self.db.execute(
                        'INSERT INTO hours (day, hour, visits) VALUES (?, ?, 1) '
                        'ON CONFLICT (day, hour) DO UPDATE SET visits = visits + 1',
                        (day, local.hour))
                if visitor not in self.seen_today:
                    self.seen_today.add(visitor)
                    self.db.execute(
                        'INSERT OR IGNORE INTO day_visitors (day, visitor) VALUES (?, ?)',
                        (day, visitor))
                    self.db.execute(
                        'INSERT OR IGNORE INTO visitors (visitor, first_day) VALUES (?, ?)',
                        (visitor, day))
                online = self._online(now)
                self.db.execute(
                    'UPDATE days SET peak = ?, peak_at = ? WHERE day = ? AND peak < ?',
                    (online, local.strftime('%H:%M'), day, online))

    def _online(self, now):
        edge = now - ONLINE_WINDOW
        return sum(1 for seen in self.last_seen.values() if seen > edge)

    def _forget(self, now):
        # Больше суток тишины — заход точно закончился, помнить незачем.
        edge = now - 24 * 3600
        for visitor in [v for v, seen in self.last_seen.items() if seen < edge]:
            del self.last_seen[visitor]

    def summary(self):
        now = time.time()
        local = datetime.fromtimestamp(now, TZ)
        today = local.date()
        first = (today - timedelta(days=DAYS_SHOWN - 1)).isoformat()
        with self.lock:
            self._forget(now)
            online = self._online(now)
            rows = self.db.execute(
                """
                SELECT d.day, d.visits, d.peak, d.peak_at,
                       (SELECT COUNT(*) FROM day_visitors v WHERE v.day = d.day),
                       (SELECT COUNT(*) FROM visitors n WHERE n.first_day = d.day)
                FROM days d WHERE d.day >= ? ORDER BY d.day
                """, (first,)).fetchall()
            hours = dict(self.db.execute(
                'SELECT hour, visits FROM hours WHERE day = ?', (today.isoformat(),)))
            week_from = (today - timedelta(days=6)).isoformat()
            week = self.db.execute(
                'SELECT COUNT(DISTINCT visitor) FROM day_visitors WHERE day >= ?',
                (week_from,)).fetchone()[0]
            month = self.db.execute(
                'SELECT COUNT(DISTINCT visitor) FROM day_visitors WHERE day >= ?',
                (first,)).fetchone()[0]
            total = self.db.execute('SELECT COUNT(*) FROM visitors').fetchone()[0]
            since = self.db.execute('SELECT MIN(day) FROM days').fetchone()[0]

        by_day = {
            row[0]: {'visits': row[1], 'peak': row[2], 'peak_at': row[3],
                     'visitors': row[4], 'new': row[5]}
            for row in rows
        }
        days = []
        for offset in range(DAYS_SHOWN - 1, -1, -1):
            day = (today - timedelta(days=offset)).isoformat()
            entry = by_day.get(day) or {'visits': 0, 'peak': 0, 'peak_at': None,
                                        'visitors': 0, 'new': 0}
            days.append({'day': day, **entry})
        return {
            'now': local.isoformat(timespec='seconds'),
            'online': online,
            'days': days,
            'hours': [hours.get(h, 0) for h in range(24)],
            'week_visitors': week,
            'month_visitors': month,
            'total_visitors': total,
            'since': since,
        }


class Auth:
    """Вход в /admin по логину и паролю из ADMIN_LOGIN и ADMIN_PASSWORD.

    Репозиторий публичный, поэтому сами логин и пароль живут только
    на сервере, в /etc/umpk-stats.env.
    """

    COOKIE = 'umpk_admin'

    def __init__(self, login, password):
        self.login = login
        self.password = password
        # Сменили логин или пароль — старые входы перестают действовать.
        secret = f'umpk-admin:{login}:{password}'
        self.key = hashlib.sha256(secret.encode()).digest()
        self.failures = {}
        self.lock = threading.Lock()

    def check(self, login, password, address):
        now = time.time()
        with self.lock:
            recent = [t for t in self.failures.get(address, []) if now - t < LOGIN_WINDOW]
            self.failures[address] = recent
            if len(recent) >= LOGIN_TRIES:
                return 'blocked'
        # Обе проверки всегда, без раннего выхода: по времени ответа
        # нельзя понять, угадан ли логин.
        login_ok = hmac.compare_digest(login.encode(), self.login.encode())
        password_ok = hmac.compare_digest(password.encode(), self.password.encode())
        ok = bool(self.login and self.password) and login_ok and password_ok
        if not ok:
            with self.lock:
                self.failures.setdefault(address, []).append(now)
            time.sleep(1)
        return 'ok' if ok else 'wrong'

    def make_token(self):
        expires = str(int(time.time()) + SESSION_DAYS * 86400)
        return expires + '.' + self._sign(expires)

    def valid(self, token):
        if not (self.login and self.password) or not token or '.' not in token:
            return False
        expires, signature = token.split('.', 1)
        return (expires.isdigit() and int(expires) > time.time()
                and hmac.compare_digest(signature, self._sign(expires)))

    def _sign(self, text):
        return hmac.new(self.key, text.encode(), hashlib.sha256).hexdigest()


class Handler(SimpleHTTPRequestHandler):
    stats: Stats
    auth: Auth
    static_dir: str = None

    server_version = 'umpk-stats'
    sys_version = ''

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.static_dir or str(HERE), **kwargs)

    # --------------------------------------------------------- маршруты ---

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/admin', '/admin/'):
            return self._send_file(ADMIN_PAGE, 'text/html; charset=utf-8')
        if path == '/api/admin/stats':
            if not self._authorized():
                return self._json({'error': 'login'}, HTTPStatus.UNAUTHORIZED)
            return self._json(self.stats.summary())
        if self.static_dir and not path.startswith('/api/'):
            return super().do_GET()
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_HEAD(self):
        if self.static_dir:
            return super().do_HEAD()
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        body = self._read_json()
        if body is None:
            return self._json({'error': 'bad request'}, HTTPStatus.BAD_REQUEST)

        if path == '/api/hit':
            visitor = body.get('v')
            if isinstance(visitor, str) and VISITOR_RE.match(visitor):
                self.stats.hit(visitor, bye=body.get('bye') is True)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return

        if path == '/api/admin/login':
            login, password = body.get('login'), body.get('password')
            result = self.auth.check(
                login if isinstance(login, str) else '',
                password if isinstance(password, str) else '',
                self._client())
            if result != 'ok':
                return self._json({'error': result}, HTTPStatus.FORBIDDEN)
            return self._json({'ok': True}, cookie=self.auth.make_token())

        if path == '/api/admin/logout':
            return self._json({'ok': True}, cookie='')

        self.send_error(HTTPStatus.NOT_FOUND)

    # -------------------------------------------------------- помощники ---

    def _client(self):
        # За nginx настоящий адрес приходит в заголовке, а сами мы слушаем
        # только 127.0.0.1 — подделать его снаружи нельзя.
        return self.headers.get('X-Real-IP') or self.client_address[0]

    def _authorized(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            name, _, value = part.strip().partition('=')
            if name == Auth.COOKIE and self.auth.valid(value):
                return True
        return False

    def _read_json(self):
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def _json(self, data, status=HTTPStatus.OK, cookie=None):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        if cookie is not None:
            secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
            age = SESSION_DAYS * 86400 if cookie else 0
            self.send_header(
                'Set-Cookie',
                f'{Auth.COOKIE}={cookie}; Path=/; Max-Age={age}; HttpOnly; SameSite=Strict{secure}')
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, path, content_type):
        payload = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        self.end_headers()
        self.wfile.write(payload)

    def log_request(self, code='-', size='-'):
        # Сигналы /api/hit приходят от каждого открытого сайта раз в минуту —
        # в журнале они только мешают. Пишем лишь ошибки.
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--host', default=os.environ.get('STATS_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('STATS_PORT', 8090)))
    parser.add_argument('--db', default=os.environ.get('STATS_DB', str(HERE / 'stats.sqlite3')))
    parser.add_argument('--static', help='папка сайта — раздавать её тоже (для проверки на своём компьютере)')
    args = parser.parse_args()

    login = os.environ.get('ADMIN_LOGIN', '')
    password = os.environ.get('ADMIN_PASSWORD', '')
    if not (login and password):
        print('ВНИМАНИЕ: ADMIN_LOGIN или ADMIN_PASSWORD не заданы — войти в /admin не получится.')

    Handler.stats = Stats(args.db)
    Handler.auth = Auth(login, password)
    Handler.static_dir = str(Path(args.static).resolve()) if args.static else None

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Статистика слушает http://{args.host}:{args.port}  (база: {args.db})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
