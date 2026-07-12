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
  const shortest = Math.min(...points.map((point, index) => {
    const next = points[(index + 1) % 4]; return Math.hypot(point.x - next.x, point.y - next.y);
  }));
  return area > width * height * 0.045 && shortest > Math.min(width, height) * 0.12;
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

function candidateScore(corners, contourArea, width, height, exact) {
  const frameArea = width * height; const cornerArea = polygonArea(corners);
  const margin = Math.min(width, height) * 0.018;
  const borderTouches = corners.filter((point) => point.x < margin || point.y < margin || point.x > width - margin || point.y > height - margin).length;
  const coverage = Math.min(contourArea, cornerArea) / frameArea;
  const center = corners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const centerPenalty = Math.hypot(center.x / width - .5, center.y / height - .5) * .2;
  return coverage + (exact ? .13 : 0) - borderTouches * .045 - centerPenalty;
}

function collectCandidates(cv, binary, width, height, candidates) {
  const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = width * height;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index); const area = Math.abs(cv.contourArea(contour));
      if (area > frameArea * .045 && area < frameArea * .985) {
        const exact = contourQuad(cv, contour, width, height);
        if (exact) candidates.push({ corners: exact, score: candidateScore(exact, area, width, height, true) });
        else if (area > frameArea * .11) {
          const fallback = rotatedFallback(cv, contour, width, height);
          if (fallback) candidates.push({ corners: fallback, score: candidateScore(fallback, area, width, height, false) });
        }
      }
      contour.delete();
    }
  } finally { contours.delete(); hierarchy.delete(); }
}

export async function detectDocument(source, maxDimension = 820) {
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

  const src = cv.imread(canvas); const gray = new cv.Mat(); const blurred = new cv.Mat(); const canny = new cv.Mat();
  const adaptive = new cv.Mat(); const otsu = new cv.Mat(); const inverted = new cv.Mat(); const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const candidates = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    cv.Canny(blurred, canny, 32, 120);
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    cv.dilate(canny, canny, kernel, new cv.Point(-1, -1), 1);
    collectCandidates(cv, canny, canvas.width, canvas.height, candidates);

    const blockSize = Math.max(15, Math.min(51, Math.round(Math.min(canvas.width, canvas.height) / 12) | 1));
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 7);
    cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, adaptive, canvas.width, canvas.height, candidates);

    cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, otsu, canvas.width, canvas.height, candidates);
    cv.bitwise_not(otsu, inverted);
    collectCandidates(cv, inverted, canvas.width, canvas.height, candidates);

    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length || candidates[0].score < .025) return null;
    return candidates[0].corners.map((point) => ({ x: Math.max(0, Math.min(1, point.x / canvas.width)), y: Math.max(0, Math.min(1, point.y / canvas.height)) }));
  } finally {
    src.delete(); gray.delete(); blurred.delete(); canny.delete(); adaptive.delete(); otsu.delete(); inverted.delete(); kernel.delete();
  }
}
