import * as XLSX from 'xlsx';
import { REASON_CODES } from '../config/rules';
import { classifyRow, divisionFor, normalizeCode } from './classify';
import type { LineItem, ParseResult } from './types';

const SCOPE = new Set<string>([
  REASON_CODES.shortage,
  REASON_CODES.priceDiff,
  REASON_CODES.other,
  REASON_CODES.penalty,
]);

function buildColMap(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headers) {
    map.set(h.toLowerCase().trim(), h);
  }
  return map;
}

/** Resolve each field to a concrete header once per sheet. */
function resolveField(colMap: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const key = colMap.get(name.toLowerCase());
    if (key) return key;
  }
  for (const name of names) {
    const needle = name.toLowerCase();
    for (const [lower, key] of colMap) {
      if (lower === needle || lower.startsWith(needle)) return key;
    }
  }
  for (const name of names) {
    const needle = name.toLowerCase();
    for (const [lower, key] of colMap) {
      if (lower.includes(needle)) return key;
    }
  }
  return null;
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

function str(row: Record<string, unknown>, key: string | null): string {
  if (!key) return '';
  const v = row[key];
  return v == null ? '' : String(v).trim();
}

/** Read sheet as objects while preserving left-to-right header order. */
function sheetToRows(sheet: XLSX.WorkSheet): {
  headers: string[];
  rows: Record<string, unknown>[];
} {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
  });
  if (!matrix.length) return { headers: [], rows: [] };

  const rawHeaders = (matrix[0] ?? []) as unknown[];
  const headers: string[] = [];
  for (let i = 0; i < rawHeaders.length; i++) {
    const h = String(rawHeaders[i] ?? '').trim();
    if (h) headers.push(h);
    else headers.push(`Column ${i + 1}`);
  }
  // Drop trailing empty placeholder columns
  while (headers.length && /^Column \d+$/.test(headers[headers.length - 1]!)) {
    headers.pop();
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = (matrix[r] ?? []) as unknown[];
    const row: Record<string, unknown> = {};
    let any = false;
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c]!;
      const v = cells[c] ?? '';
      row[h] = v;
      if (v !== '' && v != null) any = true;
    }
    if (any) rows.push(row);
  }
  return { headers, rows };
}

export function parseWorkbook(buffer: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const items: LineItem[] = [];
  let sourceColumns: string[] = [];
  let seq = 0;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const { headers, rows } = sheetToRows(sheet);
    if (!rows.length || !headers.length) continue;

    const keysLower = headers.map((k) => k.toLowerCase());
    if (!keysLower.some((k) => k.includes('reason')) || !keysLower.some((k) => k.includes('amount'))) {
      continue;
    }

    if (!sourceColumns.length) sourceColumns = [...headers];

    const colMap = buildColMap(headers);
    const cols = {
      reason: resolveField(colMap, 'Reason Code'),
      businessArea: resolveField(colMap, 'Business Area'),
      assignment: resolveField(colMap, 'Assignment'),
      itemText: resolveField(colMap, 'Item Text'),
      referenceKey2: resolveField(colMap, 'Reference Key 2'),
      amount: resolveField(colMap, 'Amount (CoCode Crcy)', 'Amount'),
      days: resolveField(colMap, 'Days in Arrears'),
      disputeStatus: resolveField(colMap, 'Dispute Status'),
      customerName: resolveField(colMap, 'Customer Name'),
      customer: resolveField(colMap, 'Customer'),
      reference: resolveField(colMap, 'Reference'),
      journalEntryDate: resolveField(colMap, 'Journal Entry Date'),
      journalEntry: resolveField(colMap, 'Journal Entry'),
      baselineDate: resolveField(colMap, 'Baseline Date'),
      disputeId: resolveField(colMap, 'Dispute ID'),
    };

    for (const row of rows) {
      const reasonCode = normalizeCode(str(row, cols.reason));
      if (!SCOPE.has(reasonCode)) continue;

      const businessArea = normalizeCode(str(row, cols.businessArea));
      const assignment = str(row, cols.assignment);
      const itemText = str(row, cols.itemText);
      const referenceKey2 = str(row, cols.referenceKey2);
      const amount = toNumber(cols.amount ? row[cols.amount] : 0);
      const daysRaw = cols.days ? row[cols.days] : '';
      const daysInArrears =
        daysRaw === '' || daysRaw == null ? null : toNumber(daysRaw);
      const disputeStatus = str(row, cols.disputeStatus);

      // Preserve original cell values in uploaded column order
      const sourceRow: Record<string, unknown> = {};
      for (const h of headers) sourceRow[h] = row[h] ?? '';

      seq += 1;
      items.push({
        id: `${sheetName}-${seq}`,
        customerName: str(row, cols.customerName),
        customer: str(row, cols.customer),
        assignment,
        reference: str(row, cols.reference),
        daysInArrears,
        journalEntryDate: toDateStr(cols.journalEntryDate ? row[cols.journalEntryDate] : ''),
        businessArea,
        division: divisionFor(businessArea),
        amount,
        reasonCode,
        referenceKey2,
        itemText,
        journalEntry: str(row, cols.journalEntry),
        baselineDate: toDateStr(cols.baselineDate ? row[cols.baselineDate] : ''),
        disputeId: str(row, cols.disputeId),
        disputeStatus,
        category: classifyRow(reasonCode, referenceKey2, itemText, assignment),
        sourceRow,
      });
    }
  }

  return { items, sourceColumns };
}
