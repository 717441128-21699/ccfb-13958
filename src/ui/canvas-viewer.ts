/**
 * 树芯画布查看器：
 *  - 绘制扫描图、测量条带、边界线（按来源/告警着色）、晚材带半透明覆盖
 *  - 滚轮以指针为锚缩放，拖拽平移
 *  - 左键拖动边界移动；双击空白新增边界；右键删除边界
 *  - 回调把毫米距离交给 store，store 重算后整体重绘
 */
import type { CoreSample, RingBoundary } from '../domain/types';
import { mmToPx } from '../domain/sample';

export interface ViewerCallbacks {
  onMoveBoundary: (id: string, distanceMm: number) => void;
  onAddBoundary: (distanceMm: number) => void;
  onRemoveBoundary: (id: string) => void;
  onSelect: (id: string | null) => void;
}

const FLAG_COLOR: Record<string, string> = {
  'false-ring': '#e6a700',
  'missing-ring': '#d62728',
  'weak-boundary': '#8c8c8c',
  'dating-mismatch': '#9467bd',
};

export class CoreCanvasViewer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;
  private sample: CoreSample | null = null;
  private cb: ViewerCallbacks;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private selectedId: string | null = null;
  private dragging: { id: string } | null = null;
  private panStart: { x: number; y: number; ox: number; oy: number } | null = null;
  private latewoodRanges: { start: number; end: number }[] = [];

  constructor(canvas: HTMLCanvasElement, cb: ViewerCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.cb = cb;
    this.bind();
  }

  setData(sample: CoreSample, img: HTMLImageElement, latewoodRanges: { start: number; end: number }[]): void {
    this.sample = sample;
    this.img = img;
    this.latewoodRanges = latewoodRanges;
    this.fit();
    this.draw();
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.draw();
  }

  /** 适配到画布宽度 */
  fit(): void {
    if (!this.img) return;
    const rect = this.canvas.getBoundingClientRect();
    this.scale = rect.width / this.img.naturalWidth;
    this.offsetX = 0;
    this.offsetY = (rect.height - this.img.naturalHeight * this.scale) / 2;
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    c.addEventListener('dblclick', this.onDblClick);
    c.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    const c = this.canvas;
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    c.removeEventListener('dblclick', this.onDblClick);
    c.removeEventListener('contextmenu', this.onContextMenu);
  }

  private toImageX(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return (clientX - rect.left - this.offsetX) / this.scale;
  }

  private toScreenX(imgX: number): number {
    return imgX * this.scale + this.offsetX;
  }

  private boundaryAt(clientX: number, tolerancePx = 8): RingBoundary | null {
    if (!this.sample) return null;
    const imgX = this.toImageX(clientX);
    let best: RingBoundary | null = null;
    let bestD = Infinity;
    for (const b of this.sample.boundaries) {
      const bx = mmToPx(this.sample, b.distance);
      const d = Math.abs(bx - imgX);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return bestD <= tolerancePx / this.scale ? best : null;
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const imgX = (mx - this.offsetX) / this.scale;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    this.scale = Math.min(40, Math.max(0.2, this.scale * factor));
    this.offsetX = mx - imgX * this.scale;
    this.draw();
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.sample || e.button !== 0) return;
    const hit = this.boundaryAt(e.clientX);
    if (hit) {
      this.dragging = { id: hit.id };
      this.selectedId = hit.id;
      this.cb.onSelect(hit.id);
      this.draw();
    } else {
      this.panStart = { x: e.clientX, y: e.clientY, ox: this.offsetX, oy: this.offsetY };
      this.selectedId = null;
      this.cb.onSelect(null);
      this.draw();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.dragging && this.sample) {
      const imgX = Math.max(0, this.toImageX(e.clientX));
      const mm = imgX * this.sample.scaleMmPerPx + this.sample.offsetMm;
      this.cb.onMoveBoundary(this.dragging.id, mm);
    } else if (this.panStart) {
      this.offsetX = this.panStart.ox + (e.clientX - this.panStart.x);
      this.offsetY = this.panStart.oy + (e.clientY - this.panStart.y);
      this.draw();
    }
    if (this.dragging) this.canvas.style.cursor = 'ew-resize';
    else this.canvas.style.cursor = this.boundaryAt(e.clientX) ? 'ew-resize' : 'grab';
  };

  private onMouseUp = (): void => {
    this.dragging = null;
    this.panStart = null;
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!this.sample) return;
    if (this.boundaryAt(e.clientX, 4)) return;
    const imgX = Math.max(0, this.toImageX(e.clientX));
    const mm = imgX * this.sample.scaleMmPerPx + this.sample.offsetMm;
    this.cb.onAddBoundary(mm);
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const hit = this.boundaryAt(e.clientX);
    if (hit) this.cb.onRemoveBoundary(hit.id);
  };

  draw(): void {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width !== Math.round(rect.width) || this.canvas.height !== Math.round(rect.height)) {
      this.canvas.width = Math.round(rect.width);
      this.canvas.height = Math.round(rect.height);
    }
    ctx.fillStyle = '#1c1f24';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.img || !this.sample) return;

    const w = this.img.naturalWidth * this.scale;
    const h = this.img.naturalHeight * this.scale;
    ctx.drawImage(this.img, this.offsetX, this.offsetY, w, h);

    // 晚材带半透明覆盖
    ctx.fillStyle = 'rgba(90, 140, 255, 0.18)';
    for (const r of this.latewoodRanges) {
      ctx.fillRect(this.toScreenX(r.start), this.offsetY, (r.end - r.start) * this.scale, h);
    }

    // 测量条带框
    const bandH = this.sample.bandHalfHeightPx * 2 * this.scale;
    const bandY = this.offsetY + (this.sample.pathY - this.sample.bandHalfHeightPx) * this.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(this.offsetX, bandY, w, bandH);
    ctx.setLineDash([]);

    // 边界线
    for (const b of this.sample.boundaries) {
      const x = this.toScreenX(mmToPx(this.sample, b.distance));
      const flag = b.flags[0];
      let color = '#2ecc71';
      if (b.origin === 'manual') color = '#3498db';
      if (b.origin === 'adjusted') color = '#f1c40f';
      if (flag) color = FLAG_COLOR[flag.type] ?? color;
      ctx.strokeStyle = color;
      ctx.lineWidth = b.id === this.selectedId ? 2.6 : 1.3;
      ctx.beginPath();
      ctx.moveTo(x, this.offsetY);
      ctx.lineTo(x, this.offsetY + h);
      ctx.stroke();
      if (b.flags.length > 0) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, this.offsetY + 9, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 比例尺（1 mm）
    const mmPx = 1 / this.sample.scaleMmPerPx;
    const sx = 12;
    const sy = this.canvas.height - 14;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + mmPx * this.scale, sy);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '12px system-ui';
    ctx.fillText('1 mm', sx, sy - 5);
  }
}
