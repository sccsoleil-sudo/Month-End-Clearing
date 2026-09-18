import {
  ACTUAL_SHORTAGE,
  ACTIVE_DISPUTE_STATUSES,
  DIVISIONS,
  EXCLUDED_RK2,
  PENALTY_RK2,
  PMT_CODE,
  RECOVERED_RK2,
  REFUSE_PREFIX,
  WRITE_OFF_CONTAINS,
} from '../config/rules';

export function normalizeCode(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, ' ');
}

export function divisionFor(businessArea: string): string {
  return DIVISIONS[businessArea] ?? (businessArea ? 'Unknown' : 'Unknown');
}

export function classifyShortageRk2(refKey2: string): string {
  const rk2 = normalizeCode(refKey2);
  if (rk2 === PMT_CODE) return 'PMT';
  if (EXCLUDED_RK2.has(rk2)) return 'Excluded';
  if (RECOVERED_RK2.has(rk2)) return rk2 ? 'Recovered' : 'Pending';
  if (rk2.includes(WRITE_OFF_CONTAINS)) {
    return rk2.startsWith(REFUSE_PREFIX) ? 'COM Write-Off' : 'Write-Off';
  }
  if (rk2.startsWith(REFUSE_PREFIX)) return 'Refuse to Pay';
  if (rk2 === ACTUAL_SHORTAGE) return 'Actual Shortage';
  return rk2 ? 'Unclassified' : 'Pending';
}

const BRAND_ONLY =
  /^(KER(\s+LP)?|SHU|PUREO|FAC|IT|V&R\s+MM\s+PRADA\s+VAL|YSL|LANC|UD|GA|YTTP|KH|AZZ\s*&\s*MIU|GA\s*&\s*RL|AZZ|MIU|RL)$/i;

function isBrandOnlyText(itemText: string): boolean {
  const t = itemText.trim().replace(/\s+/g, ' ');
  if (BRAND_ONLY.test(t)) return true;
  const n = t.toUpperCase();
  return (
    t.length <= 30 &&
    !/(PREP|RECEIV|FEE|FINE|PO|ISSUE|ACCUR|DELIV|COMPLI|TAX|TOLERANCE)/.test(n)
  );
}

export function classifyPenalty(refKey2: string, itemText: string, assignment: string): string {
  const rk2 = normalizeCode(refKey2);
  if (rk2 === PMT_CODE) return 'PMT';
  if (EXCLUDED_RK2.has(rk2)) return 'Excluded';
  if (PENALTY_RK2[rk2]) return PENALTY_RK2[rk2];
  if (rk2.includes(WRITE_OFF_CONTAINS)) {
    return rk2.startsWith(REFUSE_PREFIX) ? 'COM Write-Off' : 'Write-Off';
  }
  if (rk2.startsWith(REFUSE_PREFIX)) return 'Refuse to Pay';
  if (RECOVERED_RK2.has(rk2) && rk2 !== '') return 'Recovered';

  const text = itemText.toUpperCase().replace(/\s+/g, ' ');
  if (/TAX\s*GREATER|TOLERANCE|ZERO\s*DOLLAR\s*TAX/.test(text)) return 'EDI';
  if (/RECEIVING\s*ACCURACY/.test(text)) return 'DC Charges';
  if (/PREP\s*-\s*BAGGING|BAGGING|CAP\s*SEAL|BUBBLE\s*WRAP|\bPREP\b/.test(text)) {
    return 'DC Charges';
  }
  if (/LATENESS|LATE\s*FEE|LATE\s*FEES|LATE\s*DELIVERY|BOOKING\s*-?\s*LATE|FRAIS\s*DE\s*RETARD/.test(text)) {
    return 'Delivery';
  }
  if (/NON[-\s]?COMPLIANCE|NON[-\s]?PERF|REPLEN\s*COMP/.test(text)) return 'DC Charges';
  if (/FULL\s*DELIVERY/.test(text)) return 'Delivery';
  if (/^\d{7,}\s*-\s*PO\s+\d+/.test(text)) return 'EDI';
  if (/FILL\s*RATE|RILL\s*RATE/.test(text)) return 'Fill Rate';

  if (isBrandOnlyText(itemText)) {
    if (assignment.toUpperCase().includes('FR')) return 'Fill Rate';
    return 'Unclassified / brand-only';
  }

  return rk2 ? 'Unclassified' : 'Unclassified';
}

export function classifyRow(
  reasonCode: string,
  refKey2: string,
  itemText: string,
  assignment: string,
): string {
  if (reasonCode === 'R16') return classifyPenalty(refKey2, itemText, assignment);
  if (reasonCode === 'R02' || reasonCode === 'R03' || reasonCode === 'R11') {
    return classifyShortageRk2(refKey2);
  }
  return 'Out of scope';
}

/** True when dispute is still being worked — blocks R11 aged auto-clear. */
export function hasActiveDisputeStatus(disputeStatus: string): boolean {
  const s = normalizeCode(disputeStatus);
  if (!s) return false;
  if (s === 'CLOSED') return false;
  return ACTIVE_DISPUTE_STATUSES.has(s);
}
