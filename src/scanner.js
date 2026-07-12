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

function applyPixelFilter(canvas, filter) {
  if (filter === 'color') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (filter === 'gray') {
      const v = Math.max(0, Math.min(255, (gray - 128) * 1.18 + 145));
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (filter === 'bw') {
      const v = gray > 158 ? 255 : gray < 92 ? 0 : (gray - 92) * 3.86;
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (filter === 'magic') {
      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i] = Math.min(255, (data[i] - avg) * 1.12 + avg * 1.08 + 8);
      data[i + 1] = Math.min(255, (data[i + 1] - avg) * 1.08 + avg * 1.08 + 8);
      data[i + 2] = Math.min(255, (data[i + 2] - avg) * 1.02 + avg * 1.08 + 5);
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export async function processPage(source, corners = defaultCorners(), filter = 'magic', rotation = 0, maxDimension = 1800) {
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
