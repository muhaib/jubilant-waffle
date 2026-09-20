/*
 * Charts.
 *
 * Hand-built SVG, no charting library. Two forms only, because the dashboard
 * has exactly two jobs to do: change over time (area) and comparison across
 * periods (grouped bars).
 *
 * The categorical order is fixed and validated for colour-vision deficiency;
 * it is never cycled or reassigned when a series is filtered out, so a colour
 * always means the same measure.
 */
import { el, clear } from './ui.js';
import { money, moneyShort, dateOnly } from './format.js';

export const SERIES = {
  withdrawn: { color: '#c2410c', label: 'Withdrawn' },
  deposited: { color: '#2f6fbf', label: 'Deposited' },
  profit: { color: '#15803d', label: 'Realised profit' },
  balance: { color: '#2f6fbf', label: 'Available balance' },
  volume: { color: '#2f6fbf', label: 'Verified deposits' },
};

const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

/**
 * Axis ticks from 0 to at least `max`.
 *
 * The final tick must be >= max, or the top of the scale sits below the
 * largest value and that value is drawn outside the plot area.
 */
function niceTicks(max, count = 4, minStep = 100) {
  if (!(max > 0)) return [0, minStep];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  // Never step in fractions of a dollar: five ticks all reading "$0" tell the
  // reader nothing.
  const step = Math.max(
    minStep,
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) || magnitude * 10,
  );
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  return node;
}

function chartEmpty(host, { title, body }) {
  clear(host).append(el('div', { class: 'chart-empty' }, [
    el('div', {}, [el('strong', { text: title }), el('span', { text: body })]),
  ]));
}

function legend(keys) {
  return el('div', { class: 'chart-legend' }, keys.map((k) => el('span', { class: 'key' }, [
    el('span', { class: 'swatch', style: `background:${k.color}` }),
    el('span', { text: k.label }),
  ])));
}

function tooltipNode(host) {
  let tip = host.querySelector('.chart-tooltip');
  if (!tip) { tip = el('div', { class: 'chart-tooltip' }); host.append(tip); }
  return tip;
}

/**
 * Area + line chart for a single measure over time.
 * `data`: [{ date, value }] with value in cents.
 */
export function areaChart(host, data, {
  height = 220, series = SERIES.balance,
  emptyTitle = 'No activity yet',
  emptyBody = 'This chart fills in as money moves through your account.',
} = {}) {
  host.classList.add('chart');
  // A series of nothing but zeros is an empty state, not a flat line at the
  // bottom of an axis whose every tick reads the same.
  const hasSignal = data?.some((d) => Math.abs(Number(d.value) || 0) > 0);
  if (!data || data.length === 0 || !hasSignal) {
    return chartEmpty(host, { title: emptyTitle, body: emptyBody });
  }

  clear(host);
  const width = Math.max(host.clientWidth || 640, 280);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const values = data.map((d) => Number(d.value) || 0);
  const maxValue = Math.max(...values, 1);
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1];

  const x = (i) => (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v) => innerH - (v / top) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `${series.label} over time` });
  const plot = svgEl('g', { transform: `translate(${PAD.left},${PAD.top})` });

  for (const t of ticks) {
    plot.append(svgEl('line', { class: 'grid-line', x1: 0, x2: innerW, y1: y(t), y2: y(t) }));
    const label = svgEl('text', { class: 'axis-text', x: -10, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = moneyShort(t);
    plot.append(label);
  }

  // A one-point series has no line to draw, so it gets a short level segment
  // through the point instead of an invisible zero-length path.
  const single = data.length === 1;
  const spanStart = single ? Math.max(0, x(0) - innerW * 0.18) : x(0);
  const spanEnd = single ? Math.min(innerW, x(0) + innerW * 0.18) : x(data.length - 1);
  const linePath = single
    ? `M${spanStart.toFixed(2)},${y(values[0]).toFixed(2)} L${spanEnd.toFixed(2)},${y(values[0]).toFixed(2)}`
    : data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(values[i]).toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L${spanEnd.toFixed(2)},${innerH} L${spanStart.toFixed(2)},${innerH} Z`;

  const gradientId = `grad-${Math.random().toString(36).slice(2, 8)}`;
  const defs = svgEl('defs');
  const gradient = svgEl('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(svgEl('stop', { offset: '0%', 'stop-color': series.color, 'stop-opacity': 0.18 }));
  gradient.append(svgEl('stop', { offset: '100%', 'stop-color': series.color, 'stop-opacity': 0.01 }));
  defs.append(gradient);
  svg.append(defs);

  plot.append(svgEl('path', { class: 'series-area', d: areaPath, fill: `url(#${gradientId})` }));
  plot.append(svgEl('path', { class: 'series-line', d: linePath, stroke: series.color }));
  plot.append(svgEl('line', { class: 'axis-line', x1: 0, x2: innerW, y1: innerH, y2: innerH }));

  // X labels: first, middle and last only, so they never collide.
  const labelIndices = data.length <= 2 ? data.map((_, i) => i)
    : [0, Math.floor((data.length - 1) / 2), data.length - 1];
  for (const i of labelIndices) {
    const t = svgEl('text', {
      class: 'axis-text', x: x(i), y: innerH + 18,
      'text-anchor': i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle',
    });
    t.textContent = dateOnly(data[i].date).replace(/ \d{4}$/, '');
    plot.append(t);
  }

  // With a single reading, label it directly — there is no trend to trace.
  if (single) {
    plot.append(svgEl('circle', {
      class: 'point', cx: x(0), cy: y(values[0]), r: 5, fill: series.color,
    }));
    const label = svgEl('text', {
      class: 'direct-label', x: x(0), y: y(values[0]) - 14, 'text-anchor': 'middle',
    });
    label.textContent = money(values[0]);
    plot.append(label);
  }

  // Hover layer: crosshair, a ringed point and a tooltip.
  const crosshair = svgEl('line', { class: 'crosshair', y1: 0, y2: innerH, opacity: 0 });
  const marker = svgEl('circle', { class: 'point', r: 5, fill: series.color, opacity: 0 });
  plot.append(crosshair, marker);

  const hit = svgEl('rect', { class: 'hit', x: 0, y: 0, width: innerW, height: innerH });
  plot.append(hit);
  svg.append(plot);
  host.append(svg);

  const tip = tooltipNode(host);
  const show = (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const px = (event.clientX - rect.left) * scale - PAD.left;
    const index = data.length === 1 ? 0
      : Math.max(0, Math.min(data.length - 1, Math.round((px / innerW) * (data.length - 1))));
    const cx = x(index);
    const cy = y(values[index]);
    crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx); crosshair.setAttribute('opacity', 1);
    marker.setAttribute('cx', cx); marker.setAttribute('cy', cy); marker.setAttribute('opacity', 1);
    clear(tip).append(
      el('div', { class: 'tt-title', text: dateOnly(data[index].date) }),
      el('div', { class: 'tt-row' }, [
        el('span', { class: 'swatch', style: `background:${series.color}` }),
        el('span', { text: series.label }),
        el('span', { class: 'tt-value', text: money(values[index]) }),
      ]),
    );
    tip.style.left = `${((cx + PAD.left) / scale)}px`;
    tip.style.top = `${((cy + PAD.top) / scale) - 10}px`;
    tip.classList.add('on');
  };
  const hide = () => {
    crosshair.setAttribute('opacity', 0);
    marker.setAttribute('opacity', 0);
    tip.classList.remove('on');
  };
  hit.addEventListener('mousemove', show);
  hit.addEventListener('mouseleave', hide);
  hit.addEventListener('touchstart', (e) => show(e.touches[0]), { passive: true });
  hit.addEventListener('touchmove', (e) => show(e.touches[0]), { passive: true });
  hit.addEventListener('touchend', hide);
}

/**
 * Grouped bars. `groups`: [{ label, values: { key: cents } }].
 * `keys`: ordered array of SERIES keys — the order is fixed, never cycled.
 */
export function groupedBars(host, groups, keys, {
  height = 240,
  emptyTitle = 'Nothing to compare yet',
  emptyBody = 'Once deposits and withdrawals are settled they are summarised here by month.',
} = {}) {
  host.classList.add('chart');
  const hasData = groups?.some((g) => keys.some((k) => Math.abs(g.values[k] || 0) > 0));
  if (!hasData) return chartEmpty(host, { title: emptyTitle, body: emptyBody });

  clear(host);
  const defs = keys.map((k) => SERIES[k]);
  host.append(legend(defs));

  const width = Math.max(host.clientWidth || 640, 280);
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const maxValue = Math.max(1, ...groups.flatMap((g) => keys.map((k) => Math.abs(g.values[k] || 0))));
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1];
  const y = (v) => innerH - (Math.abs(v) / top) * innerH;

  const groupW = innerW / groups.length;
  const GAP = 2;                                   // 2px surface gap between adjacent bars
  const barW = Math.max(4, Math.min(22, (groupW * 0.7 - GAP * (keys.length - 1)) / keys.length));
  const clusterW = barW * keys.length + GAP * (keys.length - 1);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `${defs.map((d) => d.label).join(', ')} by month` });
  const plot = svgEl('g', { transform: `translate(${PAD.left},${PAD.top})` });

  for (const t of ticks) {
    plot.append(svgEl('line', { class: 'grid-line', x1: 0, x2: innerW, y1: y(t), y2: y(t) }));
    const label = svgEl('text', { class: 'axis-text', x: -10, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = moneyShort(t);
    plot.append(label);
  }

  const tip = tooltipNode(host);
  groups.forEach((group, gi) => {
    const groupX = gi * groupW + (groupW - clusterW) / 2;
    keys.forEach((key, ki) => {
      const value = Math.abs(group.values[key] || 0);
      const barX = groupX + ki * (barW + GAP);
      const barY = y(value);
      const barH = Math.max(value > 0 ? 2 : 0, innerH - barY);
      if (barH === 0) return;
      const rect = svgEl('rect', {
        class: 'bar', x: barX, y: barY, width: barW, height: barH, fill: SERIES[key].color,
      });
      rect.addEventListener('mouseenter', () => {
        clear(tip).append(
          el('div', { class: 'tt-title', text: group.label }),
          ...keys.map((k) => el('div', { class: 'tt-row' }, [
            el('span', { class: 'swatch', style: `background:${SERIES[k].color}` }),
            el('span', { text: SERIES[k].label }),
            el('span', { class: 'tt-value', text: money(group.values[k] || 0) }),
          ])),
        );
        const rectBox = svg.getBoundingClientRect();
        const scale = width / rectBox.width;
        tip.style.left = `${(barX + PAD.left + barW / 2) / scale}px`;
        tip.style.top = `${(barY + PAD.top) / scale - 8}px`;
        tip.classList.add('on');
      });
      rect.addEventListener('mouseleave', () => tip.classList.remove('on'));
      plot.append(rect);
    });

    const label = svgEl('text', {
      class: 'axis-text', x: gi * groupW + groupW / 2, y: innerH + 18, 'text-anchor': 'middle',
    });
    label.textContent = group.label;
    plot.append(label);
  });

  plot.append(svgEl('line', { class: 'axis-line', x1: 0, x2: innerW, y1: innerH, y2: innerH }));
  svg.append(plot);
  host.append(svg);
}

/** Re-render on container resize so the chart is never letterboxed or clipped. */
export function responsive(host, render) {
  render();
  if (typeof ResizeObserver === 'undefined') return;
  let lastWidth = host.clientWidth;
  const observer = new ResizeObserver(() => {
    if (Math.abs(host.clientWidth - lastWidth) < 12) return;
    lastWidth = host.clientWidth;
    render();
  });
  observer.observe(host);
}
