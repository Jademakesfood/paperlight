export const defaultCorners = () => [
  { x: 0.035, y: 0.035 }, { x: 0.965, y: 0.035 },
  { x: 0.965, y: 0.965 }, { x: 0.035, y: 0.965 },
];

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function affine(ctx, s0, s1, s2, d0, d1, d2) {
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 0.01) return;
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / det;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / det;
  ctx.setTransform(a, b, c, d, e, f);
}

function bilinear(points, u, v) {
  const [tl, tr, br, bl] = points;
  return {
    x: (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x,
    y: (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y,
  };
}

function drawTriangle(ctx, image, source, destination) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(destination[0].x, destination[0].y);
  ctx.lineTo(destination[1].x, destination[1].y);
  ctx.lineTo(destination[2].x, destination[2].y);
  ctx.closePath();
  ctx.clip();
  affine(ctx, source[0], source[1], source[2], destination[0], destination[1], destination[2]);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function boxBlurGray(values, width, height, radius = 24) {
  const horizontal = new Float32Array(values.length); const output = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += values[y * width + Math.max(0, Math.min(width - 1, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / (radius * 2 + 1);
      sum += values[y * width + Math.min(width - 1, x + radius + 1)] - values[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += horizontal[Math.max(0, Math.min(height - 1, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / (radius * 2 + 1);
      sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x] - horizontal[Math.max(0, y - radius) * width + x];
    }
  }
  return output;
}

function applyPixelFilter(canvas, filter) {
  if (filter === 'color' || filter === 'original') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const mode = filter === 'magic' ? 'auto' : filter;
  let illumination;
  if (mode === 'shadow' || mode === 'bw' || mode === 'auto') {
    const grayValues = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) grayValues[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    illumination = boxBlurGray(grayValues, canvas.width, canvas.height, Math.max(12, Math.round(Math.min(canvas.width, canvas.height) / 38)));
  }
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const light = illumination?.[i / 4] || 128;
    if (mode === 'gray') {
      const v = Math.max(0, Math.min(255, (gray - 128) * 1.18 + 145));
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'bw') {
      const v = gray > light - 8 ? 255 : gray < light - 38 ? 0 : (gray - light + 38) * 8.5;
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'shadow') {
      const factor = 242 / Math.max(38, light);
      data[i] = Math.max(0, Math.min(255, (data[i] * factor - 120) * 1.22 + 145));
      data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] * factor - 120) * 1.22 + 145));
      data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] * factor - 120) * 1.22 + 145));
    } else if (mode === 'invert') {
      data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2];
    } else if (mode === 'lighten') {
      data[i] = Math.min(255, data[i] * 1.12 + 34); data[i + 1] = Math.min(255, data[i + 1] * 1.12 + 34); data[i + 2] = Math.min(255, data[i + 2] * 1.12 + 34);
    } else if (mode === 'enhance') {
      data[i] = Math.max(0, Math.min(255, (data[i] - 112) * 1.48 + 142)); data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - 112) * 1.48 + 142)); data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - 112) * 1.48 + 142));
    } else if (mode === 'eco') {
      const v = Math.max(0, Math.min(255, (gray - 128) * 0.95 + 151)); data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'auto') {
      const factor = Math.max(.72, Math.min(1.55, 226 / Math.max(45, light)));
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const balanced = avg * factor;
      data[i] = Math.max(0, Math.min(255, (data[i] - avg) * 1.18 + (balanced - 116) * 1.24 + 146));
      data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] - avg) * 1.12 + (balanced - 116) * 1.24 + 146));
      data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] - avg) * 1.06 + (balanced - 116) * 1.24 + 143));
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export async function processPage(source, corners = defaultCorners(), filter = 'auto', rotation = 0, maxDimension = 1800) {
  const image = await loadImage(source);
  const sourcePoints = corners.map((point) => ({ x: point.x * image.naturalWidth, y: point.y * image.naturalHeight }));
  let width = Math.max(distance(sourcePoints[0], sourcePoints[1]), distance(sourcePoints[3], sourcePoints[2]));
  let height = Math.max(distance(sourcePoints[0], sourcePoints[3]), distance(sourcePoints[1], sourcePoints[2]));
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  const warped = document.createElement('canvas');
  warped.width = width;
  warped.height = height;
  const ctx = warped.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  const steps = 14;
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const u0 = x / steps; const u1 = (x + 1) / steps;
      const v0 = y / steps; const v1 = (y + 1) / steps;
      const s00 = bilinear(sourcePoints, u0, v0); const s10 = bilinear(sourcePoints, u1, v0);
      const s11 = bilinear(sourcePoints, u1, v1); const s01 = bilinear(sourcePoints, u0, v1);
      const d00 = { x: u0 * width - 0.5, y: v0 * height - 0.5 };
      const d10 = { x: u1 * width + 0.5, y: v0 * height - 0.5 };
      const d11 = { x: u1 * width + 0.5, y: v1 * height + 0.5 };
      const d01 = { x: u0 * width - 0.5, y: v1 * height + 0.5 };
      drawTriangle(ctx, image, [s00, s10, s11], [d00, d10, d11]);
      drawTriangle(ctx, image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
  applyPixelFilter(warped, filter);

  const turns = ((rotation % 360) + 360) % 360;
  if (!turns) return warped.toDataURL('image/jpeg', 0.9);
  const output = document.createElement('canvas');
  output.width = turns === 90 || turns === 270 ? height : width;
  output.height = turns === 90 || turns === 270 ? width : height;
  const out = output.getContext('2d');
  out.translate(output.width / 2, output.height / 2);
  out.rotate(turns * Math.PI / 180);
  out.drawImage(warped, -width / 2, -height / 2);
  return output.toDataURL('image/jpeg', 0.9);
}

export async function makeThumbnail(source, size = 360) {
  const image = await loadImage(source);
  const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}
