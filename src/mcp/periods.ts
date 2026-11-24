import type { OKRPeriodType } from "../types";

/** Today's period in the given granularity, e.g. "2026-Q4". */
export function currentPeriod(
	periodType: OKRPeriodType,
	today: Date = new Date(),
): string {
	const year = today.getFullYear();
	switch (periodType) {
		case "year":
			return String(year);
		case "month":
			return `${year}-${String(today.getMonth() + 1).padStart(2, "0")}`;
		case "week": {
			const { isoYear, isoWeek } = toIsoWeek(today);
			return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
		}
		case "quarter":
		default:
			return `${year}-Q${Math.floor(today.getMonth() / 3) + 1}`;
	}
}

/** Last day of the period, matching FileParser.getDueForPeriod. */
export function periodDue(period: string, periodType: OKRPeriodType): string | null {
	const format = (date: Date) =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
			date.getDate(),
		).padStart(2, "0")}`;

	switch (periodType) {
		case "year": {
			const year = Number(period);
			return Number.isInteger(year) ? `${year}-12-31` : null;
		}
		case "quarter": {
			const [yearText, quarterText] = period.split("-Q");
			const year = Number(yearText);
			const quarter = Number(quarterText);
			if (!Number.isInteger(year) || quarter < 1 || quarter > 4) return null;
			const lastMonth = quarter * 3;
			return format(new Date(year, lastMonth, 0));
		}
		case "month": {
			const [yearText, monthText] = period.split("-");
			const year = Number(yearText);
			const month = Number(monthText);
			if (!Number.isInteger(year) || month < 1 || month > 12) return null;
			return format(new Date(year, month, 0));
		}
		case "week": {
			const [yearText, weekText] = period.split("-W");
			const year = Number(yearText);
			const week = Number(weekText);
			if (!Number.isInteger(year) || !Number.isInteger(week)) return null;
			const monday = isoWeekStart(year, week);
			if (!monday) return null;
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			return format(sunday);
		}
		default:
			return null;
	}
}

export function todayLocalDate(today: Date = new Date()): string {
	return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
		today.getDate(),
	).padStart(2, "0")}`;
}

function toIsoWeek(date: Date): { isoYear: number; isoWeek: number } {
	const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNumber = target.getUTCDay() || 7;
	target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
	const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
	const isoWeek = Math.ceil(((target.getTime() - yearStart) / 86400000 + 1) / 7);
	return { isoYear: target.getUTCFullYear(), isoWeek };
}

function isoWeekStart(year: number, week: number): Date | null {
	if (week < 1 || week > 53) return null;
	const januaryFourth = new Date(year, 0, 4);
	const januaryFourthDay = januaryFourth.getDay() || 7;
	const mondayOfWeekOne = new Date(januaryFourth);
	mondayOfWeekOne.setDate(januaryFourth.getDate() - januaryFourthDay + 1);
	const start = new Date(mondayOfWeekOne);
	start.setDate(mondayOfWeekOne.getDate() + (week - 1) * 7);
	return start;
}
