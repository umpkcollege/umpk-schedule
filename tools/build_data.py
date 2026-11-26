"""Собирает файл расписания для статического сайта.

    python tools/build_data.py

Скачивает таблицы из облака, разбирает их и кладёт результат в
`docs/data/schedule.json` — именно этот файл читает сайт на GitHub Pages.
Сервер для работы сайта не нужен: весь семестр весит около 50 КБ в сжатом
виде, и браузер забирает его одним запросом.

Файл переписывается на каждом запуске, даже если в расписании ничего
не поменялось: так на главной всегда видно, когда сайт последний раз
ходил в облако.

Этот же скрипт запускает GitHub Actions каждые полчаса
(.github/workflows/update.yml). Код возврата 0 — файл собран, 1 — что-то
пошло не так и старый файл не тронут.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app import cloud                                              # noqa: E402
from app.config import DEFAULT_ANCHOR, RAW_DIR, SITE_DATA_FILE     # noqa: E402
from app.parser import building_of_group, natural_group_key, parse_workbook           # noqa: E402


def collect() -> dict:
    """Скачивает и разбирает все таблицы."""
    lessons: list[dict] = []
    groups: list[str] = []
    teachers: set[str] = set()
    warnings: list[str] = []
    files: list[dict] = []
    mondays: dict[date, int] = {}
    anchor: date | None = None

    for meta, data in cloud.download_schedule_files():
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        (RAW_DIR / meta.name).write_bytes(data)
        result = parse_workbook(data, meta.name)
        if not result.lessons:
            raise RuntimeError(f"{meta.name}: не разобрано ни одного занятия")

        lessons.extend(
            {k: v for k, v in l.as_dict().items() if k != "source"}
            for l in result.lessons
        )
        groups.extend(result.groups)
        warnings.extend(result.warnings)
        teachers.update(name for lesson in result.lessons for name in lesson.teachers)
        if result.anchor and (anchor is None or result.anchor < anchor):
            anchor = result.anchor
        for monday, week in result.mondays.items():
            mondays.setdefault(monday, week)
        files.append({
            "name": meta.name,
            "mtime": meta.mtime.isoformat(),
            "lessons": len(result.lessons),
            "groups": len(result.groups),
        })
        print("  %-40s групп %2d, занятий %5d"
              % (meta.name, len(result.groups), len(result.lessons)))

    if not lessons:
        raise RuntimeError("Файлы скачаны, но ни одного занятия не разобрано")

    # Листы без времени могут использовать звонки из других книг на ту же
    # неделю и день, если во всех найденных записях указан один интервал.
    times = defaultdict(set)
    for lesson in lessons:
        if lesson["time"]:
            key = lesson["week"], lesson["weekday"], lesson["pair"]
            times[key].add(lesson["time"])
    for lesson in lessons:
        if not lesson["time"]:
            key = lesson["week"], lesson["weekday"], lesson["pair"]
            known = times.get(key, ())
            if len(known) == 1:
                lesson["time"] = next(iter(known))

    return {
        # Дата сборки, а не время: файл коммитится в репозиторий, точное
        # время правки видно в истории git.
        "built_on": date.today().isoformat(),
        # Когда сборка последний раз забрала таблицы из облака. Это время
        # сайт показывает на главной строкой «Расписание обновлено …».
        "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "anchor_monday": (anchor or DEFAULT_ANCHOR).isoformat(),
        "groups": sorted(set(groups), key=natural_group_key),
        # Домашний корпус каждой группы. Нужен сайту, чтобы отмечать занятие
        # в чужом здании — и не писать корпус там, где он и так очевиден.
        "buildings": {name: building_of_group(name) for name in sorted(set(groups))},
        "teachers": sorted(teachers),
        "weeks": [{"monday": m.isoformat(), "week": w} for m, w in sorted(mondays.items())],
        "files": files,
        "warnings": warnings,
        "lessons": lessons,
    }


def main() -> int:
    print("Скачиваем таблицы из облака…")
    try:
        payload = collect()
    except Exception as error:
        print("ОШИБКА: %s" % error)
        print("Файл сайта не тронут — останется предыдущая версия расписания.")
        return 1

    SITE_DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    SITE_DATA_FILE.write_text(text, encoding="utf-8")

    weeks = ", ".join("%s (%d-я)" % (w["monday"], w["week"]) for w in payload["weeks"])
    print("\n%s: %.0f КБ" % (SITE_DATA_FILE.name, len(text.encode()) / 1024))
    print("занятий %d, групп %d, преподавателей %d"
          % (len(payload["lessons"]), len(payload["groups"]), len(payload["teachers"])))
    print("опубликованные недели: %s" % (weeks or "нет"))
    for warning in payload["warnings"]:
        print("  замечание: %s" % warning)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
