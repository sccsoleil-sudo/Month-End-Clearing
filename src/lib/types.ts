import { ACTION_ORDER } from '../config/rules';

export type ReasonCode = 'R02' | 'R03' | 'R11' | 'R16' | string;

export interface LineItem {
  id: string;
  customerName: string;
  customer: string;
  assignment: string;
  reference: string;
  daysInArrears: number | null;
  journalEntryDate: string;
  businessArea: string;
  division: string;
  amount: number;
  reasonCode: ReasonCode;
  referenceKey2: string;
  itemText: string;
  journalEntry: string;
  baselineDate: string;
  disputeId: string;
  disputeStatus: string;
  category: string;
}

export type ActionType = (typeof ACTION_ORDER)[number];

export interface Proposal {
  id: string;
  type: ActionType;
  reasonCode: string;
  division: string;
  businessArea: string;
  assignment: string;
  customer: string;
  customerName: string;
  amount: number;
  daysInArrears: number | null;
  category: string;
  referenceKey2: string;
  disputeStatus: string;
  itemText: string;
  journalEntry: string;
  confidence: 'high' | 'review' | 'hold';
  note: string;
  linkedIds: string[];
}

export interface ProposalOptions {
  /** Absolute amount for AUTO CLEAR LOW VALUE. */
  threshold: number;
  /** Days in arrears for aged rules (default 90). */
  agingDays: number;
  reasonCodes: string[];
}

export interface ActionSummary {
  type: ActionType;
  count: number;
  amount: number;
}

export interface ClientSummary {
  customer: string;
  customerName: string;
  lineCount: number;
  amount: number;
  byAction: Record<string, { count: number; amount: number }>;
}
