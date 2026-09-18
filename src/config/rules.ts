/** Business rules for month-end clearing proposals. */

export const DIVISIONS: Record<string, string> = {
  '02AA': 'CPD',
  '02AB': 'PPD',
  '02AC': 'LPD',
  '02AD': 'LDB',
};

export const REASON_CODES = {
  shortage: 'R02',
  priceDiff: 'R03',
  other: 'R11',
  penalty: 'R16',
} as const;

export const DEFAULT_THRESHOLD = 1500;
export const DEFAULT_AGING_DAYS = 90;

/** Dispute statuses treated as still active — blocks R11 aged auto-clear. */
export const ACTIVE_DISPUTE_STATUSES = new Set([
  'UNDER REVIEW',
  'NOT JUSTIFIED',
  'NEW',
  'WITH CLIENT',
  'TO ANALYZE (INTERNAL)',
  'TO BE PAID',
]);

export const EXCLUDED_RK2 = new Set(['XXX', 'XXXX']);
export const RECOVERED_RK2 = new Set(['', 'PAYBACK', 'RET', 'RT', 'R1R2']);
export const WRITE_OFF_CONTAINS = 'WO';
export const REFUSE_PREFIX = 'COM';
export const ACTUAL_SHORTAGE = 'SHO';
export const PMT_CODE = 'PMT';

export const PENALTY_RK2: Record<string, string> = {
  FR: 'Fill Rate',
  EDI: 'EDI',
  PREP: 'DC Charges',
  SHIP: 'Delivery',
  KAM: 'Commercial',
};

export const ACTION_ORDER = [
  'AUTO_CLEAR_R16',
  'MATCH_OFFSET',
  'AUTO_CLEAR_WO',
  'PROPOSE_WRITE_OFF',
  'AUTO_CLEAR_LOW_VALUE',
  'PROPOSE_CLEAR_AGED',
  'AGED_REVIEW',
  'KEEP_OPEN',
] as const;

/** R02 / R03 low-value → machine proposes write-off. */
export const WRITE_OFF_THRESHOLD_REASONS = new Set(['R02', 'R03']);

