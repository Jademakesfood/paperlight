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

function oddBlockSize(width, height, divisor = 28) {
  const smallest = Math.min(width, height);
  let size = Math.max(15, Math.min(71, Math.round(smallest / divisor)));
  if (size % 2 === 0) size += 1;
  const maximum = Math.max(3, (smallest - 1) | 1);
  return Math.max(3, Math.min(size, maximum));
}

function normalizeIllumination(cv, lightness, destination) {
  const scale = Math.min(1, 280 / Math.max(lightness.cols, lightness.rows));
  const small = new cv.Mat(); const background = new cv.Mat(); const fullBackground = new cv.Mat();
  const closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  try {
    cv.resize(lightness, small, new cv.Size(Math.max(1, Math.round(lightness.cols * scale)), Math.max(1, Math.round(lightness.rows * scale))), 0, 0, cv.INTER_AREA);
    cv.morphologyEx(small, background, cv.MORPH_CLOSE, closeKernel, new cv.Point(-1, -1), 2);
    const blurSize = oddBlockSize(background.cols, background.rows, 7);
    cv.GaussianBlur(background, background, new cv.Size(blurSize, blurSize), 0, 0, cv.BORDER_REPLICATE);
    cv.resize(background, fullBackground, new cv.Size(lightness.cols, lightness.rows), 0, 0, cv.INTER_CUBIC);
    cv.divide(lightness, fullBackground, destination, 238);
  } finally { small.delete(); background.delete(); fullBackground.delete(); closeKernel.delete(); }
}

function sharpen(cv, source, destination, strength = .55, lift = 2) {
  const blurred = new cv.Mat();
  try {
    cv.GaussianBlur(source, blurred, new cv.Size(0, 0), 1.15, 1.15, cv.BORDER_REPLICATE);
    cv.addWeighted(source, 1 + strength, blurred, -strength, lift, destination);
  } finally { blurred.delete(); }
}

function adjustLightness(cv, rgb, destination, operation) {
  const lab = new cv.Mat(); const channels = new cv.MatVector(); const mergedChannels = new cv.MatVector(); const merged = new cv.Mat();
  let lightness; let firstColor; let secondColor; const adjusted = new cv.Mat();
  try {
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); cv.split(lab, channels);
    lightness = channels.get(0); firstColor = channels.get(1); secondColor = channels.get(2);
    operation(lightness, adjusted);
    mergedChannels.push_back(adjusted); mergedChannels.push_back(firstColor); mergedChannels.push_back(secondColor);
    cv.merge(mergedChannels, merged); cv.cvtColor(merged, destination, cv.COLOR_Lab2RGB);
  } finally {
    lab.delete(); channels.delete(); mergedChannels.delete(); merged.delete(); adjusted.delete();
    lightness?.delete(); firstColor?.delete(); secondColor?.delete();
  }
}

function adaptivePaperThreshold(cv, source, destination, contrast = 11) {
  const smoothed = new cv.Mat(); const detailed = new cv.Mat();
  try {
    cv.medianBlur(source, smoothed, 3); sharpen(cv, smoothed, detailed, .48, 1);
    cv.adaptiveThreshold(detailed, destination, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, oddBlockSize(source.cols, source.rows), contrast);
  } finally { smoothed.delete(); detailed.delete(); }
}

export async function applyScannerFilter(canvas, filter) {
  const mode = filter === 'magic' ? 'auto' : filter;
  if (mode === 'color' || mode === 'original') return canvas;
  const cv = await prepareDetector(); const source = cv.imread(canvas); const rgb = new cv.Mat(); const output = new cv.Mat(); const shown = new cv.Mat();
  try {
    cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);
    if (mode === 'invert') {
      cv.bitwise_not(rgb, output);
    } else if (mode === 'lighten') {
      rgb.convertTo(output, -1, 1.06, 24);
    } else if (mode === 'shadow') {
      adjustLightness(cv, rgb, output, (lightness, adjusted) => {
        const normalized = new cv.Mat();
        try { normalizeIllumination(cv, lightness, normalized); cv.addWeighted(normalized, .9, lightness, .1, 4, adjusted); }
        finally { normalized.delete(); }
      });
    } else if (mode === 'enhance') {
      adjustLightness(cv, rgb, output, (lightness, adjusted) => {
        const equalized = new cv.Mat(); const balanced = new cv.Mat();
        try { cv.equalizeHist(lightness, equalized); cv.addWeighted(lightness, .72, equalized, .28, 4, balanced); sharpen(cv, balanced, adjusted, .4, 2); }
        finally { equalized.delete(); balanced.delete(); }
      });
    } else if (mode === 'auto') {
      adjustLightness(cv, rgb, output, (lightness, adjusted) => {
        const normalized = new cv.Mat(); const balanced = new cv.Mat();
        try {
          normalizeIllumination(cv, lightness, normalized);
          cv.addWeighted(normalized, .78, lightness, .22, 3, balanced); sharpen(cv, balanced, adjusted, .3, 1);
        } finally { normalized.delete(); balanced.delete(); }
      });
    } else {
      const gray = new cv.Mat(); const normalized = new cv.Mat();
      try {
        cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
        if (mode === 'gray') {
          const equalized = new cv.Mat(); const balanced = new cv.Mat();
          try { cv.equalizeHist(gray, equalized); cv.addWeighted(gray, .55, equalized, .45, 4, balanced); sharpen(cv, balanced, output, .48, 2); }
          finally { equalized.delete(); balanced.delete(); }
        } else if (mode === 'bw') {
          normalizeIllumination(cv, gray, normalized); adaptivePaperThreshold(cv, normalized, output, 10);
        } else if (mode === 'eco') {
          const paper = new cv.Mat();
          try { normalizeIllumination(cv, gray, normalized); adaptivePaperThreshold(cv, normalized, paper, 15); cv.addWeighted(normalized, .28, paper, .72, 5, output); }
          finally { paper.delete(); }
        } else gray.copyTo(output);
        cv.cvtColor(output, shown, cv.COLOR_GRAY2RGBA);
        cv.imshow(canvas, shown); return canvas;
      } finally { gray.delete(); normalized.delete(); }
    }
    cv.cvtColor(output, shown, cv.COLOR_RGB2RGBA); cv.imshow(canvas, shown); return canvas;
  } finally { source.delete(); rgb.delete(); output.delete(); shown.delete(); }
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
  // Never lose a capture to a filter failure: if enhancement can't run (for
  // example the vision engine failed to load), keep the geometry-corrected page.
  try { await applyScannerFilter(warped, filter); }
  catch (error) { console.warn('Enhancement unavailable; keeping the unfiltered scan', error); }

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
