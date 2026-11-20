// 测线( transect )重采样与图像密度剖面提取
export interface Pt { x: number; y: number; }

/** 折线按均匀弧长重采样,返回采样点与切向 */
export function resamplePolyline(pts: Pt[], step = 1): { pts: Pt[]; dirs: Pt[] } {
  const out: Pt[] = [], dirs: Pt[] = [];
  if (pts.length < 2) return { pts: out, dirs };
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const L = cum[cum.length - 1];
  let seg = 0;
  for (let d = 0; d <= L; d += step) {
    while (seg < pts.length - 2 && cum[seg + 1] < d) seg++;
    const a = pts[seg], b = pts[seg + 1];
    const segLen = cum[seg + 1] - cum[seg] || 1e-9;
    const t = (d - cum[seg]) / segLen;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    dirs.push({ x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen });
  }
  return { pts: out, dirs };
}

function bilinearLum(data: Uint8ClampedArray, W: number, H: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) return -1;
  const fx = x - x0, fy = y - y0;
  const lum = (ix: number, iy: number) => {
    const p = (iy * W + ix) * 4;
    return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  };
  return lum(x0, y0) * (1 - fx) * (1 - fy) + lum(x0 + 1, y0) * fx * (1 - fy)
       + lum(x0, y0 + 1) * (1 - fx) * fy + lum(x0 + 1, y0 + 1) * fx * fy;
}

/**
 * 沿测线提取密度剖面(255-亮度,晚材值高)。
 * 每个采样点在测线法向 ±bandHalf 像素带宽内取平均以压制噪声。
 */
export function sampleProfile(
  img: ImageData, line: Pt[], bandHalf = 8,
): { density: Float64Array; pts: Pt[]; dirs: Pt[] } {
  const { pts, dirs } = resamplePolyline(line, 1);
  const n = pts.length;
  const density = new Float64Array(n);
  const data = img.data, W = img.width, H = img.height;
  for (let i = 0; i < n; i++) {
    const nx = -dirs[i].y, ny = dirs[i].x;
    let sum = 0, cnt = 0;
    for (let o = -bandHalf; o <= bandHalf; o++) {
      const lum = bilinearLum(data, W, H, pts[i].x + nx * o, pts[i].y + ny * o);
      if (lum >= 0) { sum += lum; cnt++; }
    }
    density[i] = cnt ? 255 - sum / cnt : 0;
  }
  return { density, pts, dirs };
}
