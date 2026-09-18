/// <reference lib="webworker" />
import { parseWorkbook } from '../lib/parseWorkbook';
import { buildProposals } from '../lib/propose';
import type { LineItem, Proposal, ProposalOptions } from '../lib/types';

export type AnalyzeRequest = {
  id: number;
  type: 'analyze';
  buffer: ArrayBuffer;
  options: ProposalOptions;
};

export type ProposeRequest = {
  id: number;
  type: 'propose';
  items: LineItem[];
  options: ProposalOptions;
};

export type WorkerRequest = AnalyzeRequest | ProposeRequest;

export type WorkerResponse =
  | { id: number; ok: true; items: LineItem[]; proposals: Proposal[] }
  | { id: number; ok: true; proposals: Proposal[] }
  | { id: number; ok: false; error: string };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'analyze') {
      const items = parseWorkbook(msg.buffer);
      const proposals = buildProposals(items, msg.options);
      const res: WorkerResponse = { id: msg.id, ok: true, items, proposals };
      ctx.postMessage(res);
      return;
    }

    const proposals = buildProposals(msg.items, msg.options);
    const res: WorkerResponse = { id: msg.id, ok: true, proposals };
    ctx.postMessage(res);
  } catch (e) {
    const res: WorkerResponse = {
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    ctx.postMessage(res);
  }
};
