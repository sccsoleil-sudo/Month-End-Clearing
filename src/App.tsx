import { startTransition, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ACTION_ORDER,
  AGING_BUCKETS,
  DEFAULT_AGING_DAYS,
  DEFAULT_THRESHOLD,
} from './config/rules';
import {
  agingBucketId,
  headerByAction,
  headerByAging,
  summarize,
  summarizeByClient,
} from './lib/propose';
import type { ActionType, LineItem, Proposal } from './lib/types';
import { useAnalyzeWorker } from './workers/analyzeClient';

const REASON_OPTIONS = ['R02', 'R03', 'R11', 'R16'] as const;

const REASON_TAB_LABELS: Record<(typeof REASON_OPTIONS)[number], string> = {
  R02: 'R02 Shortage',
  R03: 'R03 Price diff',
  R11: 'R11',
  R16: 'R16 Penalties',
};

type ViewMode = 'header' | 'clients' | 'detail';
type ReasonTab = 'ALL' | (typeof REASON_OPTIONS)[number];

/** Cap DOM rows in Detail so the page stays responsive. */
const DETAIL_ROW_CAP = 2_000;

function proposalOptions(threshold: number, agingDays: number) {
  return {
    threshold,
    agingDays,
    reasonCodes: [...REASON_OPTIONS] as string[],
  };
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'CAD' });
}

function labelAction(type: ActionType): string {
  return type.replace(/_/g, ' ');
}

function exportWorkbook(
  proposals: Proposal[],
  header: ReturnType<typeof headerByAction>,
  aging: ReturnType<typeof headerByAging>,
  clients: ReturnType<typeof summarizeByClient>,
  sourceColumns: string[],
  filename: string,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      aging.map((a) => ({
        Aging: a.label,
        Lines: a.count,
        Amount: a.amount,
      })),
    ),
    'Header Aging',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      header.map((h) => {
        const row: Record<string, string | number> = {
          Action: labelAction(h.type),
          Lines: h.count,
          Amount: h.amount,
        };
        for (const b of AGING_BUCKETS) {
          row[`${b.label} $`] = h.byAging[b.id]?.amount ?? 0;
          row[`${b.label} #`] = h.byAging[b.id]?.count ?? 0;
        }
        return row;
      }),
    ),
    'Header Action',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      clients.map((c) => {
        const row: Record<string, string | number> = {
          Customer: c.customer,
          'Customer Name': c.customerName,
          Lines: c.lineCount,
          Amount: c.amount,
        };
        for (const type of ACTION_ORDER) {
          const b = c.byAction[type];
          row[`${labelAction(type)} $`] = b?.amount ?? 0;
          row[`${labelAction(type)} #`] = b?.count ?? 0;
        }
        return row;
      }),
    ),
    'By Client',
  );

  // Detail: same columns as upload (order preserved) + Action + Aging Bucket
  const detailRows = proposals.map((p) => {
    const row: Record<string, unknown> = {};
    const cols =
      sourceColumns.length > 0
        ? sourceColumns
        : Object.keys(p.sourceRow ?? {});
    for (const col of cols) {
      const v = p.sourceRow?.[col];
      row[col] = v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? '');
    }
    row['Action'] = labelAction(p.type);
    row['Aging Bucket'] =
      AGING_BUCKETS.find((b) => b.id === agingBucketId(p.daysInArrears))?.label ??
      '';
    return row;
  });
  const detailSheet =
    detailRows.length > 0
      ? XLSX.utils.json_to_sheet(detailRows)
      : XLSX.utils.aoa_to_sheet([
          [...sourceColumns, 'Action', 'Aging Bucket'],
        ]);
  XLSX.utils.book_append_sheet(wb, detailSheet, 'Detail');
  XLSX.writeFile(wb, filename);
}

export default function App() {
  const worker = useAnalyzeWorker();
  const [items, setItems] = useState<LineItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Reading workbook…');
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [agingDays, setAgingDays] = useState(DEFAULT_AGING_DAYS);
  const [reasons, setReasons] = useState<string[]>([...REASON_OPTIONS]);
  const [reasonTab, setReasonTab] = useState<ReasonTab>('ALL');
  const [divisionFilter, setDivisionFilter] = useState('ALL');
  const [actionFilters, setActionFilters] = useState<ActionType[]>([...ACTION_ORDER]);
  const [agingFilters, setAgingFilters] = useState<string[]>(AGING_BUCKETS.map((b) => b.id));
  const [view, setView] = useState<ViewMode>('header');
  const [over, setOver] = useState(false);

  async function loadFile(file: File) {
    setBusy(true);
    setBusyLabel('Reading workbook in background…');
    setError('');
    setProposals([]);
    setItems([]);
    setSourceColumns([]);
    try {
      const buffer = await file.arrayBuffer();
      setBusyLabel('Parsing & matching (UI stays responsive)…');
      const result = await worker.analyze(buffer, proposalOptions(threshold, agingDays));
      if (!('items' in result) || !result.items.length) {
        setError('No R02 / R03 / R11 / R16 rows found. Check the file columns.');
        setItems([]);
        setProposals([]);
        setSourceColumns([]);
        setFileName('');
        return;
      }
      startTransition(() => {
        setItems(result.items);
        setProposals(result.proposals);
        setSourceColumns(
          'sourceColumns' in result && Array.isArray(result.sourceColumns)
            ? result.sourceColumns
            : [],
        );
        setFileName(file.name);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read workbook');
      setItems([]);
      setProposals([]);
      setSourceColumns([]);
      setFileName('');
    } finally {
      setBusy(false);
    }
  }

  // Re-run matching in the worker when threshold / aging change (items already loaded).
  useEffect(() => {
    if (!items.length) {
      setAnalyzing(false);
      return;
    }
    let cancelled = false;
    setAnalyzing(true);
    void worker
      .propose(items, proposalOptions(threshold, agingDays))
      .then((result) => {
        if (cancelled) return;
        startTransition(() => {
          setProposals(result.proposals);
          setAnalyzing(false);
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to rebuild proposals');
        setAnalyzing(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally omit `items`: loadFile already returns proposals from the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only rebuild on rule changes
  }, [threshold, agingDays, worker]);

  const activeReasons = useMemo(() => {
    if (reasonTab !== 'ALL') return [reasonTab];
    return reasons;
  }, [reasonTab, reasons]);

  const filtered = useMemo(() => {
    return proposals.filter((p) => {
      if (divisionFilter !== 'ALL' && p.division !== divisionFilter) return false;
      if (!activeReasons.includes(p.reasonCode)) return false;
      if (actionFilters.length > 0 && !actionFilters.includes(p.type)) return false;
      if (agingFilters.length > 0 && !agingFilters.includes(agingBucketId(p.daysInArrears))) {
        return false;
      }
      return true;
    });
  }, [proposals, divisionFilter, activeReasons, actionFilters, agingFilters]);

  const detailRows = useMemo(
    () => filtered.slice(0, DETAIL_ROW_CAP),
    [filtered],
  );

  const header = useMemo(() => headerByAction(filtered), [filtered]);
  const agingHeader = useMemo(() => headerByAging(filtered), [filtered]);
  const clients = useMemo(() => summarizeByClient(filtered), [filtered]);
  const stats = useMemo(
    () =>
      summarize(
        items.filter((i) => activeReasons.includes(i.reasonCode)),
        filtered,
      ),
    [items, activeReasons, filtered],
  );

  const reasonCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const code of REASON_OPTIONS) map.set(code, 0);
    for (const row of items) {
      map.set(row.reasonCode, (map.get(row.reasonCode) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const divisions = useMemo(() => {
    const set = new Set(
      items.filter((i) => activeReasons.includes(i.reasonCode)).map((i) => i.division),
    );
    return ['ALL', ...[...set].sort()];
  }, [items, activeReasons]);

  function toggleReason(code: string) {
    setReasons((prev) => {
      if (prev.includes(code)) {
        if (prev.length === 1) return prev; // keep at least one
        return prev.filter((c) => c !== code);
      }
      return [...prev, code];
    });
  }

  function toggleAction(type: ActionType) {
    setActionFilters((prev) => {
      if (prev.includes(type)) {
        if (prev.length === 1) return prev;
        return prev.filter((t) => t !== type);
      }
      return [...prev, type];
    });
  }

  function selectAllActions() {
    setActionFilters([...ACTION_ORDER]);
  }

  function selectAllReasons() {
    setReasons([...REASON_OPTIONS]);
  }

  function toggleAging(id: string) {
    setAgingFilters((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== id);
      }
      return [...prev, id];
    });
  }

  function selectAllAging() {
    setAgingFilters(AGING_BUCKETS.map((b) => b.id));
  }

  return (
    <div className="app">
      <header className="hero">
        <p className="eyebrow">Logistics AR</p>
        <h1>Month-End Clearing</h1>
        <p className="build-stamp">Build 2026-09-24a · export source columns</p>
        <p className="lede">
          Decision tree by reason, RK2, threshold, and aging — header totals and by client.
        </p>
      </header>

      {!items.length ? (
        <section
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void loadFile(file);
          }}
        >
          {busy ? (
            <p>{busyLabel}</p>
          ) : (
            <>
              <h2>Drop Customer Line Items</h2>
              <p>
                .xlsx with Reason Code, Amount, Days in Arrears, Reference Key 2, Dispute Status
                (optional)
              </p>
              <label className="btn">
                Choose file
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void loadFile(file);
                    e.target.value = '';
                  }}
                />
              </label>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      ) : (
        <>
          <section className="toolbar">
            <div className="file-meta">
              <strong>{fileName}</strong>
              <span>{items.length.toLocaleString()} lines (R02 / R03 / R11 / R16)</span>
              {analyzing && <span className="analyzing">Analyzing matches…</span>}
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setItems([]);
                  setProposals([]);
                  setSourceColumns([]);
                  setFileName('');
                }}
              >
                Replace file
              </button>
            </div>

            <div className="reason-tabs">
              <button
                type="button"
                className={`reason-tab${reasonTab === 'ALL' ? ' on' : ''}`}
                onClick={() => setReasonTab('ALL')}
              >
                All
                <span className="tab-count">{items.length.toLocaleString()}</span>
              </button>
              {REASON_OPTIONS.map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`reason-tab${reasonTab === code ? ' on' : ''}`}
                  onClick={() => setReasonTab(code)}
                >
                  {REASON_TAB_LABELS[code]}
                  <span className="tab-count">
                    {(reasonCounts.get(code) ?? 0).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>

            <div className="controls">
              <label className="field">
                Low-value threshold
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value) || 0)}
                />
              </label>

              <label className="field">
                Aging (days)
                <input
                  type="number"
                  min={0}
                  step={30}
                  value={agingDays}
                  onChange={(e) => setAgingDays(Number(e.target.value) || 0)}
                />
              </label>

              {reasonTab === 'ALL' && (
                <div className="filter-group">
                  <span className="filter-label">
                    Reason code
                    <button type="button" className="linkish" onClick={selectAllReasons}>
                      All
                    </button>
                  </span>
                  <div className="chips">
                    {REASON_OPTIONS.map((code) => (
                      <button
                        key={code}
                        type="button"
                        className={`chip${reasons.includes(code) ? ' on' : ''}`}
                        onClick={() => toggleReason(code)}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="filter-group">
                <span className="filter-label">
                  Action
                  <button type="button" className="linkish" onClick={selectAllActions}>
                    All
                  </button>
                </span>
                <div className="chips wrap">
                  {ACTION_ORDER.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`chip${actionFilters.includes(t) ? ' on' : ''}`}
                      onClick={() => toggleAction(t)}
                    >
                      {labelAction(t)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="field">
                Division
                <select value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
                  {divisions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>

              <div className="filter-group">
                <span className="filter-label">
                  Aging bucket
                  <button type="button" className="linkish" onClick={selectAllAging}>
                    All
                  </button>
                </span>
                <div className="chips wrap">
                  {AGING_BUCKETS.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      className={`chip${agingFilters.includes(b.id) ? ' on' : ''}`}
                      onClick={() => toggleAging(b.id)}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="btn"
                disabled={!filtered.length}
                onClick={() =>
                  exportWorkbook(
                    filtered,
                    header,
                    agingHeader,
                    clients,
                    sourceColumns,
                    `clearing-${reasonTab}-${threshold}-${agingDays}d.xlsx`,
                  )
                }
              >
                Export
              </button>
            </div>

            <div className="view-tabs">
              {(
                [
                  ['header', 'Header'],
                  ['clients', 'By client'],
                  ['detail', 'Detail'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`chip${view === id ? ' on' : ''}`}
                  onClick={() => setView(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="kpis">
            <article>
              <span>
                {reasonTab === 'ALL' ? 'In scope' : REASON_TAB_LABELS[reasonTab]}
              </span>
              <strong>{stats.lineCount.toLocaleString()}</strong>
              <em>{fmtMoney(stats.openAmount)}</em>
            </article>
            <article>
              <span>Clear / match / propose</span>
              <strong>{stats.clearableCount.toLocaleString()}</strong>
              <em>{fmtMoney(stats.proposedAmount)}</em>
            </article>
            <article>
              <span>Rules</span>
              <strong>|amt| ≤ {threshold.toLocaleString()}</strong>
              <em>Age ≥ {agingDays}d</em>
            </article>
          </section>

          {view === 'header' && (
            <>
              <section className="table-wrap">
                <div className="section-label">Aging</div>
                <table>
                  <thead>
                    <tr>
                      <th>Aging</th>
                      <th className="num">Lines</th>
                      <th className="num">Amount</th>
                      <th className="num">Share of $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agingHeader.map((a) => {
                      const share =
                        stats.openAmount === 0
                          ? 0
                          : (Math.abs(a.amount) / Math.abs(stats.openAmount)) * 100;
                      return (
                        <tr
                          key={a.id}
                          className="clickable"
                          onClick={() => {
                            setAgingFilters([a.id]);
                            setView('detail');
                          }}
                        >
                          <td>
                            <span className={`tag aging bucket-${a.id}`}>{a.label}</span>
                          </td>
                          <td className="num">{a.count.toLocaleString()}</td>
                          <td className="num">{fmtMoney(a.amount)}</td>
                          <td className="num">{share.toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!agingHeader.length && <p className="hint">No rows for current filters.</p>}
              </section>

              <section className="table-wrap" style={{ marginTop: '0.85rem' }}>
                <div className="section-label">By action × aging</div>
                <table>
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th className="num">Lines</th>
                      <th className="num">Amount</th>
                      {AGING_BUCKETS.map((b) => (
                        <th key={b.id} className="num narrow">
                          {b.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {header.map((h) => (
                      <tr
                        key={h.type}
                        className="clickable"
                        onClick={() => {
                          setActionFilters([h.type]);
                          setView('detail');
                        }}
                      >
                        <td>
                          <span className={`tag ${h.type}`}>{labelAction(h.type)}</span>
                        </td>
                        <td className="num">{h.count.toLocaleString()}</td>
                        <td className="num">{fmtMoney(h.amount)}</td>
                        {AGING_BUCKETS.map((b) => {
                          const cell = h.byAging[b.id];
                          return (
                            <td key={b.id} className="num narrow">
                              {cell ? fmtMoney(cell.amount) : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!header.length && <p className="hint">No rows for current filters.</p>}
              </section>
            </>
          )}

          {view === 'clients' && (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Lines</th>
                    <th className="num">Amount</th>
                    {ACTION_ORDER.map((t) => (
                      <th key={t} className="num narrow">
                        {labelAction(t)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {clients.slice(0, 200).map((c) => (
                    <tr key={c.customer || c.customerName}>
                      <td>
                        <div className="stack">
                          <span>{c.customerName}</span>
                          <small>{c.customer}</small>
                        </div>
                      </td>
                      <td className="num">{c.lineCount.toLocaleString()}</td>
                      <td className="num">{fmtMoney(c.amount)}</td>
                      {ACTION_ORDER.map((t) => {
                        const b = c.byAction[t];
                        return (
                          <td key={t} className="num narrow">
                            {b ? fmtMoney(b.amount) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {clients.length > 200 && (
                <p className="hint">
                  Showing first 200 of {clients.length.toLocaleString()} clients — export for full
                  list.
                </p>
              )}
              {!clients.length && <p className="hint">No clients for current filters.</p>}
            </section>
          )}

          {view === 'detail' && (
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Reason</th>
                    <th>Division</th>
                    <th>Customer</th>
                    <th>Age</th>
                    <th>Aging</th>
                    <th>Amount</th>
                    <th>RK2</th>
                    <th>Dispute</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className={`tag ${p.type}`}>{labelAction(p.type)}</span>
                      </td>
                      <td>{p.reasonCode}</td>
                      <td>{p.division}</td>
                      <td>
                        <div className="stack">
                          <span>{p.customerName}</span>
                          <small>{p.customer}</small>
                        </div>
                      </td>
                      <td className="num">{p.daysInArrears ?? '—'}</td>
                      <td className="mono">
                        {AGING_BUCKETS.find((b) => b.id === agingBucketId(p.daysInArrears))
                          ?.label ?? '—'}
                      </td>
                      <td className="num">{fmtMoney(p.amount)}</td>
                      <td className="mono">{p.referenceKey2 || '—'}</td>
                      <td className="mono">{p.disputeStatus || '—'}</td>
                      <td className="note">{p.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > DETAIL_ROW_CAP && (
                <p className="hint">
                  Showing first {DETAIL_ROW_CAP.toLocaleString()} of{' '}
                  {filtered.length.toLocaleString()} — export for full list.
                </p>
              )}
              {analyzing && <p className="hint">Building proposals…</p>}
              {!analyzing && !filtered.length && (
                <p className="hint">No proposals for the current filters.</p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
