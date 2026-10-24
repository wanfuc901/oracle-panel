const GRID_FRACTIONS = [0.25, 0.5, 0.75];
const LINE_WIDTH = 1.5;
const FILL_ALPHA = 0.12;
const LABEL_FONT_PX = 10;
const NICE_STEPS = [1, 2, 2.5, 5, 10];

function readToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Smallest "round" number (1, 2, 2.5, 5 × 10^n) at or above value, so the axis label reads cleanly. */
function niceCeiling(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((candidate) => candidate * magnitude >= value);
  return step * magnitude;
}

function withAlpha(hexColor, alpha) {
  const channel = (offset) => parseInt(hexColor.slice(offset, offset + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`;
}

/**
 * Time-series line chart on a canvas. `series` = [{ key, colorToken }]; `fixedMax` pins the
 * y-axis (e.g. 100 for percentages), otherwise it auto-scales to a nice ceiling.
 */
export class LineChart {
  constructor(canvas, { series, fixedMax = null, formatMax, capacity }) {
    this.canvas = canvas;
    this.series = series.map((entry) => ({ ...entry, color: readToken(entry.colorToken) }));
    this.fixedMax = fixedMax;
    this.formatMax = formatMax;
    this.capacity = capacity;
    this.points = [];
    this.gridColor = readToken('--rule');
    this.labelColor = readToken('--ink-faint');
    this.labelFont = `${LABEL_FONT_PX}px ${readToken('--font-mono')}`;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);
  }

  update(points) {
    this.points = points;
    this.draw();
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  draw() {
    const { canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const yMax = this.fixedMax ?? niceCeiling(Math.max(0, ...this.points.flatMap((point) => this.series.map((s) => point[s.key]))));
    this.drawGrid(ctx, width, height, yMax);
    for (const entry of this.series) this.drawSeries(ctx, width, height, yMax, entry);
  }

  drawGrid(ctx, width, height, yMax) {
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const fraction of GRID_FRACTIONS) {
      const y = Math.round(height * fraction) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    ctx.fillStyle = this.labelColor;
    ctx.font = this.labelFont;
    ctx.textBaseline = 'top';
    ctx.fillText(this.formatMax(yMax), 2, 1);
  }

  drawSeries(ctx, width, height, yMax, { key, color }) {
    const { points, capacity } = this;
    if (points.length < 2) return;
    // Right-aligned: the newest sample sits at the right edge, empty history leaves the left blank.
    const xStep = width / (capacity - 1);
    const xStart = width - (points.length - 1) * xStep;
    const toY = (value) => height - (Math.min(value, yMax) / yMax) * (height - 2) - 1;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xStart + index * xStep;
      if (index === 0) ctx.moveTo(x, toY(point[key]));
      else ctx.lineTo(x, toY(point[key]));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.stroke();
    ctx.lineTo(width, height);
    ctx.lineTo(xStart, height);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, FILL_ALPHA);
    ctx.fill();
  }
}
