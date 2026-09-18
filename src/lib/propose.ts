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

function isPmt(rk2: string): boolean {
  return normalizeCode(rk2) === PMT_CODE;
}

function isCom(rk2: string): boolean {
  const n = normalizeCode(rk2);
  return n.startsWith(REFUSE_PREFIX) && !n.includes(WRITE_OFF_CONTAINS);
}

function moneyKey(n: number): string {
  return n.toFixed(2);
}

function clientDivisionKey(row: LineItem): string {
  return `${row.customer || row.customerName}|${row.division}|${row.businessArea}`;
}

/**
 * Decision tree for lines not consumed by matching (first match wins):
 * 1. R16 → AUTO_CLEAR_R16
 * 2. Key2 = PMT → MATCH_OFFSET
 * 3. Key2 contains WO → AUTO_CLEAR_WO
 * 4. Days in arrears < 0 AND |Amount| > threshold → KEEP_OPEN
 * 5. Key2 = COM* → PROPOSE_WRITE_OFF
 * 6. R02/R03 |Amount| <= threshold → PROPOSE_WRITE_OFF
 * 7. |Amount| <= threshold → AUTO_CLEAR_LOW_VALUE
 * 8. R11 aged + inactive dispute → PROPOSE_CLEAR_AGED
 * 9. Age >= aging → AGED_REVIEW
 * 10. else → KEEP_OPEN
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

/** Exact opposite-amount pairs; oldest (highest days in arrears) first. */
function takeExactPairs(pool: LineItem[]): LineItem[][] {
  const groups: LineItem[][] = [];
  const remaining = [...pool];
  const used = new Set<string>();

  const pos = remaining.filter((r) => r.amount > 0).sort(ageDesc);
  for (const debit of pos) {
    if (used.has(debit.id)) continue;
    // Prefer oldest credit with exact opposite amount
    const credit = remaining
      .filter(
        (c) =>
          !used.has(c.id) &&
          c.amount < 0 &&
          moneyKey(c.amount) === moneyKey(-debit.amount),
      )
      .sort(ageDesc)[0];
    if (!credit) continue;
    used.add(debit.id);
    used.add(credit.id);
    groups.push([debit, credit]);
  }
  return groups;
}

/** If pool nets ~0 and has both signs, clear the whole pool (oldest-first ordering in note via sort). */
function takeNetZeroGroup(pool: LineItem[]): LineItem[] | null {
  if (pool.length < 2) return null;
  const hasPos = pool.some((r) => r.amount > 0);
  const hasNeg = pool.some((r) => r.amount < 0);
  if (!hasPos || !hasNeg) return null;
  const net = pool.reduce((s, r) => s + r.amount, 0);
  if (Math.abs(net) > NET_TOLERANCE) return null;
  return [...pool].sort(ageDesc);
}

/**
 * Greedy exact pairs: oldest debits first, then oldest matching credit.
 */
function takeGreedyPairs(pool: LineItem[]): LineItem[][] {
  const groups: LineItem[][] = [];
  const open = [...pool];
  const used = new Set<string>();

  const sortedDebits = open.filter((r) => r.amount > 0).sort(ageDesc);

  for (const debit of sortedDebits) {
    if (used.has(debit.id)) continue;
    const credit = open
      .filter(
        (c) =>
          !used.has(c.id) &&
          c.amount < 0 &&
          moneyKey(c.amount) === moneyKey(-debit.amount),
      )
      .sort(ageDesc)[0];
    if (!credit) continue;
    used.add(debit.id);
    used.add(credit.id);
    groups.push([debit, credit]);
  }
  return groups;
}

/**
 * Matching within same client + division:
 * 1) Same assignment → exact pairs, then full net-zero group
 * 2) Cross-assignment leftovers → exact pairs, then full net-zero group
 */
function buildMatchProposals(rows: LineItem[]): { proposals: Proposal[]; claimed: Set<string> } {
  const proposals: Proposal[] = [];
  const claimed = new Set<string>();

  const byClientDiv = new Map<string, LineItem[]>();
  for (const row of rows) {
    const key = clientDivisionKey(row);
    const list = byClientDiv.get(key) ?? [];
    list.push(row);
    byClientDiv.set(key, list);
  }

  function claimGroup(
    group: LineItem[],
    type: 'MATCH_ASSIGNMENT' | 'MATCH_NET_ZERO',
    note: string,
  ) {
    const ids = group.map((r) => r.id);
    const journals = group.map((r) => r.journalEntry).filter(Boolean).join(', ');
    for (const row of group) {
      if (claimed.has(row.id)) continue;
      claimed.add(row.id);
      proposals.push(
        toProposal(
          row,
          type,
          type === 'MATCH_ASSIGNMENT' ? 'high' : 'review',
          `${note} · group ${ids.length} lines · JE ${journals || '—'}`,
          ids,
        ),
      );
    }
  }

  for (const [, clientRows] of byClientDiv) {
    const available = () => clientRows.filter((r) => !claimed.has(r.id));

    // Phase 1 — same assignment
    const byAssignment = new Map<string, LineItem[]>();
    for (const row of available()) {
      const asn = row.assignment.trim() || '(blank)';
      const list = byAssignment.get(asn) ?? [];
      list.push(row);
      byAssignment.set(asn, list);
    }

    for (const [asn, asnRows] of byAssignment) {
      if (asn === '(blank)') continue;
      const open = asnRows.filter((r) => !claimed.has(r.id));
      if (open.length < 2) continue;

      for (const pair of takeExactPairs(open)) {
        const ages = pair.map((r) => r.daysInArrears ?? 0);
        claimGroup(
          pair,
          'MATCH_ASSIGNMENT',
          `Same client + division + assignment ${asn} — exact match (oldest first, ages ${ages.join('/')}d)`,
        );
      }

      const afterPairs = open.filter((r) => !claimed.has(r.id));
      const netGroup = takeNetZeroGroup(afterPairs);
      if (netGroup) {
        claimGroup(
          netGroup,
          'MATCH_ASSIGNMENT',
          `Same client + division + assignment ${asn} — nets to zero (oldest-first)`,
        );
      } else {
        for (const pair of takeGreedyPairs(afterPairs.filter((r) => !claimed.has(r.id)))) {
          const ages = pair.map((r) => r.daysInArrears ?? 0);
          claimGroup(
            pair,
            'MATCH_ASSIGNMENT',
            `Same client + division + assignment ${asn} — exact match (oldest first, ages ${ages.join('/')}d)`,
          );
        }
      }
    }

    // Phase 2 — cross-assignment within client + division (reach zero balance)
    const leftovers = available();
    if (leftovers.length < 2) continue;

    for (const pair of takeExactPairs(leftovers)) {
      const asns = [...new Set(pair.map((r) => r.assignment || '(blank)'))].join(' / ');
      const ages = pair.map((r) => r.daysInArrears ?? 0);
      claimGroup(
        pair,
        'MATCH_NET_ZERO',
        `Same client + division — cross-assignment exact match (${asns}, oldest first ${ages.join('/')}d)`,
      );
    }

    const afterExact = leftovers.filter((r) => !claimed.has(r.id));
    const netGroup = takeNetZeroGroup(afterExact);
    if (netGroup) {
      claimGroup(
        netGroup,
        'MATCH_NET_ZERO',
        'Same client + division — cross-assignment group nets to zero (oldest-first)',
      );
    } else {
      for (const pair of takeGreedyPairs(afterExact.filter((r) => !claimed.has(r.id)))) {
        const asns = [...new Set(pair.map((r) => r.assignment || '(blank)'))].join(' / ');
        const ages = pair.map((r) => r.daysInArrears ?? 0);
        claimGroup(
          pair,
          'MATCH_NET_ZERO',
          `Same client + division — cross-assignment exact match (${asns}, oldest first ${ages.join('/')}d)`,
        );
      }
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

  // Oldest first within matches, then remaining actions
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
        p.type === 'PROPOSE_CLEAR_AGED' ||
        p.type === 'MATCH_OFFSET',
    ).length,
  };
}
