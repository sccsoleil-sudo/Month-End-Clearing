import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ACTION_ORDER, DEFAULT_AGING_DAYS, DEFAULT_THRESHOLD } from './config/rules';
import { parseWorkbook } from './lib/parseWorkbook';
import {
  buildProposals,
  headerByAction,
  summarize,
  summarizeByClient,
} from './lib/propose';
import type { ActionType, LineItem, Proposal } from './lib/types';

const REASON_OPTIONS = ['R02', 'R03', 'R11', 'R16'] as const;

type ViewMode = 'header' | 'clients' | 'detail';

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'CAD' });
}

function labelAction(type: ActionType): string {
  return type.replace(/_/g, ' ');
}

function exportWorkbook(
  proposals: Proposal[],
  header: ReturnType<typeof headerByAction>,
  clients: ReturnType<typeof summarizeByClient>,
  filename: string,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      header.map((h) => ({
        Action: labelAction(h.type),
        Lines: h.count,
        Amount: h.amount,
      })),
    ),
    'Header',
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
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      proposals.map((p) => ({
        Action: labelAction(p.type),
        Confidence: p.confidence,
        'Reason Code': p.reasonCode,
        Division: p.division,
        Customer: p.customer,
        'Customer Name': p.customerName,
        Assignment: p.assignment,
        Amount: p.amount,
        'Days in Arrears': p.daysInArrears ?? '',
        Category: p.category,
        'Reference Key 2': p.referenceKey2,
        'Dispute Status': p.disputeStatus,
        'Item Text': p.itemText,
        'Journal Entry': p.journalEntry,
        Note: p.note,
      })),
    ),
    'Detail',
  );
  XLSX.writeFile(wb, filename);
}

export default function App() {
  const [items, setItems] = useState<LineItem[]>([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [agingDays, setAgingDays] = useState(DEFAULT_AGING_DAYS);
  const [reasons, setReasons] = useState<string[]>([...REASON_OPTIONS]);
  const [divisionFilter, setDivisionFilter] = useState('ALL');
  const [reasonFilter, setReasonFilter] = useState('ALL');
  const [actionFilter, setActionFilter] = useState<ActionType | 'ALL'>('ALL');
  const [view, setView] = useState<ViewMode>('header');
  const [over, setOver] = useState(false);

  async function loadFile(file: File) {
    setBusy(true);
    setError('');
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseWorkbook(buffer);
      if (!parsed.length) {
        setError('No R02 / R03 / R11 / R16 rows found. Check the file columns.');
        setItems([]);
      } else {
        setItems(parsed);
        setFileName(file.name);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read workbook');
      setItems([]);
    } finally {
      setBusy(false);
    }
  }

  const proposals = useMemo(
    () =>
      buildProposals(items, {
        threshold,
        agingDays,
        reasonCodes: reasons,
      }),
    [items, threshold, agingDays, reasons],
  );

  const filtered = useMemo(() => {
    return proposals.filter((p) => {
      if (divisionFilter !== 'ALL' && p.division !== divisionFilter) return false;
      if (reasonFilter !== 'ALL' && p.reasonCode !== reasonFilter) return false;
      if (actionFilter !== 'ALL' && p.type !== actionFilter) return false;
      return true;
    });
  }, [proposals, divisionFilter, reasonFilter, actionFilter]);

  const header = useMemo(() => headerByAction(filtered), [filtered]);
  const clients = useMemo(() => summarizeByClient(filtered), [filtered]);
  const stats = useMemo(
    () => summarize(
      items.filter((i) => reasons.includes(i.reasonCode)),
      filtered,
    ),
    [items, reasons, filtered],
  );

  const divisions = useMemo(() => {
    const set = new Set(items.map((i) => i.division));
    return ['ALL', ...[...set].sort()];
  }, [items]);

  function toggleReason(code: string) {
    setReasons((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  return (
    <div className="app">
      <header className="hero">
        <p className="eyebrow">Logistics AR</p>
        <h1>Month-End Clearing</h1>
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
            <p>Reading workbook…</p>
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
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setItems([]);
                  setFileName('');
                }}
              >
                Replace file
              </button>
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

              <label className="field">
                Reason
                <select value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}>
                  <option value="ALL">ALL</option>
                  {REASON_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                Action
                <select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value as ActionType | 'ALL')}
                >
                  <option value="ALL">ALL</option>
                  {ACTION_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {labelAction(t)}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                className="btn"
                disabled={!filtered.length}
                onClick={() =>
                  exportWorkbook(
                    filtered,
                    header,
                    clients,
                    `clearing-${threshold}-${agingDays}d.xlsx`,
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
              <span>In scope</span>
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
            <section className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th className="num">Lines</th>
                    <th className="num">Amount</th>
                    <th className="num">Share of $</th>
                  </tr>
                </thead>
                <tbody>
                  {header.map((h) => {
                    const share =
                      stats.openAmount === 0
                        ? 0
                        : (Math.abs(h.amount) / Math.abs(stats.openAmount)) * 100;
                    return (
                      <tr
                        key={h.type}
                        className="clickable"
                        onClick={() => {
                          setActionFilter(h.type);
                          setView('detail');
                        }}
                      >
                        <td>
                          <span className={`tag ${h.type}`}>{labelAction(h.type)}</span>
                        </td>
                        <td className="num">{h.count.toLocaleString()}</td>
                        <td className="num">{fmtMoney(h.amount)}</td>
                        <td className="num">{share.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!header.length && <p className="hint">No rows for current filters.</p>}
            </section>
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
                    <th>Amount</th>
                    <th>RK2</th>
                    <th>Dispute</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 500).map((p) => (
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
                      <td className="num">{fmtMoney(p.amount)}</td>
                      <td className="mono">{p.referenceKey2 || '—'}</td>
                      <td className="mono">{p.disputeStatus || '—'}</td>
                      <td className="note">{p.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 500 && (
                <p className="hint">
                  Showing first 500 of {filtered.length.toLocaleString()} — export for full list.
                </p>
              )}
              {!filtered.length && <p className="hint">No proposals for the current filters.</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
