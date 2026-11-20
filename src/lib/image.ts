/**
 * 图像编解码（浏览器端 Canvas）：灰度数组 → PNG dataURL；扫描图文件 → 灰度与尺寸。
 */

/** 灰度位图转 PNG dataURL */
export function grayToPngDataUrl(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

export interface LoadedImage {
  dataUrl: string;
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 读取图片文件为灰度数组 */
export function loadImageFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const gray = new Uint8ClampedArray(canvas.width * canvas.height);
      for (let i = 0; i < gray.length; i++) {
        // ITU-R BT.601 亮度
        gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
      }
      URL.revokeObjectURL(url);
      resolve({
        dataUrl: URL.createObjectURL(file),
        gray,
        width: canvas.width,
        height: canvas.height,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}
