import { useEffect, useRef } from 'react';
import type { LineItem, ProposalOptions } from '../lib/types';
import type { WorkerResponse } from './analyze.worker';

type Pending = {
  resolve: (value: WorkerResponse & { ok: true }) => void;
  reject: (err: Error) => void;
};

/**
 * Background Excel parse + proposal build so the UI thread stays responsive.
 */
export function createAnalyzeWorker() {
  const worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), {
    type: 'module',
  });
  let nextId = 1;
  const pending = new Map<number, Pending>();

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (!msg.ok) {
      slot.reject(new Error(msg.error));
      return;
    }
    slot.resolve(msg);
  };

  worker.onerror = (ev) => {
    const err = new Error(ev.message || 'Analyze worker failed');
    for (const [, slot] of pending) slot.reject(err);
    pending.clear();
  };

  function request(
    payload: Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<WorkerResponse & { ok: true }> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...payload, id }, transfer ?? []);
    });
  }

  return {
    analyze(buffer: ArrayBuffer, options: ProposalOptions) {
      return request({ type: 'analyze', buffer, options }, [buffer]);
    },
    propose(items: LineItem[], options: ProposalOptions) {
      return request({ type: 'propose', items, options });
    },
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}

export type AnalyzeWorker = ReturnType<typeof createAnalyzeWorker>;

export function useAnalyzeWorker(): AnalyzeWorker {
  const ref = useRef<AnalyzeWorker | null>(null);
  if (!ref.current) ref.current = createAnalyzeWorker();

  useEffect(() => {
    return () => {
      ref.current?.terminate();
      ref.current = null;
    };
  }, []);

  return ref.current;
}
