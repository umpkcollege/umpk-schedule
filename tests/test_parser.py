from io import BytesIO
from unittest import TestCase

from openpyxl import Workbook

from app.parser import normalize_teachers, parse_workbook


class ScheduleParserTest(TestCase):
    def test_reads_numbered_lessons_in_both_layouts(self):
        for with_time, marker in ((True, "№"), (False, "Группа:"), (False, "№")):
            with self.subTest(with_time=with_time, marker=marker):
                book = Workbook()
                sheet = book.active
                group_column = 4 if with_time else 3
                sheet["B4"] = marker
                sheet.cell(3, group_column, "Преподаватель")
                if with_time:
                    sheet["C4"] = "Группа:"
                    sheet["C6"] = "11:00–11:45"
                    sheet["C9"] = "12:25–13:10"
                sheet.cell(4, group_column, "1 ДОШ А")
                sheet["A6"] = "Понедельник 23.11"
                sheet.merge_cells("A6:A10")
                sheet["B6"] = 4
                sheet["B8"] = "Обед"
                sheet["B9"] = "5"
                for row, subject, room in ((6, "Информатика", "217"), (9, "Математика", "218")):
                    sheet.cell(row, group_column, subject)
                    sheet.merge_cells(start_row=row, end_row=row,
                                      start_column=group_column, end_column=group_column + 2)
                    sheet.cell(row, group_column + 3, room)
                sheet.cell(7, group_column, "Кирикова В.Ю.   Каикбердина Т.М.")
                sheet.cell(10, group_column, "замена Изарипов И.А")
                stream = BytesIO()
                book.save(stream)

                result = parse_workbook(stream.getvalue(), "schedule.xlsx")

                self.assertEqual(result.groups, ["1 ДОШ А"])
                self.assertEqual([lesson.pair for lesson in result.lessons], [4, 5])
                self.assertEqual([lesson.room for lesson in result.lessons], ["217", "218"])
                first, second = result.lessons
                self.assertEqual(first.as_dict()["teachers"], ("Кирикова В.Ю.", "Каикбердина Т.М."))
                self.assertEqual(first.time, "11:00–11:45" if with_time else "")
                self.assertEqual(first.lunch_after, not with_time)
                self.assertEqual(second.as_dict()["teacher"], "Изарипов И.А.")
                self.assertEqual(second.note, "Замена")

    def test_teacher_names_and_notes_from_real_tables(self):
        for text, expected in (
            ("ВиноградоваО.А.", (("Виноградова О.А.",), "")),
            ("Кладова П.Ф. пз", (("Кладова П.Ф.",), "пз")),
            ("замнена Зотова Е.А.", (("Зотова Е.А.",), "Замена")),
            ("Информатика ПЗ (ПЗ)", ((), "Информатика ПЗ (ПЗ)")),
        ):
            with self.subTest(text=text):
                self.assertEqual(normalize_teachers(text), expected)

    def test_publishes_week_ranges_and_ignores_the_unnumbered_template(self):
        book = Workbook()
        book.remove(book.active)
        for title, subject in (
            ("1 неделя - 10 неделя", "Информатика"),
            ("11 - 12 недели", "Математика"),
            ("неделя", "Шаблон"),
        ):
            sheet = book.create_sheet(title)
            sheet["C4"] = "Группа:"
            sheet["D4"] = "1 П"
            sheet["A6"] = "Понедельник"
            sheet["B6"] = 1
            sheet["C6"] = "08:30–09:15"
            sheet["D6"] = subject
        stream = BytesIO()
        book.save(stream)

        result = parse_workbook(stream.getvalue(), "schedule.xlsx")

        self.assertEqual(
            [(lesson.week, lesson.subject) for lesson in result.lessons],
            [(week, "Информатика" if week <= 10 else "Математика") for week in range(1, 13)],
        )
