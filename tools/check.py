"""Диагностика разбора таблиц расписания.

    python tools/check.py             # по файлам из data/raw
    python tools/check.py --download  # предварительно скачав из облака

Печатает, сколько групп и занятий нашлось в каждом файле, и подсвечивает
подозрительные места: пустые группы, дни без пар, странные ФИО. Полезно
прогонять, когда в колледже изменили формат таблиц.
"""
from __future__ import annotations

import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.stdout.reconfigure(encoding="utf-8")

from app import cloud                                  # noqa: E402
from app.config import RAW_DIR                         # noqa: E402
from app.parser import WEEKDAY_NAMES, building_of_group, parse_workbook   # noqa: E402


def collect() -> list[tuple[str, bytes]]:
    if "--download" in sys.argv:
        print("Скачиваем файлы из облака…\n")
        return [(meta.name, data) for meta, data in cloud.download_schedule_files()]
    files = sorted(RAW_DIR.glob("*.xlsx"))
    if not files:
        sys.exit(f"В {RAW_DIR} нет ни одного .xlsx — запустите с --download")
    return [(path.name, path.read_bytes()) for path in files]


def main() -> int:
    lessons = []
    problems: list[str] = []
    mondays: dict = {}
    # Имена групп из шапок таблиц. Держим отдельно от занятий: только так
    # видно группу, у которой столбец есть, а пар не разобралось ни одной.
    declared: set[str] = set()

    for name, data in collect():
        try:
            result = parse_workbook(data, name)
        except Exception as error:
            problems.append(f"{name}: разбор не удался — {error}")
            print(f"{name:<38} ОШИБКА: {error}")
            continue

        lessons.extend(result.lessons)
        declared.update(result.groups)
        mondays.update(result.mondays)
        # Часть предупреждений уже начинается с имени файла — не повторяем его.
        problems.extend(w if w.startswith(name) else f"{name}: {w}"
                        for w in result.warnings)
        print(f"{name:<38} групп {len(result.groups):>3} · "
              f"занятий {len(result.lessons):>5} · отсчёт чётности {result.anchor}")
        if not result.lessons:
            problems.append(f"{name}: не найдено ни одного занятия")

    if not lessons:
        print("\nНи одного занятия не разобрано — формат таблиц изменился.")
        return 1

    groups = sorted({l.group for l in lessons})
    teachers = sorted({name for lesson in lessons for name in lesson.teachers})
    print(f"\nИтого: {len(lessons)} занятий, {len(groups)} групп, "
          f"{len(teachers)} преподавателей")

    per_weekday = collections.Counter(l.weekday for l in lessons)
    print("\nПо дням недели:")
    for weekday in sorted(per_weekday):
        print(f"  {WEEKDAY_NAMES[weekday]:<13} {per_weekday[weekday]:>5}")

    per_week = collections.Counter(l.week for l in lessons)
    print("\nПо чётности:", ", ".join(
        f"{'каждую неделю' if w == 0 else f'{w}-я неделя'}: {n}"
        for w, n in sorted(per_week.items())))

    # Именно по этим неделям сайт разрешает листать: у них в таблицах стоят даты.
    print("\nОпубликованные недели (по датам в таблицах):")
    if mondays:
        for monday, week in sorted(mondays.items()):
            print(f"  {monday} — {week}-я неделя")
    else:
        print("  дат в шапках дней нет — сайт покажет только текущую неделю")
        problems.append("ни в одном файле не проставлены даты дней")

    empty = sorted(declared - set(groups))
    if empty:
        problems.append(
            f"столбец в таблице есть, а занятий не нашлось: {', '.join(empty)}")

    per_group = collections.Counter(l.group for l in lessons)
    thin = [g for g in groups if per_group[g] < 10]
    if thin:
        problems.append(f"подозрительно мало занятий у групп: {', '.join(thin)}")

    notes = collections.Counter(l.note for l in lessons if l.note)
    if notes:
        print("\nПометки в строке преподавателя:")
        for text, count in notes.most_common(10):
            print(f"  {count:>4} × {text}")

    # «2 корпус» без номера — это не пропуск: здание известно, комната нет.
    # Считать их вместе с настоящими пропусками значит прятать и те, и другие.
    no_room = [l for l in lessons if not l.room]
    # Корпус отличается от домашнего только когда в клетке стояла явная
    # пометка «2 корпус» — по ней и отличаем «здание известно, комнаты нет»
    # от честного пропуска аудитории.
    only_building = sum(1 for l in no_room if l.building != building_of_group(l.group))
    print("")
    print(f"Без аудитории: {len(no_room)} из {len(lessons)}"
          + (f" (из них {only_building} — «2 корпус» без номера комнаты)"
             if only_building else ""))
    print(f"Без преподавателя: {sum(1 for l in lessons if not l.teachers and l.pair)} "
          f"(не считая классных часов)")

    if problems:
        print("\nТребует внимания:")
        for problem in problems:
            print(f"  • {problem}")
    else:
        print("\nЗамечаний нет.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
