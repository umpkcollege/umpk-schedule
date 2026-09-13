"""Разбор excel-таблиц расписания УМПК в плоский список занятий.

Формат исходников (одинаковый во всех пяти файлах):

    строка 1        заголовок «Расписание занятий на … уч.год»
    строка 4        имена групп; каждая группа занимает 4 столбца
    строка 5        номера подгрупп: c и c+1 — первая, c+2 и c+3 — вторая
    столбец A       «Понедельник  31.08» — объединён на все строки дня
    столбец B / C   номер пары и время
    строка пары     дисциплина (объединена) + аудитория в c+3
    следующая       преподаватель

Лист «1 неделя» — нечётные недели, «2 неделя» — чётные. Даты в шапке дня
нужны только чтобы вычислить точку отсчёта чётности; сами занятия
привязываются к дню недели и чётности, а не к конкретной дате.
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from dataclasses import dataclass, asdict
from datetime import date, timedelta

import openpyxl

from .config import (FIRST_BUILDING_SPECS, GROUP_RENAMES, ROOM_RENAMES,
                     SECOND_BUILDING_SPECS, SHEET_PREFERENCE, UNKNOWN_SPEC_BUILDING)

log = logging.getLogger(__name__)

WEEKDAYS = {
    "понедельник": 1,
    "вторник": 2,
    "среда": 3,
    "четверг": 4,
    "пятница": 5,
    "суббота": 6,
    "воскресенье": 7,
}
WEEKDAY_NAMES = {
    1: "Понедельник", 2: "Вторник", 3: "Среда", 4: "Четверг",
    5: "Пятница", 6: "Суббота", 7: "Воскресенье",
}

GROUP_BLOCK = 4                    # столбцов на одну группу
GROUP_MARKER = "Группа:"           # служебный столбец-повтор справа
TIME_RE = re.compile(r"^\s*(\d{1,2}[:.]\d{2})\s*[-–—]\s*(\d{1,2}[:.]\d{2})\s*$")
DATE_RE = re.compile(r"(\d{1,2})\.(\d{1,2})")
# «Иванов И.И.», «Иванов-Петров И.», «Иванова Мария И.И.»
TEACHER_RE = re.compile(
    r"^[А-ЯЁ][а-яё\-]+(?:\s+[А-ЯЁ][а-яё\-]+)?\s+[А-ЯЁ]\.(?:\s*[А-ЯЁ]\.)?$"
)
SUBSTITUTE_RE = re.compile(r"^\s*замена\s*[:\-]?\s*", re.IGNORECASE)
# openpyxl падает на объединениях вида «1:1» (целая строка), которые
# встречаются в некоторых файлах — вырезаем их до разбора.
BAD_MERGE_RE = re.compile(
    rb'<mergeCell ref="(?![A-Z]{1,3}\d+:[A-Z]{1,3}\d+")[^"]*"\s*/>'
)


# «2 корпус», «2кор. 110», «2 кор. ДАР2» — пометка, что занятие в другом здании.
BUILDING_MARK_RE = re.compile(r"^([12])\s*кор(?:пус)?\.?\s*", re.I)


def group_spec(group: str) -> str:
    """Специальность из названия группы: «3 ПК Б» -> «ПК»."""
    match = re.match(r"\d\s+(.+?)(?:\s+[А-Я])?$", group.strip())
    return match.group(1) if match else group.strip()


def split_place(group: str, room: str) -> tuple[int, str]:
    """Корпус и номер кабинета.

    Номера в двух корпусах совпадают, поэтому кабинет — это пара значений,
    а не одна строка. Обычно корпус берём по специальности группы; явная
    пометка вида «2 кор. 110» перевешивает — так в таблице отмечают занятия
    в чужом здании. «2 корпус» без номера оставляет кабинет пустым: здание
    известно, комната нет.
    """
    room = ROOM_RENAMES.get(room.strip(), room.strip())
    mark = BUILDING_MARK_RE.match(room)
    if mark:
        tail = room[mark.end():].strip()
        return int(mark.group(1)), ROOM_RENAMES.get(tail, tail)
    spec = group_spec(group)
    if spec in FIRST_BUILDING_SPECS:
        return 1, room
    return UNKNOWN_SPEC_BUILDING if spec not in SECOND_BUILDING_SPECS else 2, room


def building_of_group(group: str) -> int:
    """Корпус, в котором группа учится обычно."""
    return split_place(group, "")[0]


@dataclass(frozen=True)
class Lesson:
    group: str
    week: int          # 1 — нечётная неделя, 2 — чётная, 0 — каждую неделю
    weekday: int       # 1 = понедельник … 6 = суббота
    pair: int          # 0 — «Разговоры о важном», далее 1..12
    time: str
    subject: str
    teacher: str = ""
    room: str = ""
    subgroup: int | None = None
    note: str = ""     # «Замена» или текст из строки преподавателя, не похожий на ФИО
    source: str = ""
    building: int = 0  # 1 или 2; выводится из группы и пометки в клетке

    def __post_init__(self):
        # Корпус и кабинет — одно целое, и разбирать их порознь в каждом месте,
        # где создаётся занятие, значит рано или поздно забыть. Считаем здесь.
        building, room = split_place(self.group, self.room)
        object.__setattr__(self, "building", building)
        object.__setattr__(self, "room", room)

    def as_dict(self) -> dict:
        return asdict(self)


def natural_group_key(name: str) -> tuple:
    """Сортировка групп: сперва специальность, затем курс («1 БД» < «2 БД»)."""
    parts = name.split(maxsplit=1)
    if len(parts) == 2 and parts[0].isdigit():
        return (parts[1].lower(), int(parts[0]))
    return (name.lower(), 0)


def _clean(value) -> str:
    if value is None:
        return ""
    text = str(value).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def normalize_teacher(raw: str) -> tuple[str, str]:
    """Приводит содержимое строки «Преподаватель» к паре (ФИО, примечание).

    В исходных таблицах встречаются опечатки («Суфиянова А,З.»), пометки
    о заменах («замена Иванов И.И.») и случайно попавшие названия дисциплин —
    последние в поле преподавателя не показываем.
    """
    text = _clean(raw)
    if not text:
        return "", ""

    note = ""
    if SUBSTITUTE_RE.match(text):
        note = "Замена"
        text = SUBSTITUTE_RE.sub("", text)

    text = text.replace(",", ".")
    text = re.sub(r"\.\s+(?=[А-ЯЁ]\.)", ".", text)     # «Иванов И. И.» -> «Иванов И.И.»
    text = re.sub(r"\s+", " ", text).strip()
    if re.match(r"^[А-ЯЁ][а-яё\-]+(?:\s+[А-ЯЁ][а-яё\-]+)?\s+[А-ЯЁ](\.[А-ЯЁ])?$", text):
        text += "."                                    # «Иванов А.А» -> «Иванов А.А.»

    if TEACHER_RE.match(text):
        return text, note
    return "", (f"{note}. {text}".strip(". ") if note else text)


def _sanitize(data: bytes) -> io.BytesIO:
    """Переупаковывает книгу, убирая некорректные объединения ячеек."""
    source = zipfile.ZipFile(io.BytesIO(data))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as target:
        for name in source.namelist():
            payload = source.read(name)
            if name.startswith("xl/worksheets/") and name.endswith(".xml"):
                payload = BAD_MERGE_RE.sub(b"", payload)
            target.writestr(name, payload)
    buffer.seek(0)
    return buffer


def _week_of_sheet(title: str, total_sheets: int) -> int:
    """Номер недели по названию листа; 0 — если лист в книге один.

    Недели идут подряд и нумеруются с начала полугодия: «1 неделя»,
    «2 неделя», «3 неделя» и дальше. Цифру берём целиком — в семестре
    их около восемнадцати, и по одной «10 неделя» стала бы первой.
    """
    if total_sheets < 2:
        return 0
    match = re.search(r"(\d+)", title)
    return int(match.group(1)) if match else 0


def _header_row(ws) -> int | None:
    for row in range(1, 13):
        if _clean(ws.cell(row, 3).value) == GROUP_MARKER:
            return row
    return None


def _group_columns(ws, header_row: int, warnings: list[str]) -> list[tuple[int, str]]:
    """Столбцы групп: шаг 4 начиная с D, до служебного повтора «Группа:».

    Если в одном листе одинаковое имя встречается дважды (опечатка в исходнике),
    второй столбец получает суффикс, иначе занятия двух групп смешаются.
    """
    groups: list[tuple[int, str]] = []
    seen: dict[str, int] = {}
    blanks = 0
    limit = min(ws.max_column, 600)
    for column in range(4, limit + 1, GROUP_BLOCK):
        name = _clean(ws.cell(header_row, column).value)
        if name == GROUP_MARKER:
            break
        if not name:
            blanks += 1
            if blanks >= 3:
                break
            continue
        blanks = 0
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            duplicate = f"{name} ({seen[name]})"
            fixed = GROUP_RENAMES.get(duplicate)
            if fixed:
                warnings.append(
                    f"{ws.title}: группа «{name}» встречается {seen[name]} раза — "
                    f"повтор показан как «{fixed}» (исправление опечатки из config.py)."
                )
                name = fixed
            else:
                warnings.append(
                    f"{ws.title}: группа «{name}» встречается {seen[name]} раза — "
                    f"повтор показан как «{duplicate}». Похоже на опечатку в таблице."
                )
                name = duplicate
        groups.append((column, name))
    return groups


def _parse_day_date(text: str) -> date | None:
    """«Понедельник  31.08» -> дата. Год выбираем по номеру месяца."""
    match = DATE_RE.search(text)
    if not match:
        return None
    day, month = int(match.group(1)), int(match.group(2))
    today = date.today()
    # Учебный год: август–декабрь — первый календарный год, январь–июль — второй.
    if (month >= 8) == (today.month >= 8):
        year = today.year
    else:
        year = today.year - 1 if month >= 8 else today.year + 1
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _day_blocks(ws) -> list[tuple[int, int, int, date | None]]:
    """(первая строка, последняя строка, день недели, дата) для каждого дня."""
    merges = {(m.min_row, m.min_col): m.max_row for m in ws.merged_cells.ranges}
    headers: list[tuple[int, int, date | None]] = []
    for row in range(1, ws.max_row + 1):
        text = _clean(ws.cell(row, 1).value)
        if not text:
            continue
        weekday = next(
            (num for name, num in WEEKDAYS.items() if text.lower().startswith(name)),
            None,
        )
        if weekday is None:
            continue
        headers.append((row, weekday, _parse_day_date(text)))

    blocks: list[tuple[int, int, int, date | None]] = []
    for index, (row, weekday, day) in enumerate(headers):
        end = merges.get((row, 1))
        if not end or end <= row:
            end = headers[index + 1][0] - 1 if index + 1 < len(headers) else ws.max_row
        blocks.append((row, end, weekday, day))
    return blocks


def _merge_map(ws) -> dict[tuple[int, int], int]:
    return {(m.min_row, m.min_col): m.max_col for m in ws.merged_cells.ranges}


def _lesson_rows(ws, first: int, last: int) -> list[tuple[int, int, str]]:
    """Строки занятий внутри дня: (строка, номер пары, время)."""
    rows: list[tuple[int, int, str]] = []
    for row in range(first, last + 1):
        raw_time = _clean(ws.cell(row, 3).value)
        if not raw_time or raw_time.lower().startswith("обед"):
            continue
        match = TIME_RE.match(raw_time)
        if not match:
            continue
        raw_pair = _clean(ws.cell(row, 2).value)
        pair = int(raw_pair) if raw_pair.isdigit() else 0
        start, end = _time(match.group(1)), _time(match.group(2))
        rows.append((row, pair, f"{start}–{end}"))
    return rows


def _time(raw: str) -> str:
    """«8:00» -> «08:00», чтобы столбец времени был ровным."""
    hours, _, minutes = raw.replace(".", ":").partition(":")
    return f"{int(hours):02d}:{minutes}"


def _read_cell(ws, merges, row, column, group, week, weekday, pair, time,
               source, teacher_row: int | None) -> list[Lesson]:
    """Одна клетка расписания: занятие на всю группу либо две подгруппы."""
    def value(r: int | None, c: int) -> str:
        return _clean(ws.cell(r, c).value) if r else ""

    first_subject = value(row, column)
    second_subject = value(row, column + 2)

    if second_subject:
        result: list[Lesson] = []
        for subgroup, offset in ((1, 0), (2, 2)):
            subject = value(row, column + offset)
            if not subject:
                continue
            teacher, note = normalize_teacher(
                value(teacher_row, column + offset) or value(teacher_row, column)
            )
            result.append(
                Lesson(group, week, weekday, pair, time, subject, teacher,
                       value(row, column + offset + 1), subgroup, note, source)
            )
        return result

    if not first_subject:
        return []

    width = merges.get((row, column), column) - column + 1
    if width >= 3:
        # Дисциплина растянута на всю ширину группы — занятие общее.
        subgroup, room = None, value(row, column + 3)
    else:
        subgroup, room = _narrow_cell(ws, merges, row, column, teacher_row, value)

    teacher, note = normalize_teacher(value(teacher_row, column))
    return [Lesson(group, week, weekday, pair, time, first_subject,
                   teacher, room, subgroup, note, source)]


def _narrow_cell(ws, merges, row, column, teacher_row, value) -> tuple[int | None, str]:
    """Необъединённая ячейка: подгруппа это или вся группа?

    Две разные ситуации выглядят в таблице почти одинаково. Занятие только
    у первой подгруппы (у второй в эту пару свободно) и обычное занятие всей
    группы, у которого в Excel забыли объединить ячейки. Первое нельзя
    показывать всей группе: вторая подгруппа придёт на чужую практику.

    Различаем по строке преподавателя — её объединяют по фактической ширине
    занятия: две колонки (c..c+1) у подгруппы, все четыре у общего занятия.
    Когда строки преподавателя нет («Разговоры о важном»), смотрим, где стоит
    аудитория: в c+1 — половина первой подгруппы, в c+3 — вся группа.

    На таблицах колледжа признак срабатывает без осечек: из 92 необъединённых
    ячеек 90 оказались практикой первой подгруппы и 2 — общим занятием.
    """
    teacher_width = (merges.get((teacher_row, column), column) - column + 1) if teacher_row else 0
    left_room = value(row, column + 1)      # аудитория в половине первой подгруппы
    right_room = value(row, column + 3)     # аудитория общего занятия

    if teacher_width >= 3:
        return None, right_room or left_room
    if teacher_width:                        # 1-2 колонки — занятие уже группы
        return 1, left_room
    return (1, left_room) if left_room else (None, right_room)


def _sheets_to_read(workbook, warnings: list[str], source: str) -> list:
    """Оставляет по одному листу на каждую неделю.

    Если во вкладках Excel продублировали лист, рядом с «2 неделя» появляется
    «2 неделя (2)». Оба относятся к одной неделе, и если разобрать их вместе,
    каждая пара попадёт в расписание дважды. Поэтому берём ровно один лист —
    какой именно, задаёт SHEET_PREFERENCE — а про отброшенные предупреждаем:
    лишнюю вкладку нужно удалить в самой таблице.
    """
    sheets = list(workbook.worksheets)
    total = len(sheets)
    chosen: dict[int, object] = {}
    skipped: list[tuple[str, str]] = []

    for ws in sheets:
        week = _week_of_sheet(ws.title, total)
        previous = chosen.get(week)
        if previous is None:
            chosen[week] = ws
            continue
        if SHEET_PREFERENCE == "last":
            chosen[week] = ws
            skipped.append((previous.title, ws.title))
        else:
            skipped.append((ws.title, previous.title))

    for ignored, used in skipped:
        warnings.append(
            f"{source}: листы «{ignored}» и «{used}» относятся к одной неделе. "
            f"Взят «{used}», «{ignored}» пропущен — иначе пары задвоились бы. "
            f"Лишнюю вкладку стоит удалить в самой таблице."
        )

    return [ws for _, ws in sorted(chosen.items())]


@dataclass
class ParseResult:
    lessons: list[Lesson]
    groups: list[str]
    anchor: date | None
    warnings: list[str]
    # Понедельники недель, у которых в таблице проставлены даты: {дата: номер недели}.
    # Именно между ними разрешено листать — остальные недели колледж не публиковал.
    mondays: dict[date, int]


def parse_workbook(data: bytes, source: str) -> ParseResult:
    """Разбирает одну книгу: занятия, имена групп и якорный понедельник."""
    workbook = openpyxl.load_workbook(_sanitize(data), data_only=True)
    lessons: list[Lesson] = []
    group_names: list[str] = []
    warnings: list[str] = []
    anchor: date | None = None
    mondays: dict[date, int] = {}
    sheet_count = len(workbook.worksheets)

    for ws in _sheets_to_read(workbook, warnings, source):
        header_row = _header_row(ws)
        if header_row is None:
            message = f"{source} / {ws.title}: не найдена строка с названиями групп"
            log.warning(message)
            warnings.append(message)
            continue

        week = _week_of_sheet(ws.title, sheet_count)
        groups = _group_columns(ws, header_row, warnings)
        merges = _merge_map(ws)
        for _, name in groups:
            if name not in group_names:
                group_names.append(name)
            spec = group_spec(name)
            if spec not in FIRST_BUILDING_SPECS and spec not in SECOND_BUILDING_SPECS:
                message = (f"{source}: специальность «{spec}» не указана ни в одном корпусе "
                           f"(config.py) — занятия отнесены к {UNKNOWN_SPEC_BUILDING} корпусу. "
                           f"Кабинеты могут перепутаться с одноимёнными в другом здании.")
                if message not in warnings:
                    log.warning(message)
                    warnings.append(message)

        for first, last, weekday, day in _day_blocks(ws):
            if day:
                monday = day - timedelta(days=weekday - 1)
                mondays.setdefault(monday, week)
                if weekday == 1 and week in (0, 1) and (anchor is None or day < anchor):
                    anchor = day

            rows = _lesson_rows(ws, first, last)
            occupied = {row for row, _, _ in rows}
            for row, pair, time in rows:
                # Обычно под дисциплиной идёт строка преподавателя. Исключение —
                # «Разговоры о важном» в 8:00: сразу под ней начинается первая пара.
                teacher_row = row + 1 if (row + 1) not in occupied else None
                for column, group in groups:
                    lessons.extend(
                        _read_cell(ws, merges, row, column, group,
                                   week, weekday, pair, time, source, teacher_row)
                    )

    return ParseResult(lessons, group_names, anchor, warnings, mondays)
