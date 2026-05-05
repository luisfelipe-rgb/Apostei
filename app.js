// Only consider data from April 2026 onwards (when spend tracking begins)
const DATA_START = '2026-04-01';

const PERIODS = {
  all:  { label: 'YTD (Apr+)', start: DATA_START, end: '2026-12-31' },
  Q2:   { label: 'Q2',         start: '2026-04-01', end: '2026-06-30' },
  Q3:   { label: 'Q3',         start: '2026-07-01', end: '2026-09-30' },
  Q4:   { label: 'Q4',         start: '2026-10-01', end: '2026-12-31' },
  MTD:  { label: 'MTD',        start: '2026-05-01', end: '2026-05-31' },
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let activePeriod = 'all';
let activeChannel = 'all';
let customRange = null; // { from, to } when a custom range is set
let ggrChart, monthlyChart, dowChart;

const fmt = (n) => n >= 1e6
  ? 'R$ ' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3
  ? 'R$ ' + (n / 1e3).toFixed(1) + 'k'
  : 'R$ ' + n.toLocaleString();

const fmtFull = (n) => 'R$ ' + Math.round(n).toLocaleString('pt-BR');

// When a specific channel is selected, swap actuals with channel-level data
// and replace BP values with channel-specific BP from CHANNEL_BP_DATA.
// For months not in CHANNEL_BP_DATA (Jun+), BP fields fall back to 0 → shows "—".
function buildRenderData(ggrData, channel) {
  if (channel === 'all') return ggrData;
  const chMap = {};
  CHANNEL_DATA
    .filter(d => d.channel === channel)
    .forEach(d => { chMap[d.date] = d; });
  const chBpMap = {};
  CHANNEL_BP_DATA
    .filter(d => d.channel === channel)
    .forEach(d => { chBpMap[d.date] = d; });
  return ggrData.map(row => {
    const ch   = chMap[row.date];
    const chBp = chBpMap[row.date];
    return {
      ...row,
      ftd:     ch   ? (ch.ftd   || 0) : 0,
      d0:      ch   ? (ch.d0    || 0) : 0,
      d1:      ch   ? (ch.d1    || 0) : 0,
      spend:   ch   ? (ch.spend || 0) : 0,
      ggr:     ch   ? (ch.ggr   || 0) : 0,
      deposit: 0,
      bpSpend: chBp ? chBp.bpSpend : 0,
      bpFtd:   chBp ? chBp.bpFtd   : 0,
      bpD0:    chBp ? chBp.bpD0    : 0,
    };
  });
}

function filterData(period) {
  // Always exclude data before DATA_START (no spend tracking before then)
  const base = GGR_DATA.filter(d => d.date >= DATA_START);
  if (customRange) {
    const { from, to } = customRange;
    const effectiveFrom = from < DATA_START ? DATA_START : from;
    return base.filter(d => d.date >= effectiveFrom && d.date <= to);
  }
  const { start, end } = PERIODS[period];
  return base.filter(d => d.date >= start && d.date <= end);
}

function movingAvg(data, window = 7) {
  return data.map((_, i) => {
    const slice = data.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function monthlyAgg(data) {
  const map = {};
  data.forEach(d => {
    const m = d.date.slice(0, 7);
    map[m] = (map[m] || 0) + d.ggr;
  });
  return map;
}

function dowAgg(data) {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  data.forEach(d => {
    const dow = new Date(d.date + 'T12:00:00').getDay();
    sums[dow] += d.ggr;
    counts[dow]++;
  });
  return sums.map((s, i) => counts[i] ? s / counts[i] : 0);
}

// Returns pro-rated BP totals: daily BP rate × number of days with actual data.
// This makes the BP comparable to actuals on the same time basis
// (e.g. 4 days into May → BP = daily_rate × 4, not × 31).
function fullMonthBp(data) {
  const actualDays = data.filter(d =>
    d.ftd > 0 || d.spend > 0 || d.d0 > 0 || d.ggr !== 0 || d.deposit > 0
  );
  return {
    bpSpend: actualDays.reduce((s, d) => s + (d.bpSpend || 0), 0),
    bpFtd:   actualDays.reduce((s, d) => s + (d.bpFtd   || 0), 0),
    bpD0:    actualDays.reduce((s, d) => s + (d.bpD0    || 0), 0),
  };
}

// Compare actual vs BP. Returns 'good' / 'bad' / null.
// lowerIsBetter=true for cost metrics (spend) where staying under BP is good.
function vsBp(actual, bp, lowerIsBetter = false) {
  if (bp === null || bp === undefined || bp === 0 || !isFinite(bp)) return null;
  if (actual === null || actual === undefined || !isFinite(actual)) return null;
  if (lowerIsBetter) return actual <= bp ? 'good' : 'bad';
  return actual >= bp ? 'good' : 'bad';
}

// Returns {prevKey, prevLabel, prevData} for the month before the most recent month
// with actual data. Always searches the full dataset (DATA_START onwards) so that
// period filters like MTD (May only) can still find April M-1 data.
function getPrevMonthSlice(data) {
  if (!data.length) return { prevKey: null, prevLabel: null, prevData: [] };

  // Full dataset from DATA_START (no future zero-rows distortion)
  const fullData = GGR_DATA.filter(d => d.date >= DATA_START);

  // Find the most recent date that has any real actual data
  const latestActual = [...fullData].reverse().find(d =>
    d.spend > 0 || d.ftd > 0 || d.ggr !== 0 || d.d0 > 0
  );
  const refDate = latestActual ? latestActual.date : data[data.length - 1].date;

  const [yStr, mStr] = refDate.split('-');
  const prev = new Date(+yStr, +mStr - 2, 1); // month before the current actual month
  const prevKey = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  const prevLabel = MONTH_LABELS[prev.getMonth()];

  // Pull M-1 data from the full dataset, not the period-filtered slice
  const prevData = fullData.filter(d => d.date.startsWith(prevKey));
  return { prevKey, prevLabel, prevData };
}

function renderKPIs(data) {
  const total = data.reduce((s, d) => s + d.ggr, 0);
  const avg   = total / data.length;
  const max   = Math.max(...data.map(d => d.ggr));
  const maxDay = data.find(d => d.ggr === max);
  const days  = data.length;

  const { prevLabel, prevData } = getPrevMonthSlice(data);
  const prevGgr     = prevData.reduce((s, d) => s + d.ggr, 0);
  const prevSpend   = prevData.reduce((s, d) => s + (d.spend || 0), 0);
  const prevDeposit = prevData.reduce((s, d) => s + (d.deposit || 0), 0);
  const m1Tag = prevLabel ? `M-1 (${prevLabel})` : 'M-1';

  // Period Trend: extrapolate this month's revenue assuming the same MoM growth
  // rate that occurred last month vs the month before.
  // Uses the full GGR_DATA (not filtered) so we can reach back two months.
  let trendValue = '—';
  let trendSub = 'no projection available';
  let trendDelta = null;

  if (data.length > 0) {
    const lastDate = data[data.length - 1].date;
    const [yStr, mStr] = lastDate.split('-');
    const curY = +yStr, curM = +mStr;
    const curLabel = MONTH_LABELS[curM - 1];

    const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
    const sumGgrInMonth = (y, m) => GGR_DATA
      .filter(d => d.date.startsWith(monthKey(y, m)))
      .reduce((s, d) => s + d.ggr, 0);

    // Previous month (M-1) and the month before it (M-2)
    const m1Y = curM === 1 ? curY - 1 : curY;
    const m1M = curM === 1 ? 12 : curM - 1;
    const m2Y = m1M === 1 ? m1Y - 1 : m1Y;
    const m2M = m1M === 1 ? 12 : m1M - 1;

    const m1Total = sumGgrInMonth(m1Y, m1M);
    const m2Total = sumGgrInMonth(m2Y, m2M);

    if (m1Total !== 0 && m2Total !== 0) {
      const growthPct = ((m1Total - m2Total) / Math.abs(m2Total));
      const projected = m1Total * (1 + growthPct);
      trendValue = fmt(projected);
      trendSub = `${curLabel} proj. · M-1 grew ${(growthPct * 100).toFixed(1)}%`;
      trendDelta = growthPct >= 0 ? 'up' : 'down';
    }
  }

  const totalSpend = data.reduce((s, d) => s + (d.spend || 0), 0);
  const spendValue = totalSpend > 0 ? fmt(totalSpend) : '—';
  const spendSub   = totalSpend > 0 ? 'total investment' : 'pending BigQuery access';

  const totalDeposit = data.reduce((s, d) => s + (d.deposit || 0), 0);

  // BP totals for current period — always full monthly targets
  const { bpSpend, bpFtd } = fullMonthBp(data);
  // BP totals for M-1 period — full month
  const { bpSpend: prevBpSpend, bpFtd: prevBpFtd } = fullMonthBp(prevData);

  const kpis = [
    { label: 'Total GGR',     value: fmt(total),        bp: '—',                              sub: `${days} days`,   m1: fmt(prevGgr),     m1Bp: '—', status: null, delta: null },
    { label: 'Total Spend',   value: spendValue,        bp: bpSpend > 0 ? fmt(bpSpend) : '—', sub: spendSub,         m1: prevSpend > 0 ? fmt(prevSpend) : '—', m1Bp: prevBpSpend > 0 ? fmt(prevBpSpend) : '—', status: vsBp(totalSpend, bpSpend, true), delta: null },
    { label: 'Total Deposit', value: fmt(totalDeposit), bp: '—',                              sub: 'deposit amount', m1: fmt(prevDeposit), m1Bp: '—', status: null, delta: null },
    { label: 'Period Trend',
      value: trendValue,
      bp: null, sub: trendSub, m1: null, m1Bp: null, status: null,
      delta: trendDelta },
  ];

  const row = document.getElementById('kpiRow');
  row.innerHTML = kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-row-actual">
        <div><div class="kpi-mini-tag">ACT</div><div class="kpi-value ${k.status ? 'status-' + k.status : ''}">${k.value}</div></div>
        ${k.bp !== null ? `<div class="kpi-bp"><div class="kpi-mini-tag">BP</div><div class="kpi-bp-val">${k.bp}</div></div>` : ''}
      </div>
      <div class="kpi-sub">${k.sub}</div>
      ${k.m1 ? `<div class="kpi-m1"><span class="m1-tag">${m1Tag}</span> <span class="m1-val"><b>ACT</b> ${k.m1}${k.m1Bp ? `  ·  <b>BP</b> ${k.m1Bp}` : ''}</span></div>` : ''}
      ${k.delta ? `<span class="kpi-delta ${k.delta}">${k.delta === 'up' ? '▲' : '▼'} trend</span>` : ''}
    </div>
  `).join('');
}

function computeRoas(rows) {
  const spend = rows.reduce((s, d) => s + (d.spend || 0), 0);
  const ftd   = rows.reduce((s, d) => s + (d.ftd   || 0), 0);
  const d0    = rows.reduce((s, d) => s + (d.d0    || 0), 0);
  const d1    = rows.reduce((s, d) => s + (d.d1    || 0), 0);
  const ggr   = rows.reduce((s, d) => s + (d.ggr   || 0), 0);
  const bpSpend = rows.reduce((s, d) => s + (d.bpSpend || 0), 0);
  const bpFtd   = rows.reduce((s, d) => s + (d.bpFtd   || 0), 0);
  const bpD0    = rows.reduce((s, d) => s + (d.bpD0    || 0), 0);
  return {
    roasFtd:   spend ? ftd / spend : null,
    roasD0:    spend ? d0  / spend : null,
    roasD1:    spend ? (d0 + d1) / spend : null,
    invGgr:    ggr   ? spend / ggr : null,
    bpRoasFtd: bpSpend ? bpFtd / bpSpend : null,
    bpRoasD0:  bpSpend ? bpD0  / bpSpend : null,
  };
}

function renderRoasCards(data) {
  const fmtRoas = (n) => isFinite(n) && n !== null && n !== 0 ? n.toFixed(2) + 'x' : '—';

  const cur = computeRoas(data);
  const { prevLabel, prevData } = getPrevMonthSlice(data);
  const prev = computeRoas(prevData);
  const m1Tag = prevLabel ? `M-1 (${prevLabel})` : 'M-1';

  const pending = 'pending spend data';

  const cards = [
    { label: 'ROAS FTD',       value: fmtRoas(cur.roasFtd), bp: fmtRoas(cur.bpRoasFtd), sub: 'FTD amount / spend', ok: cur.roasFtd !== null, m1: fmtRoas(prev.roasFtd), m1Bp: fmtRoas(prev.bpRoasFtd), status: vsBp(cur.roasFtd, cur.bpRoasFtd) },
    { label: 'ROAS DEP (D0)',  value: fmtRoas(cur.roasD0),  bp: fmtRoas(cur.bpRoasD0),  sub: 'D0 deposit / spend', ok: cur.roasD0  !== null, m1: fmtRoas(prev.roasD0),  m1Bp: fmtRoas(prev.bpRoasD0),  status: vsBp(cur.roasD0,  cur.bpRoasD0) },
    { label: 'ROAS DEP (D+1)', value: fmtRoas(cur.roasD1),  bp: '—',                    sub: '(D0+D1) / spend',    ok: cur.roasD1  !== null, m1: fmtRoas(prev.roasD1),  m1Bp: '—', status: null },
    // Invest / GGR: lower is better (less spend per R$ of GGR)
    { label: 'Invest / GGR',   value: fmtRoas(cur.invGgr),  bp: '—',                    sub: 'spend / GGR',        ok: cur.invGgr  !== null, m1: fmtRoas(prev.invGgr),  m1Bp: '—', status: null },
  ];

  document.getElementById('roasRow').innerHTML = cards.map(c => `
    <div class="roas-card">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-row-actual">
        <div><div class="kpi-mini-tag">ACT</div><div class="kpi-value${c.ok ? '' : ' pending'} ${c.status ? 'status-' + c.status : ''}">${c.value}</div></div>
        <div class="kpi-bp"><div class="kpi-mini-tag">BP</div><div class="kpi-bp-val">${c.bp}</div></div>
      </div>
      <div class="kpi-sub">${c.sub}</div>
      <div class="kpi-m1"><span class="m1-tag">${m1Tag}</span> <span class="m1-val"><b>ACT</b> ${c.m1}  ·  <b>BP</b> ${c.m1Bp}</span></div>
    </div>
  `).join('');
}

function renderMainChart(data) {
  const labels = data.map(d => d.date);
  const values = data.map(d => d.ggr);
  const ma = movingAvg(values, 7);
  const showBars = document.getElementById('toggleBars').checked;
  const showMA   = document.getElementById('toggleMA').checked;

  const datasets = [];
  if (showBars) datasets.push({
    type: 'bar',
    label: 'Daily GGR',
    data: values,
    backgroundColor: 'rgba(108,99,255,0.35)',
    borderColor: 'rgba(108,99,255,0.7)',
    borderWidth: 1,
    borderRadius: 2,
    order: 2,
  });
  if (showMA) datasets.push({
    type: 'line',
    label: '7-day MA',
    data: ma,
    borderColor: '#00c896',
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.4,
    order: 1,
  });

  if (ggrChart) ggrChart.destroy();
  const ctx = document.getElementById('ggrChart').getContext('2d');
  ggrChart = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2e42',
          borderWidth: 1,
          titleColor: '#7c8098',
          bodyColor: '#e8eaf0',
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${fmtFull(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#7c8098',
            maxTicksLimit: 12,
            font: { size: 11 },
          },
          grid: { color: 'rgba(42,46,66,0.5)' },
        },
        y: {
          ticks: {
            color: '#7c8098',
            font: { size: 11 },
            callback: v => fmt(v),
          },
          grid: { color: 'rgba(42,46,66,0.5)' },
        },
      },
    },
  });
}

function renderMonthlyChart(data) {
  const map = monthlyAgg(data);
  const labels = Object.keys(map).map(k => {
    const [, m] = k.split('-');
    return MONTH_LABELS[parseInt(m) - 1];
  });
  const values = Object.values(map);

  if (monthlyChart) monthlyChart.destroy();
  const ctx = document.getElementById('monthlyChart').getContext('2d');
  monthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map((v, i) =>
          i === values.indexOf(Math.max(...values))
            ? 'rgba(0,200,150,0.7)'
            : 'rgba(108,99,255,0.5)'
        ),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2e42',
          borderWidth: 1,
          titleColor: '#7c8098',
          bodyColor: '#e8eaf0',
          callbacks: { label: ctx => fmtFull(ctx.parsed.y) },
        },
      },
      scales: {
        x: { ticks: { color: '#7c8098', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#7c8098', font: { size: 11 }, callback: v => fmt(v) },
             grid: { color: 'rgba(42,46,66,0.5)' } },
      },
    },
  });
}

function renderDowChart(data) {
  const avgs = dowAgg(data);
  if (dowChart) dowChart.destroy();
  const ctx = document.getElementById('dowChart').getContext('2d');
  dowChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: DOW_LABELS,
      datasets: [{
        data: avgs,
        backgroundColor: avgs.map((v, i) =>
          i === avgs.indexOf(Math.max(...avgs))
            ? 'rgba(0,200,150,0.7)'
            : 'rgba(108,99,255,0.5)'
        ),
        borderRadius: 4,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor: '#2a2e42',
          borderWidth: 1,
          titleColor: '#7c8098',
          bodyColor: '#e8eaf0',
          callbacks: { label: ctx => 'Avg: ' + fmtFull(ctx.parsed.y) },
        },
      },
      scales: {
        x: { ticks: { color: '#7c8098', font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#7c8098', font: { size: 11 }, callback: v => fmt(v) },
             grid: { color: 'rgba(42,46,66,0.5)' } },
      },
    },
  });
}

function renderVolumeCards(data) {
  const totalFtd = data.reduce((s, d) => s + (d.ftd || 0), 0);
  const totalD0  = data.reduce((s, d) => s + (d.d0  || 0), 0);
  // Full-month BP targets
  const { bpFtd, bpD0 } = fullMonthBp(data);

  const { prevLabel, prevData } = getPrevMonthSlice(data);
  const prevFtd = prevData.reduce((s, d) => s + (d.ftd || 0), 0);
  const prevD0  = prevData.reduce((s, d) => s + (d.d0  || 0), 0);
  const { bpFtd: prevBpFtd, bpD0: prevBpD0 } = fullMonthBp(prevData);
  const m1Tag = prevLabel ? `M-1 (${prevLabel})` : 'M-1';

  const cards = [
    {
      label: 'FTD AMOUNT',
      value: fmt(totalFtd),
      bp: bpFtd > 0 ? fmt(bpFtd) : '—',
      sub: 'sum of amount_ftd',
      m1: fmt(prevFtd),
      m1Bp: prevBpFtd > 0 ? fmt(prevBpFtd) : '—',
      status: vsBp(totalFtd, bpFtd),
    },
    {
      label: 'D0 DEPOSIT',
      value: fmt(totalD0),
      bp: bpD0 > 0 ? fmt(bpD0) : '—',
      sub: 'sum of D0 deposits',
      m1: fmt(prevD0),
      m1Bp: prevBpD0 > 0 ? fmt(prevBpD0) : '—',
      status: vsBp(totalD0, bpD0),
    },
    null, null, // empty slots to align with ROAS row
  ];

  document.getElementById('volumeRow').innerHTML = cards.map(c => {
    if (!c) return '<div></div>';
    return `
      <div class="roas-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-row-actual">
          <div><div class="kpi-mini-tag">ACT</div><div class="kpi-value ${c.status ? 'status-' + c.status : ''}">${c.value}</div></div>
          <div class="kpi-bp"><div class="kpi-mini-tag">BP</div><div class="kpi-bp-val">${c.bp}</div></div>
        </div>
        <div class="kpi-sub">${c.sub}</div>
        <div class="kpi-m1"><span class="m1-tag">${m1Tag}</span> <span class="m1-val"><b>ACT</b> ${c.m1}  ·  <b>BP</b> ${c.m1Bp}</span></div>
      </div>
    `;
  }).join('');
}

function render() {
  const raw  = filterData(activePeriod);
  const data = buildRenderData(raw, activeChannel);
  renderKPIs(data);
  renderRoasCards(data);
  renderVolumeCards(data);
}

document.getElementById('periodPills').addEventListener('click', e => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('#periodPills .pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  activePeriod = pill.dataset.period;
  // Clear custom range when picking a pill
  customRange = null;
  document.getElementById('dateFrom').value = '';
  document.getElementById('dateTo').value = '';
  render();
});

const dateFromEl = document.getElementById('dateFrom');
const dateToEl   = document.getElementById('dateTo');
const clearBtn   = document.getElementById('clearRange');

function applyDateRange() {
  const from = dateFromEl.value;
  const to   = dateToEl.value;
  if (from && to && from <= to) {
    customRange = { from, to };
    document.querySelectorAll('#periodPills .pill').forEach(p => p.classList.remove('active'));
    render();
  } else if (from && !to) {
    // Single date selected — wait for "to"
    return;
  } else {
    customRange = null;
    render();
  }
}

dateFromEl.addEventListener('change', applyDateRange);
dateToEl.addEventListener('change', applyDateRange);

clearBtn.addEventListener('click', () => {
  dateFromEl.value = '';
  dateToEl.value = '';
  customRange = null;
  document.querySelector('#periodPills .pill[data-period="all"]').classList.add('active');
  activePeriod = 'all';
  render();
});

document.getElementById('channelPills').addEventListener('click', e => {
  const pill = e.target.closest('.channel-pill');
  if (!pill) return;
  document.querySelectorAll('.channel-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  activeChannel = pill.dataset.channel;
  render();
});

const maToggle = document.getElementById('toggleMA');
if (maToggle) maToggle.addEventListener('change', render);
const barsToggle = document.getElementById('toggleBars');
if (barsToggle) barsToggle.addEventListener('change', render);

render();
