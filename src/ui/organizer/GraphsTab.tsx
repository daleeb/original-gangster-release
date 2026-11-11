import { useState } from 'react';
import { useGame } from '../../app/store';
import { GANG_COLORS } from '../../sim/constants';
import type { GangWeekStat } from '../../sim/types';
import { Empty, Hint, Panel } from '../common';

type Metric = 'power' | 'assets' | 'territory' | 'manpower' | 'loyalty' | 'crimes' | 'suspicion';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'power', label: 'Overall Power' },
  { id: 'assets', label: 'Assets' },
  { id: 'territory', label: 'Territory' },
  { id: 'manpower', label: 'Manpower' },
  { id: 'loyalty', label: 'Gang Loyalty' },
  { id: 'crimes', label: 'Crimes' },
  { id: 'suspicion', label: 'Suspicion' },
];

export function GraphsTab() {
  const sim = useGame((s) => s.sim)!;
  useGame((s) => s.version);
  const [metric, setMetric] = useState<Metric>('power');
  const [allGangs, setAllGangs] = useState(true);
  const [bars, setBars] = useState(false);
  // With the Bureau's gauges hidden its graph goes too.
  const bureauGauges = useGame((s) => s.bureauGauges);
  const metrics = bureauGauges ? METRICS : METRICS.filter((m) => m.id !== 'suspicion');
  if (!bureauGauges && metric === 'suspicion') setMetric('power');

  const w = sim.world;
  const player = sim.playerGang;
  const gangs = allGangs ? Object.values(w.gangs) : [player];
  const series = gangs.map((g) => ({
    gang: g,
    points: g.history.slice(-8),
  }));

  const value = (p: GangWeekStat): number | undefined => metric === 'assets' && p.cash == null ? undefined : p[metric];
  const oldAssets = metric === 'assets' && series.some(s => s.points.some(p => p.cash == null));
  const maxVal = Math.max(1, ...series.flatMap(s => s.points.flatMap(p => value(p) == null ? [] : [value(p)!])));
  const weeks = Math.max(1, ...series.map((s) => s.points.length));
  const W = 560;
  const H = 200;
  const pad = 26;

  // A single week sits in the middle of the chart, not against its left edge.
  const x = (i: number) => weeks === 1 ? W / 2 : pad + (i / (weeks - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / maxVal) * (H - pad * 2);

  const hasData = series.some(s => s.points.some(p => value(p) != null));

  return (
    <div>
      <Panel title="Graph Reports">
        <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
          {metrics.map((m) => (
            <button key={m.id} aria-pressed={metric === m.id} className={`btn sm${metric === m.id ? ' on' : ''}`} onClick={() => setMetric(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ gap: 4, marginBottom: 10 }}>
          <button aria-pressed={!bars} className={`btn sm${!bars ? ' on' : ''}`} onClick={() => setBars(false)}>
            Line
          </button>
          <button aria-pressed={bars} className={`btn sm${bars ? ' on' : ''}`} onClick={() => setBars(true)}>
            Bar
          </button>
          <button aria-pressed={!allGangs} className={`btn sm${!allGangs ? ' on' : ''}`} onClick={() => setAllGangs(false)}>
            Your Data
          </button>
          <button aria-pressed={allGangs} className={`btn sm${allGangs ? ' on' : ''}`} onClick={() => setAllGangs(true)}>
            All Data
          </button>
        </div>

        {oldAssets && <Hint>Older saves combined cash and assets without recording the split. Those weeks are omitted here; their other graphs remain available.</Hint>}
        {!hasData ? (
          <Empty>{oldAssets ? 'No separate asset history yet — finish a week to record it.' : 'No history yet — finish a week and come back.'}</Empty>
        ) : (
          <div className="graph-wrap">
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${metric} over time`}>
              {/* Week numbers along the bottom. */}
              {(series.find(t => t.points.length === weeks)?.points ?? []).map((p, i) => (
                <text key={`wk${i}`} x={x(i)} y={H - 8} fontSize={9} fill="#6d6552" textAnchor="middle">Wk {p.week}</text>
              ))}
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line
                    x1={pad}
                    x2={W - pad}
                    y1={y(maxVal * f)}
                    y2={y(maxVal * f)}
                    stroke="#bdb094"
                    strokeWidth={f === 0 ? 1.4 : 0.6}
                  />
                  <text x={4} y={y(maxVal * f) + 3} fontSize={9} fill="#6d6552">
                    {Math.round(maxVal * f).toLocaleString('en-US')}
                  </text>
                </g>
              ))}

              {series.map((s, si) =>
                bars ? (
                  s.points.map((p, i) => {
                    const v = value(p);
                    if (v == null) return null;
                    const bw = (W - pad * 2) / Math.max(1, weeks) / Math.max(1, series.length) - 2;
                    return (
                      <rect
                        key={`${s.gang.id}-${i}`}
                        x={x(i) - ((series.length * (bw + 2)) / 2) + si * (bw + 2)}
                        y={y(v)}
                        width={Math.max(2, bw)}
                        height={Math.max(0, H - pad - y(v))}
                        fill={GANG_COLORS[s.gang.color].hex}
                        opacity={s.gang.isPlayer ? 1 : 0.72}
                      />
                    );
                  })
                ) : (
                  <g key={s.gang.id}><path
                    fill="none"
                    stroke={GANG_COLORS[s.gang.color].hex}
                    strokeWidth={s.gang.isPlayer ? 2.6 : 1.6}
                    strokeLinejoin="round"
                    d={s.points.map((p, i) => value(p) == null ? '' : `${i > 0 && value(s.points[i-1]) != null ? 'L' : 'M'}${x(i)},${y(value(p)!)}`).join(' ')}
                  />{s.points.map((p,i) => value(p) == null ? null : <circle key={i} cx={x(i)} cy={y(value(p)!)} r={weeks === 1 ? 5 : 2.5} fill={GANG_COLORS[s.gang.color].hex} />)}</g>
                ),
              )}
            </svg>
            <div className="legend">
              {series.map((s) => (
                <span key={s.gang.id}>
                  <i style={{ background: GANG_COLORS[s.gang.color].hex }} />
                  {s.gang.name}
                  {s.gang.isPlayer && ' (you)'}
                </span>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
