import * as XLSX from 'xlsx';
import { REASON_CODES } from '../config/rules';
import { classifyRow, divisionFor, normalizeCode } from './classify';
import type { LineItem } from './types';

const SCOPE = new Set<string>([
  REASON_CODES.shortage,
  REASON_CODES.priceDiff,
  REASON_CODES.other,
  REASON_CODES.penalty,
]);

function cell(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in row && row[name] != null && String(row[name]).trim() !== '') {
      return row[name];
    }
  }
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]),
  );
  for (const name of names) {
    const v = lower[name.toLowerCase()];
    if (v != null && String(v).trim() !== '') return v;
  }
  return '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function toDateStr(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const m = String(parsed.m).padStart(2, '0');
      const d = String(parsed.d).padStart(2, '0');
      return `${parsed.y}-${m}-${d}`;
    }
  }
  return String(value ?? '').trim();
}

export function parseWorkbook(buffer: ArrayBuffer): LineItem[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const items: LineItem[] = [];
  let seq = 0;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: '',
      raw: true,
    });
    if (!rows.length) continue;
    const keys = Object.keys(rows[0]).map((k) => k.toLowerCase());
    if (!keys.some((k) => k.includes('reason')) || !keys.some((k) => k.includes('amount'))) {
      continue;
    }

    for (const row of rows) {
      const reasonCode = normalizeCode(cell(row, 'Reason Code'));
      if (!SCOPE.has(reasonCode)) continue;

      const businessArea = normalizeCode(cell(row, 'Business Area'));
      const assignment = String(cell(row, 'Assignment') ?? '').trim();
      const itemText = String(cell(row, 'Item Text') ?? '').trim();
      const referenceKey2 = String(cell(row, 'Reference Key 2') ?? '').trim();
      const amount = toNumber(cell(row, 'Amount (CoCode Crcy)', 'Amount'));
      const daysRaw = cell(row, 'Days in Arrears');
      const daysInArrears =
        daysRaw === '' || daysRaw == null ? null : toNumber(daysRaw);
      const disputeStatus = String(cell(row, 'Dispute Status') ?? '').trim();

      seq += 1;
      items.push({
        id: `${sheetName}-${seq}`,
        customerName: String(cell(row, 'Customer Name') ?? '').trim(),
        customer: String(cell(row, 'Customer') ?? '').trim(),
        assignment,
        reference: String(cell(row, 'Reference') ?? '').trim(),
        daysInArrears,
        journalEntryDate: toDateStr(cell(row, 'Journal Entry Date')),
        businessArea,
        division: divisionFor(businessArea),
        amount,
        reasonCode,
        referenceKey2,
        itemText,
        journalEntry: String(cell(row, 'Journal Entry') ?? '').trim(),
        baselineDate: toDateStr(cell(row, 'Baseline Date')),
        disputeId: String(cell(row, 'Dispute ID') ?? '').trim(),
        disputeStatus,
        category: classifyRow(reasonCode, referenceKey2, itemText, assignment),
      });
    }
  }

  return items;
}
