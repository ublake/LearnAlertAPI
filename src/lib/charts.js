/**
 * Server-rendered inline SVG bar charts.
 *
 * No chart library and no CDN: the page is an ops tool that must render on a
 * flaky connection, and every value it plots is also in the table below it,
 * which is what lets the colours lean on labels rather than hue alone.
 */

function escapeXml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );
}

const WIDTH = 720;
const HEIGHT = 150;
const PAD = { top: 10, right: 6, bottom: 20, left: 44 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

// A 2px surface gap between stacked segments and between adjacent bars, so
// neighbouring fills never touch and read as one mass.
const GAP = 2;
const RADIUS = 4;

/**
 * A bar rounded only at its free end; the baseline end stays square so the
 * mark is anchored rather than floating.
 */
function barPath(x, y, w, h, round) {
  if (h <= 0) return "";

  const r = round ? Math.min(RADIUS, w / 2, h) : 0;

  if (r === 0) {
    return `M${x} ${y}h${w}v${h}h${-w}z`;
  }

  return `M${x} ${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}h${-w}z`;
}

function niceCeil(value) {
  if (value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;

  return step * magnitude;
}

/**
 * @param series - [{ key, label, color }] painted bottom-up in this order.
 * @param buckets - each carries a numeric value per series key.
 * @param formatValue - renders the axis ticks and tooltip figures.
 */
export function stackedBarChart({
  title,
  subtitle = "",
  buckets,
  series,
  formatValue,
  formatBucket,
  empty = "No calls in this range."
}) {
  if (!buckets.length) {
    return `<figure class="chart">
      <figcaption><span class="ct">${escapeXml(title)}</span></figcaption>
      <p class="chart-empty">${escapeXml(empty)}</p>
    </figure>`;
  }

  const totals = buckets.map((bucket) =>
    series.reduce((sum, item) => sum + (Number(bucket[item.key]) || 0), 0)
  );

  const peak = niceCeil(Math.max(...totals, 0));
  const slot = PLOT_W / buckets.length;
  const barW = Math.max(3, slot - GAP);

  const gridlines = [0, 0.5, 1]
    .map((fraction) => {
      const y = PAD.top + PLOT_H - fraction * PLOT_H;

      return `<line class="grid" x1="${PAD.left}" y1="${y}" x2="${WIDTH - PAD.right}" y2="${y}"/>
        <text class="axis" x="${PAD.left - 8}" y="${y + 3}" text-anchor="end">${escapeXml(
          formatValue(peak * fraction)
        )}</text>`;
    })
    .join("");

  const bars = buckets
    .map((bucket, index) => {
      const x = PAD.left + index * slot + GAP / 2;
      const readout = series
        .map(
          (item) =>
            `${item.label}: ${formatValue(Number(bucket[item.key]) || 0, true)}`
        )
        .join(" · ");
      const tip = `${formatBucket(bucket)} — ${readout}`;

      // Painted bottom-up; only the topmost non-empty segment is rounded.
      let cursor = PAD.top + PLOT_H;
      const topMost = [...series]
        .reverse()
        .find((item) => (Number(bucket[item.key]) || 0) > 0);

      const segments = series
        .map((item) => {
          const value = Number(bucket[item.key]) || 0;
          if (value <= 0) return "";

          const h = (value / peak) * PLOT_H;
          const y = cursor - h;
          cursor -= h + GAP;

          return `<path class="seg" fill="${item.color}" d="${barPath(
            x,
            y,
            barW,
            h,
            item.key === topMost?.key
          )}"/>`;
        })
        .join("");

      // A transparent full-height rect makes the whole column the hit target,
      // so an empty or tiny bucket is still hoverable.
      return `<g class="bar" tabindex="0" data-tip="${escapeXml(tip)}">
        ${segments}
        <rect class="hit" x="${x - GAP / 2}" y="${PAD.top}" width="${slot}" height="${PLOT_H}"/>
        <title>${escapeXml(tip)}</title>
      </g>`;
    })
    .join("");

  const first = formatBucket(buckets[0]);
  const last = formatBucket(buckets[buckets.length - 1]);

  const legend =
    series.length > 1
      ? `<ul class="legend">${series
          .map(
            (item) =>
              `<li><span class="key" style="background:${item.color}"></span>${escapeXml(
                item.label
              )}</li>`
          )
          .join("")}</ul>`
      : "";

  return `<figure class="chart">
    <figcaption>
      <span class="ct">${escapeXml(title)}</span>
      ${subtitle ? `<span class="cs">${escapeXml(subtitle)}</span>` : ""}
      ${legend}
    </figcaption>
    <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img"
         aria-label="${escapeXml(`${title}. ${first} to ${last}.`)}">
      ${gridlines}
      <line class="base" x1="${PAD.left}" y1="${PAD.top + PLOT_H}" x2="${WIDTH - PAD.right}" y2="${PAD.top + PLOT_H}"/>
      ${bars}
      <text class="axis" x="${PAD.left}" y="${HEIGHT - 6}">${escapeXml(first)}</text>
      <text class="axis" x="${WIDTH - PAD.right}" y="${HEIGHT - 6}" text-anchor="end">${escapeXml(
        last
      )}</text>
    </svg>
  </figure>`;
}

export const CHART_STYLES = `
  .charts { display: grid; gap: 14px; margin-bottom: 18px; }
  @media (min-width: 900px) {
    .charts { grid-template-columns: 1fr 1fr; }
    /* Three series need the width more than the two-series charts do. */
    .charts .wide { grid-column: 1 / -1; }
  }
  .chart {
    margin: 0; padding: 12px 14px 6px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--surface);
  }
  .chart figcaption {
    display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px;
    margin-bottom: 8px;
  }
  .chart .ct { font-size: 13px; font-weight: 600; color: var(--fg); }
  .chart .cs { font-size: 12px; color: var(--dim); }
  .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chart-empty {
    color: var(--dim); font-size: 13px; text-align: center; padding: 34px 0;
    margin: 0;
  }
  .legend {
    display: flex; gap: 10px; list-style: none; margin: 0 0 0 auto; padding: 0;
    font-size: 11px; color: var(--dim);
  }
  .legend li { display: flex; align-items: center; gap: 4px; }
  .legend .key { width: 9px; height: 9px; border-radius: 2px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .base { stroke: var(--baseline); stroke-width: 1; }
  .axis { fill: var(--muted); font-size: 10px; }
  .hit { fill: transparent; }
  .bar { outline: none; }
  .bar .seg { transition: opacity .12s ease; }
  .bar:hover .seg, .bar:focus-visible .seg { opacity: .72; }
  .bar:focus-visible .hit { stroke: var(--fg); stroke-width: 1.5; }
  #tip {
    position: fixed; z-index: 10; pointer-events: none; opacity: 0;
    transform: translate(-50%, -140%); transition: opacity .1s ease;
    background: var(--fg); color: var(--surface); font-size: 12px;
    padding: 5px 9px; border-radius: 6px; max-width: 320px;
  }
  #tip.on { opacity: 1; }
`;

/**
 * Labels come from our own aggregates, but they still go in through
 * textContent rather than innerHTML — a tooltip is not a template.
 */
export const CHART_SCRIPT = `
  (function () {
    var tip = document.getElementById("tip");
    if (!tip) return;

    function show(event) {
      var bar = event.target.closest(".bar");
      if (!bar) return;
      tip.textContent = bar.getAttribute("data-tip") || "";
      var box = bar.getBoundingClientRect();
      tip.style.left = (box.left + box.width / 2) + "px";
      tip.style.top = box.top + "px";
      tip.classList.add("on");
    }

    function hide() { tip.classList.remove("on"); }

    document.addEventListener("pointerover", show);
    document.addEventListener("pointerout", hide);
    document.addEventListener("focusin", show);
    document.addEventListener("focusout", hide);
  })();
`;
