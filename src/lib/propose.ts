import {
  ACTION_ORDER,
  AGING_BUCKETS,
  PMT_CODE,
  REFUSE_PREFIX,
  WRITE_OFF_CONTAINS,
  WRITE_OFF_THRESHOLD_REASONS,
  type AgingBucketId,
} from '../config/rules';
import { hasActiveDisputeStatus, normalizeCode } from './classify';
import type {
  ActionSummary,
  ActionType,
  AgingSummary,
  ClientSummary,
  LineItem,
  Proposal,
  ProposalOptions,
} from './types';

function ageOf(row: LineItem): number {
  return row.daysInArrears ?? 0;
}

export function agingBucketId(daysInArrears: number | null): AgingBucketId {
  const d = daysInArrears ?? 0;
  for (const b of AGING_BUCKETS) {
    // [min, max) except last bucket which is [min, +∞)
    if (d >= b.min && d < b.max) return b.id;
    if (b.max === Number.POSITIVE_INFINITY && d >= b.min) return b.id;
  }
  return '0_30';
}

export function agingBucketLabel(id: string): string {
  return AGING_BUCKETS.find((b) => b.id === id)?.label ?? id;
}


function isWo(rk2: string): boolean {
  return normalizeCode(rk2).includes(WRITE_OFF_CONTAINS);
}

function isPmt(rk2: string): boolean {
  return normalizeCode(rk2) === PMT_CODE;
}

function isCom(rk2: string): boolean {
  const n = normalizeCode(rk2);
  return n.startsWith(REFUSE_PREFIX) && !n.includes(WRITE_OFF_CONTAINS);
}

/**
 * Decision tree (first match wins):
 * 1. R16                                              → AUTO_CLEAR_R16
 * 2. Key2 = PMT                                       → MATCH_OFFSET (payment / offset — not a WO)
 * 3. Key2 contains WO                                 → AUTO_CLEAR_WO
 * 4. Days in arrears < 0 AND |Amount| > threshold     → KEEP_OPEN
 * 5. Key2 = COM* (no WO)                              → PROPOSE_WRITE_OFF
 * 6. R02/R03 and |Amount| <= threshold                → PROPOSE_WRITE_OFF
 * 7. |Amount| <= threshold (other reasons)            → AUTO_CLEAR_LOW_VALUE
 * 8. R11 + age >= aging + no active dispute           → PROPOSE_CLEAR_AGED
 * 9. Age >= aging                                     → AGED_REVIEW
 * 10. else                                            → KEEP_OPEN
 */
export function decideAction(row: LineItem, options: ProposalOptions): {
  type: ActionType;
  confidence: Proposal['confidence'];
  note: string;
} {
  const rk2 = normalizeCode(row.referenceKey2);
  const age = ageOf(row);
  const rawDays = row.daysInArrears;
  const dispute = normalizeCode(row.disputeStatus) || '(none)';
  const absAmt = Math.abs(row.amount);

  if (row.reasonCode === 'R16') {
    return {
      type: 'AUTO_CLEAR_R16',
      confidence: 'high',
      note: `R16 penalty — auto clear (${row.category})`,
    };
  }

  if (isPmt(rk2)) {
    return {
      type: 'MATCH_OFFSET',
      confidence: 'high',
      note: 'RK2 = PMT — payment/offset line; clear by matching to the related deduction (not a write-off)',
    };
  }

  if (isWo(rk2)) {
    return {
      type: 'AUTO_CLEAR_WO',
      confidence: 'high',
      note: `RK2 contains WO (${row.referenceKey2 || rk2}) — clear as write-off`,
    };
  }

  // Not due yet (negative days) and above threshold → keep
  if (rawDays != null && rawDays < 0 && absAmt > options.threshold) {
    return {
      type: 'KEEP_OPEN',
      confidence: 'hold',
      note: `Days in arrears ${rawDays} (negative) and |amount| ${absAmt.toLocaleString()} > ${options.threshold.toLocaleString()} — keep open`,
    };
  }

  // Machine proposes write-off: COM / refuse-to-pay coded, not yet WO
  if (isCom(rk2)) {
    return {
      type: 'PROPOSE_WRITE_OFF',
      confidence: 'review',
      note: `RK2=${row.referenceKey2 || rk2} (COM) — machine proposes write-off`,
    };
  }

  // Machine proposes write-off: R02 / R03 under absolute threshold
  if (WRITE_OFF_THRESHOLD_REASONS.has(row.reasonCode) && absAmt <= options.threshold) {
    return {
      type: 'PROPOSE_WRITE_OFF',
      confidence: 'high',
      note: `R02/R03 |amount| ${absAmt.toLocaleString()} ≤ ${options.threshold.toLocaleString()} — machine proposes write-off`,
    };
  }

  if (absAmt <= options.threshold) {
    return {
      type: 'AUTO_CLEAR_LOW_VALUE',
      confidence: 'high',
      note: `|amount| ${absAmt.toLocaleString()} ≤ ${options.threshold.toLocaleString()} — auto clear low value`,
    };
  }

  if (
    row.reasonCode === 'R11' &&
    age >= options.agingDays &&
    !hasActiveDisputeStatus(row.disputeStatus)
  ) {
    return {
      type: 'PROPOSE_CLEAR_AGED',
      confidence: 'review',
      note: `R11 aged ${age}d (≥${options.agingDays}), dispute=${dispute}, RK2=${rk2 || '(blank)'} — propose clear aged`,
    };
  }

  if (age >= options.agingDays) {
    return {
      type: 'AGED_REVIEW',
      confidence: 'review',
      note: `Aged ${age}d (≥${options.agingDays}), dispute=${dispute}, RK2=${rk2 || '(blank)'} — review before clear`,
    };
  }

  return {
    type: 'KEEP_OPEN',
    confidence: 'hold',
    note: `Keep open — age ${age}d, |amt| ${absAmt.toLocaleString()}, RK2=${rk2 || '(blank)'}, dispute=${dispute}`,
  };
}

export function buildProposals(items: LineItem[], options: ProposalOptions): Proposal[] {
  const scoped = items.filter((r) => options.reasonCodes.includes(r.reasonCode));
  return scoped.map((row) => {
    const decision = decideAction(row, options);
    return {
      id: `act-${row.id}`,
      type: decision.type,
      reasonCode: row.reasonCode,
      division: row.division,
      businessArea: row.businessArea,
      assignment: row.assignment,
      customer: row.customer,
      customerName: row.customerName,
      amount: row.amount,
      daysInArrears: row.daysInArrears,
      category: row.category,
      referenceKey2: row.referenceKey2,
      disputeStatus: row.disputeStatus,
      itemText: row.itemText,
      journalEntry: row.journalEntry,
      confidence: decision.confidence,
      note: decision.note,
      linkedIds: [row.id],
    };
  });
}

export function headerByAction(proposals: Proposal[]): ActionSummary[] {
  const map = new Map<ActionType, ActionSummary>();
  for (const type of ACTION_ORDER) {
    map.set(type, { type, count: 0, amount: 0, byAging: {} });
  }
  for (const p of proposals) {
    const cur = map.get(p.type) ?? { type: p.type, count: 0, amount: 0, byAging: {} };
    cur.count += 1;
    cur.amount += p.amount;
    const bucket = agingBucketId(p.daysInArrears);
    const aging = cur.byAging[bucket] ?? { count: 0, amount: 0 };
    aging.count += 1;
    aging.amount += p.amount;
    cur.byAging[bucket] = aging;
    map.set(p.type, cur);
  }
  return ACTION_ORDER.map((t) => map.get(t)!).filter((s) => s.count > 0);
}

/** Header aging totals across all filtered proposals. */
export function headerByAging(proposals: Proposal[]): AgingSummary[] {
  const map = new Map<string, AgingSummary>();
  for (const b of AGING_BUCKETS) {
    map.set(b.id, { id: b.id, label: b.label, count: 0, amount: 0 });
  }
  for (const p of proposals) {
    const id = agingBucketId(p.daysInArrears);
    const cur = map.get(id)!;
    cur.count += 1;
    cur.amount += p.amount;
  }
  return AGING_BUCKETS.map((b) => map.get(b.id)!).filter((s) => s.count > 0);
}

export function summarizeByClient(proposals: Proposal[]): ClientSummary[] {
  const map = new Map<string, ClientSummary>();
  for (const p of proposals) {
    const key = p.customer || p.customerName || '(unknown)';
    let cur = map.get(key);
    if (!cur) {
      cur = {
        customer: p.customer,
        customerName: p.customerName,
        lineCount: 0,
        amount: 0,
        byAction: {},
      };
      map.set(key, cur);
    }
    cur.lineCount += 1;
    cur.amount += p.amount;
    const bucket = cur.byAction[p.type] ?? { count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += p.amount;
    cur.byAction[p.type] = bucket;
  }
  return [...map.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

export function summarize(items: LineItem[], proposals: Proposal[]) {
  return {
    lineCount: items.length,
    openAmount: items.reduce((s, r) => s + r.amount, 0),
    proposalCount: proposals.length,
    proposedAmount: proposals
      .filter((p) => p.type !== 'KEEP_OPEN' && p.type !== 'AGED_REVIEW')
      .reduce((s, p) => s + Math.abs(p.amount), 0),
    clearableCount: proposals.filter(
      (p) =>
        p.type === 'AUTO_CLEAR_R16' ||
        p.type === 'AUTO_CLEAR_WO' ||
        p.type === 'PROPOSE_WRITE_OFF' ||
        p.type === 'AUTO_CLEAR_LOW_VALUE' ||
        p.type === 'PROPOSE_CLEAR_AGED' ||
        p.type === 'MATCH_OFFSET',
    ).length,
  };
}
