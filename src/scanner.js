import { prepareDetector } from './detector.js';

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

function meshWarp(image, sourcePoints, width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  const steps = 18;
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const u0 = x / steps; const u1 = (x + 1) / steps; const v0 = y / steps; const v1 = (y + 1) / steps;
      const s00 = bilinear(sourcePoints, u0, v0); const s10 = bilinear(sourcePoints, u1, v0);
      const s11 = bilinear(sourcePoints, u1, v1); const s01 = bilinear(sourcePoints, u0, v1);
      const d00 = { x: u0 * width - 0.5, y: v0 * height - 0.5 }; const d10 = { x: u1 * width + 0.5, y: v0 * height - 0.5 };
      const d11 = { x: u1 * width + 0.5, y: v1 * height + 0.5 }; const d01 = { x: u0 * width - 0.5, y: v1 * height + 0.5 };
      drawTriangle(ctx, image, [s00, s10, s11], [d00, d10, d11]); drawTriangle(ctx, image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
  return canvas;
}

async function projectiveWarp(image, sourcePoints, width, height, outputScale) {
  const cv = await prepareDetector(); const padding = Math.max(2, 5 / Math.max(.05, outputScale));
  const left = Math.max(0, Math.floor(Math.min(...sourcePoints.map((point) => point.x)) - padding));
  const top = Math.max(0, Math.floor(Math.min(...sourcePoints.map((point) => point.y)) - padding));
  const right = Math.min(image.naturalWidth, Math.ceil(Math.max(...sourcePoints.map((point) => point.x)) + padding));
  const bottom = Math.min(image.naturalHeight, Math.ceil(Math.max(...sourcePoints.map((point) => point.y)) + padding));
  const cropWidth = Math.max(1, right - left); const cropHeight = Math.max(1, bottom - top);
  const input = document.createElement('canvas'); input.width = Math.max(1, Math.round(cropWidth * outputScale)); input.height = Math.max(1, Math.round(cropHeight * outputScale));
  const inputContext = input.getContext('2d', { alpha: false }); inputContext.imageSmoothingEnabled = true; inputContext.imageSmoothingQuality = 'high';
  inputContext.drawImage(image, left, top, cropWidth, cropHeight, 0, 0, input.width, input.height);
  const adjusted = sourcePoints.flatMap((point) => [(point.x - left) * outputScale, (point.y - top) * outputScale]);
  const source = cv.imread(input); const destination = new cv.Mat();
  const sourceQuad = cv.matFromArray(4, 1, cv.CV_32FC2, adjusted);
  const destinationQuad = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
  const transform = cv.getPerspectiveTransform(sourceQuad, destinationQuad); const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    cv.warpPerspective(source, destination, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar(255, 255, 255, 255));
    cv.imshow(canvas, destination); return canvas;
  } finally { source.delete(); destination.delete(); sourceQuad.delete(); destinationQuad.delete(); transform.delete(); }
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

const clampByte = (value) => Math.max(0, Math.min(255, value));

function grayLevels(values) {
  const histogram = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) histogram[values[index]] += 1;
  const at = (ratio) => {
    const target = values.length * ratio; let count = 0;
    for (let value = 0; value < 256; value += 1) { count += histogram[value]; if (count >= target) return value; }
    return 255;
  };
  const low = at(.015); const high = at(.985);
  return high - low < 45 ? { low: Math.max(0, low - 24), high: Math.min(255, high + 24) } : { low, high };
}

function applyPixelFilter(canvas, filter) {
  if (filter === 'color' || filter === 'original') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const mode = filter === 'magic' ? 'auto' : filter;
  const grayValues = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) grayValues[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const { low, high } = grayLevels(grayValues); const range = Math.max(32, high - low);
  const needsIllumination = mode === 'shadow' || mode === 'bw' || mode === 'auto';
  const needsDetail = mode === 'shadow' || mode === 'bw' || mode === 'auto' || mode === 'enhance' || mode === 'gray';
  const illumination = needsIllumination ? boxBlurGray(grayValues, canvas.width, canvas.height, Math.max(14, Math.round(Math.min(canvas.width, canvas.height) / 34))) : null;
  const detailBase = needsDetail ? boxBlurGray(grayValues, canvas.width, canvas.height, 1) : null;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const light = illumination?.[p] || 220; const detail = detailBase ? gray - detailBase[p] : 0;
    const leveled = clampByte((gray - low) * 255 / range); const local = clampByte(gray * 238 / Math.max(38, light));
    if (mode === 'gray') {
      const v = clampByte((leveled - 128) * 1.06 + 139 + detail * .72);
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'bw') {
      const v = clampByte((gray - light + 40 + detail * .45) * 8.5);
      data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'shadow') {
      const target = clampByte((local - 128) * 1.12 + 151 + detail * .38); const delta = target - gray;
      data[i] = clampByte(data[i] + delta); data[i + 1] = clampByte(data[i + 1] + delta); data[i + 2] = clampByte(data[i + 2] + delta);
    } else if (mode === 'invert') {
      data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2];
    } else if (mode === 'lighten') {
      data[i] = clampByte(data[i] * 1.1 + 31); data[i + 1] = clampByte(data[i + 1] * 1.1 + 31); data[i + 2] = clampByte(data[i + 2] * 1.1 + 31);
    } else if (mode === 'enhance') {
      const target = clampByte((leveled - 128) * 1.18 + 137 + detail * .9); const delta = target - gray; const average = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i] = clampByte(data[i] + delta + (data[i] - average) * .08); data[i + 1] = clampByte(data[i + 1] + delta + (data[i + 1] - average) * .08); data[i + 2] = clampByte(data[i + 2] + delta + (data[i + 2] - average) * .08);
    } else if (mode === 'eco') {
      const v = clampByte((leveled - 128) * .88 + 154); data[i] = data[i + 1] = data[i + 2] = v;
    } else if (mode === 'auto') {
      const target = clampByte((local - 128) * 1.19 + 145 + detail * .62); const delta = target - gray; const average = (data[i] + data[i + 1] + data[i + 2]) / 3;
      data[i] = clampByte(data[i] + delta + (data[i] - average) * .045); data[i + 1] = clampByte(data[i + 1] + delta + (data[i + 1] - average) * .045); data[i + 2] = clampByte(data[i + 2] + delta + (data[i + 2] - average) * .045);
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

  let warped;
  try { warped = await projectiveWarp(image, sourcePoints, width, height, scale); }
  catch (error) { console.warn('Perspective engine unavailable; using compatibility warp', error); warped = meshWarp(image, sourcePoints, width, height); }
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
