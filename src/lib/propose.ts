import {
  ACTION_ORDER,
  AGING_BUCKETS,
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

const NET_TOLERANCE = 0.05;

function ageOf(row: LineItem): number {
  return row.daysInArrears ?? 0;
}

export function agingBucketId(daysInArrears: number | null): AgingBucketId {
  const d = daysInArrears ?? 0;
  for (const b of AGING_BUCKETS) {
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

function isCom(rk2: string): boolean {
  const n = normalizeCode(rk2);
  return n.startsWith(REFUSE_PREFIX) && !n.includes(WRITE_OFF_CONTAINS);
}

function moneyKey(n: number): string {
  return n.toFixed(2);
}

/** Same customer account + division (+ business area). */
function accountDivisionKey(row: LineItem): string {
  return `${row.customer || row.customerName}|${row.division}|${row.businessArea}`;
}

/** Same account + division + reason code (mass net-zero scope). */
function accountDivisionReasonKey(row: LineItem): string {
  return `${accountDivisionKey(row)}|${row.reasonCode}`;
}

/**
 * Decision tree for lines not consumed by matching (first match wins).
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

  if (isWo(rk2)) {
    return {
      type: 'AUTO_CLEAR_WO',
      confidence: 'high',
      note: `RK2 contains WO (${row.referenceKey2 || rk2}) — clear as write-off`,
    };
  }

  if (rawDays != null && rawDays < 0 && absAmt > options.threshold) {
    return {
      type: 'KEEP_OPEN',
      confidence: 'hold',
      note: `Days in arrears ${rawDays} (negative) and |amount| ${absAmt.toLocaleString()} > ${options.threshold.toLocaleString()} — keep open`,
    };
  }

  if (isCom(rk2)) {
    return {
      type: 'PROPOSE_WRITE_OFF',
      confidence: 'review',
      note: `RK2=${row.referenceKey2 || rk2} (COM) — machine proposes write-off`,
    };
  }

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
    note: `Keep open — age ${rawDays ?? age}d, |amt| ${absAmt.toLocaleString()}, RK2=${rk2 || '(blank)'}, dispute=${dispute}`,
  };
}

function toProposal(
  row: LineItem,
  type: ActionType,
  confidence: Proposal['confidence'],
  note: string,
  linkedIds: string[],
): Proposal {
  return {
    id: `act-${row.id}`,
    type,
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
    confidence,
    note,
    linkedIds,
  };
}

function ageDesc(a: LineItem, b: LineItem): number {
  return (b.daysInArrears ?? 0) - (a.daysInArrears ?? 0);
}

/** Index rows by absolute money key for O(1) partner lookup (buckets sorted oldest-first). */
function indexByAbsAmount(rows: LineItem[]): Map<string, LineItem[]> {
  const map = new Map<string, LineItem[]>();
  for (const row of rows) {
    const k = moneyKey(Math.abs(row.amount));
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  for (const list of map.values()) list.sort(ageDesc);
  return map;
}

function takeNextUnused(
  list: LineItem[] | undefined,
  used: Set<string>,
  pred: (r: LineItem) => boolean,
): LineItem | undefined {
  if (!list) return undefined;
  for (let i = 0; i < list.length; i++) {
    const row = list[i]!;
    if (used.has(row.id) || !pred(row)) continue;
    list.splice(i, 1);
    return row;
  }
  return undefined;
}

/** Exact opposite-amount pairs — O(n). Oldest debits first. */
function takeExactPairs(pool: LineItem[]): LineItem[][] {
  if (pool.length < 2) return [];
  const groups: LineItem[][] = [];
  const used = new Set<string>();
  const credits = pool.filter((r) => r.amount < 0);
  const byAmt = indexByAbsAmount(credits);

  const debits = pool.filter((r) => r.amount > 0).sort(ageDesc);
  for (const debit of debits) {
    if (used.has(debit.id)) continue;
    const credit = takeNextUnused(
      byAmt.get(moneyKey(debit.amount)),
      used,
      (r) => r.amount < 0,
    );
    if (!credit) continue;
    used.add(debit.id);
    used.add(credit.id);
    groups.push([debit, credit].sort(ageDesc));
  }
  return groups;
}

/**
 * Mass net-zero (not 1:1 line pairs):
 * - If the whole pool nets ~0 → clear all
 * - Else: oldest credits first; each credit consumes one or many claims until covered
 */
function takeMassNetZeroGroups(pool: LineItem[]): LineItem[][] {
  if (pool.length < 2) return [];

  const hasPos = pool.some((r) => r.amount > 0);
  const hasNeg = pool.some((r) => r.amount < 0);
  if (!hasPos || !hasNeg) return [];

  const netAll = pool.reduce((s, r) => s + r.amount, 0);
  if (Math.abs(netAll) <= NET_TOLERANCE) {
    return [[...pool].sort(ageDesc)];
  }

  const groups: LineItem[][] = [];
  const used = new Set<string>();
  const credits = pool.filter((r) => r.amount < 0).sort(ageDesc);

  for (const credit of credits) {
    if (used.has(credit.id)) continue;
    let need = Math.abs(credit.amount);
    const takenDebits: LineItem[] = [];

    const debits = pool
      .filter((r) => r.amount > 0 && !used.has(r.id))
      .sort(ageDesc);

    for (const debit of debits) {
      // Whole lines only — skip claims that would overshoot beyond tolerance
      if (debit.amount - need > NET_TOLERANCE) continue;
      takenDebits.push(debit);
      need -= debit.amount;
      if (need <= NET_TOLERANCE) break;
    }

    if (need > NET_TOLERANCE || takenDebits.length === 0) continue;

    used.add(credit.id);
    for (const d of takenDebits) used.add(d.id);
    groups.push([credit, ...takenDebits].sort(ageDesc));
  }

  return groups;
}

type MatchType = 'MATCH_ASSIGNMENT' | 'MATCH_NET_ZERO';

/**
 * 1) MATCH_ASSIGNMENT — same account + division + assignment
 * 2) MATCH_NET_ZERO — same account + division + reason code: mass clear (aged credits ↔ many claims)
 */
function buildMatchProposals(rows: LineItem[]): {
  proposals: Proposal[];
  claimed: Set<string>;
} {
  const proposals: Proposal[] = [];
  const claimed = new Set<string>();

  function claimGroup(group: LineItem[], type: MatchType, note: string) {
    const ids = group.map((r) => r.id);
    const journals = [
      ...new Set(group.map((r) => r.journalEntry).filter(Boolean)),
    ]
      .slice(0, 12)
      .join(', ');
    const confidence: Proposal['confidence'] =
      type === 'MATCH_NET_ZERO' ? 'review' : 'high';
    const net = group.reduce((s, r) => s + r.amount, 0);
    for (const row of group) {
      if (claimed.has(row.id)) continue;
      claimed.add(row.id);
      proposals.push(
        toProposal(
          row,
          type,
          confidence,
          `${note} · ${ids.length} lines · net ${net.toFixed(2)} · JE ${journals || '—'}`,
          ids,
        ),
      );
    }
  }

  // Phase 1 — MATCH_ASSIGNMENT
  const byAssignment = new Map<string, LineItem[]>();
  for (const row of rows) {
    const asn = row.assignment.trim();
    if (!asn) continue;
    const key = `${accountDivisionKey(row)}|${asn}`;
    const list = byAssignment.get(key) ?? [];
    list.push(row);
    byAssignment.set(key, list);
  }

  for (const [key, asnRows] of byAssignment) {
    const asn = key.slice(key.lastIndexOf('|') + 1);
    const open = asnRows.filter((r) => !claimed.has(r.id));
    if (open.length < 2) continue;

    for (const pair of takeExactPairs(open)) {
      const ages = pair.map((r) => r.daysInArrears ?? 0);
      claimGroup(
        pair,
        'MATCH_ASSIGNMENT',
        `Same account + division + assignment ${asn} — exact pair (oldest first, ages ${ages.join('/')}d)`,
      );
    }

    const afterPairs = open.filter((r) => !claimed.has(r.id));
    for (const group of takeMassNetZeroGroups(afterPairs)) {
      claimGroup(
        group,
        'MATCH_ASSIGNMENT',
        `Same account + division + assignment ${asn} — mass net-zero (aged credits first)`,
      );
    }
  }

  // Phase 2 — MATCH_NET_ZERO: mass clear by account + division + reason code
  const byReasonBucket = new Map<string, LineItem[]>();
  for (const row of rows) {
    if (claimed.has(row.id)) continue;
    const key = accountDivisionReasonKey(row);
    const list = byReasonBucket.get(key) ?? [];
    list.push(row);
    byReasonBucket.set(key, list);
  }

  for (const [, bucket] of byReasonBucket) {
    const open = bucket.filter((r) => !claimed.has(r.id));
    if (open.length < 2) continue;
    if (!open.some((r) => r.amount < 0) || !open.some((r) => r.amount > 0)) continue;

    const sample = open[0]!;
    for (const group of takeMassNetZeroGroups(open)) {
      const nCredits = group.filter((r) => r.amount < 0).length;
      const nClaims = group.filter((r) => r.amount > 0).length;
      claimGroup(
        group,
        'MATCH_NET_ZERO',
        `Mass clear · acct ${sample.customer || sample.customerName} · ${sample.division} · ${sample.reasonCode} · ${nCredits} credit(s) ↔ ${nClaims} claim(s) (aged first)`,
      );
    }
  }

  return { proposals, claimed };
}

export function buildProposals(items: LineItem[], options: ProposalOptions): Proposal[] {
  const scoped = items.filter((r) => options.reasonCodes.includes(r.reasonCode));
  const { proposals: matched, claimed } = buildMatchProposals(scoped);

  const rest = scoped
    .filter((row) => !claimed.has(row.id))
    .map((row) => {
      const decision = decideAction(row, options);
      return toProposal(row, decision.type, decision.confidence, decision.note, [row.id]);
    });

  const byOldest = (a: Proposal, b: Proposal) =>
    (b.daysInArrears ?? 0) - (a.daysInArrears ?? 0);

  return [...matched.sort(byOldest), ...rest.sort(byOldest)];
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
        p.type === 'MATCH_ASSIGNMENT' ||
        p.type === 'MATCH_NET_ZERO' ||
        p.type === 'AUTO_CLEAR_R16' ||
        p.type === 'AUTO_CLEAR_WO' ||
        p.type === 'PROPOSE_WRITE_OFF' ||
        p.type === 'AUTO_CLEAR_LOW_VALUE' ||
        p.type === 'PROPOSE_CLEAR_AGED',
    ).length,
  };
}
