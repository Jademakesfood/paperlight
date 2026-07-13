let cvPromise;

export async function prepareDetector() {
  if (!cvPromise) {
    cvPromise = import('@techstark/opencv-js').then(async ({ default: module }) => {
      const cv = module instanceof Promise ? await module : module;
      if (cv.Mat) return cv;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Scanner engine timed out')), 20000);
        cv.onRuntimeInitialized = () => { clearTimeout(timeout); resolve(); };
      });
      return cv;
    });
  }
  return cvPromise;
}

function orderCorners(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  const cyclic = [...points].sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const start = cyclic.reduce((best, point, index) => (point.x + point.y < cyclic[best].x + cyclic[best].y ? index : best), 0);
  const ordered = [...cyclic.slice(start), ...cyclic.slice(0, start)];
  return ordered[1].x >= ordered[3].x ? ordered : [ordered[0], ordered[3], ordered[2], ordered[1]];
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function validCorners(points, width, height) {
  if (!points || points.length !== 4) return false;
  const area = polygonArea(points);
  const sides = points.map((point, index) => {
    const next = points[(index + 1) % 4]; return Math.hypot(point.x - next.x, point.y - next.y);
  });
  const shortest = Math.min(...sides); const longest = Math.max(...sides);
  return area > width * height * 0.035
    && shortest > Math.min(width, height) * 0.08
    && longest / Math.max(1, shortest) < 6.5;
}

function approximateQuad(cv, contour, width, height) {
  const perimeter = cv.arcLength(contour, true);
  for (const epsilon of [0.008, 0.012, 0.018, 0.026, 0.038, 0.055, 0.075]) {
    const approximate = new cv.Mat();
    cv.approxPolyDP(contour, approximate, Math.max(3, perimeter * epsilon), true);
    if (approximate.rows === 4 && cv.isContourConvex(approximate)) {
      const points = [];
      for (let index = 0; index < 4; index += 1) points.push({ x: approximate.data32S[index * 2], y: approximate.data32S[index * 2 + 1] });
      approximate.delete();
      const ordered = orderCorners(points);
      if (validCorners(ordered, width, height)) return ordered;
    } else approximate.delete();
  }
  return null;
}

function contourQuad(cv, contour, width, height) {
  const direct = approximateQuad(cv, contour, width, height);
  if (direct) return direct;
  const hull = new cv.Mat();
  try {
    cv.convexHull(contour, hull, false, true);
    return approximateQuad(cv, hull, width, height);
  } finally { hull.delete(); }
}

function rotatedFallback(cv, contour, width, height) {
  const rect = cv.minAreaRect(contour);
  if (!rect?.size?.width || !rect?.size?.height) return null;
  const radians = rect.angle * Math.PI / 180; const cosine = Math.cos(radians); const sine = Math.sin(radians);
  const halfWidth = rect.size.width / 2; const halfHeight = rect.size.height / 2;
  const points = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]].map(([x, y]) => ({
    x: rect.center.x + x * cosine - y * sine,
    y: rect.center.y + x * sine + y * cosine,
  }));
  const ordered = orderCorners(points);
  return validCorners(ordered, width, height) ? ordered : null;
}

function edgeSupport(edgeMap, corners) {
  if (!edgeMap) return 0;
  let supported = 0; let samples = 0;
  for (let side = 0; side < 4; side += 1) {
    const start = corners[side]; const end = corners[(side + 1) % 4];
    const count = Math.max(12, Math.min(54, Math.round(Math.hypot(end.x - start.x, end.y - start.y) / 11)));
    for (let index = 0; index <= count; index += 1) {
      const amount = index / count; const x = Math.round(start.x + (end.x - start.x) * amount); const y = Math.round(start.y + (end.y - start.y) * amount);
      let hit = false;
      for (let offsetY = -2; offsetY <= 2 && !hit; offsetY += 1) {
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(edgeMap.cols - 1, x + offsetX)); const sampleY = Math.max(0, Math.min(edgeMap.rows - 1, y + offsetY));
          if (edgeMap.ucharPtr(sampleY, sampleX)[0] > 0) { hit = true; break; }
        }
      }
      supported += hit ? 1 : 0; samples += 1;
    }
  }
  return supported / Math.max(1, samples);
}

function candidateScore(corners, contourArea, width, height, exact, edgeMap, sourceBias = 0) {
  const frameArea = width * height; const cornerArea = polygonArea(corners);
  const margin = Math.min(width, height) * 0.018;
  const borderTouches = corners.filter((point) => point.x < margin || point.y < margin || point.x > width - margin || point.y > height - margin).length;
  const coverage = Math.min(contourArea, cornerArea) / frameArea;
  const rectangularity = Math.min(contourArea, cornerArea) / Math.max(contourArea, cornerArea, 1);
  const center = corners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const centerPenalty = Math.hypot(center.x / width - .5, center.y / height - .5) * .16;
  const support = edgeSupport(edgeMap, corners);
  const score = coverage * .68 + rectangularity * .16 + support * .25 + (exact ? .09 : 0) + sourceBias - borderTouches * .045 - centerPenalty;
  return { score, coverage, rectangularity, support };
}

function collectCandidates(cv, binary, width, height, candidates, edgeMap, sourceBias = 0, allowFallback = true) {
  const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = width * height;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index); const area = Math.abs(cv.contourArea(contour));
      if (area > frameArea * .035 && area < frameArea * .992) {
        const exact = contourQuad(cv, contour, width, height);
        if (exact) candidates.push({ corners: exact, ...candidateScore(exact, area, width, height, true, edgeMap, sourceBias) });
        else if (allowFallback && area > frameArea * .12) {
          const fallback = rotatedFallback(cv, contour, width, height);
          if (fallback) candidates.push({ corners: fallback, ...candidateScore(fallback, area, width, height, false, edgeMap, sourceBias - .06) });
        }
      }
      contour.delete();
    }
  } finally { contours.delete(); hierarchy.delete(); }
}

function medianIntensity(mat) {
  const histogram = new Uint32Array(256); const values = mat.data;
  for (let index = 0; index < values.length; index += 1) histogram[values[index]] += 1;
  const midpoint = values.length / 2; let total = 0;
  for (let value = 0; value < histogram.length; value += 1) { total += histogram[value]; if (total >= midpoint) return value; }
  return 128;
}

export async function detectDocumentDetailed(source, maxDimension = 900) {
  const cv = await prepareDetector();
  const image = source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement ? source : await new Promise((resolve, reject) => {
    const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = source;
  });
  const naturalWidth = image.videoWidth || image.naturalWidth || image.width;
  const naturalHeight = image.videoHeight || image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale)); canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);

  const src = cv.imread(canvas); const gray = new cv.Mat(); const blurred = new cv.Mat(); const equalized = new cv.Mat();
  const canny = new cv.Mat(); const softCanny = new cv.Mat(); const adaptive = new cv.Mat(); const adaptiveInverted = new cv.Mat();
  const otsu = new cv.Mat(); const inverted = new cv.Mat(); const gradient = new cv.Mat(); const gradientBinary = new cv.Mat();
  const edgeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const regionKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const candidates = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.equalizeHist(blurred, equalized);

    const median = medianIntensity(blurred); const low = Math.max(22, Math.round(median * .55)); const high = Math.max(low + 35, Math.min(230, Math.round(median * 1.35)));
    cv.Canny(blurred, canny, low, high, 3, true);
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
    cv.dilate(canny, canny, edgeKernel, new cv.Point(-1, -1), 1);
    collectCandidates(cv, canny, canvas.width, canvas.height, candidates, canny, .05, true);

    cv.Canny(equalized, softCanny, 24, 92, 3, true);
    cv.morphologyEx(softCanny, softCanny, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, softCanny, canvas.width, canvas.height, candidates, softCanny, .025, false);

    const blockSize = Math.max(21, Math.min(61, Math.round(Math.min(canvas.width, canvas.height) / 10) | 1));
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 7);
    cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, adaptive, canvas.width, canvas.height, candidates, canny, .015, false);
    cv.bitwise_not(adaptive, adaptiveInverted);
    collectCandidates(cv, adaptiveInverted, canvas.width, canvas.height, candidates, canny, 0, false);

    cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, otsu, canvas.width, canvas.height, candidates, canny, .035, true);
    cv.bitwise_not(otsu, inverted);
    collectCandidates(cv, inverted, canvas.width, canvas.height, candidates, canny, .02, false);

    cv.morphologyEx(blurred, gradient, cv.MORPH_GRADIENT, regionKernel);
    cv.threshold(gradient, gradientBinary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(gradientBinary, gradientBinary, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, gradientBinary, canvas.width, canvas.height, candidates, canny, .02, false);

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length || candidates[0].score < .2 || candidates[0].coverage < .035) return null;
    const best = candidates[0]; const runnerUp = candidates[1]; const margin = runnerUp ? Math.max(0, best.score - runnerUp.score) : .12;
    return {
      corners: best.corners.map((point) => ({ x: Math.max(0, Math.min(1, point.x / canvas.width)), y: Math.max(0, Math.min(1, point.y / canvas.height)) })),
      confidence: Math.max(.18, Math.min(.99, .22 + best.score * .62 + margin * .7)),
      coverage: best.coverage,
    };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); equalized.delete(); canny.delete(); softCanny.delete(); adaptive.delete(); adaptiveInverted.delete();
    otsu.delete(); inverted.delete(); gradient.delete(); gradientBinary.delete(); edgeKernel.delete(); regionKernel.delete();
  }
}

export async function detectDocument(source, maxDimension = 900) {
  return (await detectDocumentDetailed(source, maxDimension))?.corners || null;
}
