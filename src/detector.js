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
  const pixels = edgeMap.data; const stride = edgeMap.cols;
  let supported = 0; let samples = 0;
  for (let side = 0; side < 4; side += 1) {
    const start = corners[side]; const end = corners[(side + 1) % 4];
    const count = Math.max(10, Math.min(42, Math.round(Math.hypot(end.x - start.x, end.y - start.y) / 14)));
    for (let index = 0; index <= count; index += 1) {
      const amount = index / count; const x = Math.round(start.x + (end.x - start.x) * amount); const y = Math.round(start.y + (end.y - start.y) * amount);
      let hit = false;
      for (let offsetY = -2; offsetY <= 2 && !hit; offsetY += 1) {
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(edgeMap.cols - 1, x + offsetX)); const sampleY = Math.max(0, Math.min(edgeMap.rows - 1, y + offsetY));
          if (pixels[sampleY * stride + sampleX] > 0) { hit = true; break; }
        }
      }
      supported += hit ? 1 : 0; samples += 1;
    }
  }
  return supported / Math.max(1, samples);
}

function sampleGray(grayMap, point) {
  const x = Math.round(point.x); const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= grayMap.cols || y >= grayMap.rows) return null;
  return grayMap.data[y * grayMap.cols + x];
}

function paperContrast(grayMap, corners) {
  if (!grayMap) return { contrast: 0, brightness: .5, borderEvidence: 0 };
  const inside = [];
  for (const v of [.2, .35, .5, .65, .8]) {
    for (const u of [.2, .35, .5, .65, .8]) {
      const top = { x: corners[0].x + (corners[1].x - corners[0].x) * u, y: corners[0].y + (corners[1].y - corners[0].y) * u };
      const bottom = { x: corners[3].x + (corners[2].x - corners[3].x) * u, y: corners[3].y + (corners[2].y - corners[3].y) * u };
      const value = sampleGray(grayMap, { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v });
      if (value !== null) inside.push(value);
    }
  }
  const outside = []; const offset = Math.min(grayMap.cols, grayMap.rows) * .035;
  for (let side = 0; side < 4; side += 1) {
    const start = corners[side]; const end = corners[(side + 1) % 4]; const dx = end.x - start.x; const dy = end.y - start.y; const length = Math.max(1, Math.hypot(dx, dy));
    const normal = { x: dy / length, y: -dx / length };
    for (const amount of [.18, .36, .5, .64, .82]) {
      const edge = { x: start.x + dx * amount, y: start.y + dy * amount };
      const value = sampleGray(grayMap, { x: edge.x + normal.x * offset, y: edge.y + normal.y * offset });
      if (value !== null) outside.push(value);
    }
  }
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const innerMean = average(inside); const outsideMean = outside.length ? average(outside) : innerMean;
  return { contrast: Math.max(-1, Math.min(1, (innerMean - outsideMean) / 110)), brightness: innerMean / 255, borderEvidence: outside.length / 20 };
}

function quadGeometry(corners) {
  const sides = corners.map((point, index) => {
    const next = corners[(index + 1) % 4];
    return { x: next.x - point.x, y: next.y - point.y, length: Math.hypot(next.x - point.x, next.y - point.y) };
  });
  const rightAngles = sides.map((side, index) => {
    const next = sides[(index + 1) % 4];
    return 1 - Math.min(1, Math.abs(side.x * next.x + side.y * next.y) / Math.max(1, side.length * next.length));
  });
  const oppositeBalance = [
    Math.min(sides[0].length, sides[2].length) / Math.max(1, sides[0].length, sides[2].length),
    Math.min(sides[1].length, sides[3].length) / Math.max(1, sides[1].length, sides[3].length),
  ];
  return rightAngles.reduce((sum, value) => sum + value, 0) / 4 * .72
    + oppositeBalance.reduce((sum, value) => sum + value, 0) / 2 * .28;
}

function candidateScore(corners, contourArea, width, height, exact, edgeMap, grayMap, sourceBias = 0) {
  const frameArea = width * height; const cornerArea = polygonArea(corners);
  const margin = Math.min(width, height) * 0.018;
  const borderTouches = corners.filter((point) => point.x < margin || point.y < margin || point.x > width - margin || point.y > height - margin).length;
  const coverage = Math.min(contourArea, cornerArea) / frameArea;
  const frameLike = borderTouches >= 3 && cornerArea / frameArea > .82;
  const rectangularity = Math.min(contourArea, cornerArea) / Math.max(contourArea, cornerArea, 1);
  const center = corners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const centerPenalty = Math.hypot(center.x / width - .5, center.y / height - .5) * .16;
  const support = edgeSupport(edgeMap, corners);
  const geometry = quadGeometry(corners);
  const appearance = paperContrast(grayMap, corners); const coverageSignal = Math.min(1, coverage / .46);
  const appearanceSignal = Math.max(0, appearance.contrast) * appearance.borderEvidence;
  const score = frameLike ? -1 : coverageSignal * .23 + rectangularity * .12 + support * .3 + geometry * .12 + appearanceSignal * .24
    + Math.max(0, appearance.brightness - .45) * .08 + (exact ? .075 : 0) + sourceBias - borderTouches * .055 - centerPenalty;
  return { score, coverage, rectangularity, support, geometry, appearance };
}

function lineFromSegment(x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1; const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const a = dy / length; const b = -dx / length;
  return { a, b, c: -(a * x1 + b * y1), length, midX: (x1 + x2) / 2, midY: (y1 + y2) / 2, horizontal: Math.abs(dx) >= Math.abs(dy), angle: Math.atan2(dy, dx) };
}

function angleDifference(first, second) {
  let difference = Math.abs(first - second) % Math.PI;
  if (difference > Math.PI / 2) difference = Math.PI - difference;
  return difference;
}

function intersectLines(first, second) {
  const determinant = first.a * second.b - second.a * first.b;
  if (Math.abs(determinant) < .075) return null;
  return {
    x: (first.b * second.c - second.b * first.c) / determinant,
    y: (first.c * second.a - second.c * first.a) / determinant,
  };
}

function linePairs(lines, axis, span) {
  const pairs = [];
  for (let first = 0; first < lines.length; first += 1) {
    for (let second = first + 1; second < lines.length; second += 1) {
      const separation = Math.abs(lines[first][axis] - lines[second][axis]);
      if (separation < span * .18 || angleDifference(lines[first].angle, lines[second].angle) > .62) continue;
      const ordered = lines[first][axis] <= lines[second][axis] ? [lines[first], lines[second]] : [lines[second], lines[first]];
      pairs.push({ lines: ordered, weight: lines[first].length + lines[second].length + separation * .35 });
    }
  }
  return pairs.sort((a, b) => b.weight - a.weight).slice(0, 10);
}

function collectLineCandidates(cv, edgeMap, grayMap, width, height, candidates, sourceBias = 0) {
  const lines = new cv.Mat();
  try {
    const minimum = Math.min(width, height);
    cv.HoughLinesP(edgeMap, lines, 1, Math.PI / 180, Math.max(24, Math.round(minimum * .07)), Math.max(38, Math.round(minimum * .16)), Math.max(14, Math.round(minimum * .055)));
    const segments = [];
    for (let index = 0; index + 3 < lines.data32S.length; index += 4) {
      const line = lineFromSegment(lines.data32S[index], lines.data32S[index + 1], lines.data32S[index + 2], lines.data32S[index + 3]);
      if (line && line.length >= minimum * .16) segments.push(line);
    }
    const horizontal = segments.filter((line) => line.horizontal).sort((a, b) => b.length - a.length).slice(0, 16);
    const vertical = segments.filter((line) => !line.horizontal).sort((a, b) => b.length - a.length).slice(0, 16);
    const horizontalPairs = linePairs(horizontal, 'midY', height); const verticalPairs = linePairs(vertical, 'midX', width);
    const paddingX = width * .16; const paddingY = height * .16;
    for (const horizontalPair of horizontalPairs) {
      for (const verticalPair of verticalPairs) {
        const raw = [
          intersectLines(horizontalPair.lines[0], verticalPair.lines[0]),
          intersectLines(horizontalPair.lines[0], verticalPair.lines[1]),
          intersectLines(horizontalPair.lines[1], verticalPair.lines[1]),
          intersectLines(horizontalPair.lines[1], verticalPair.lines[0]),
        ];
        if (raw.some((point) => !point || point.x < -paddingX || point.y < -paddingY || point.x > width + paddingX || point.y > height + paddingY)) continue;
        const corners = orderCorners(raw);
        if (!validCorners(corners, width, height)) continue;
        const scored = candidateScore(corners, polygonArea(corners), width, height, false, edgeMap, grayMap, sourceBias);
        if (scored.support >= .24 && scored.geometry >= .56) candidates.push({ corners, ...scored, lineBased: true });
      }
    }
  } finally { lines.delete(); }
}

function cornerDistance(first, second, width, height) {
  const diagonal = Math.hypot(width, height);
  return first.reduce((sum, point, index) => sum + Math.hypot(point.x - second[index].x, point.y - second[index].y), 0) / Math.max(1, diagonal * 4);
}

function rankWithConsensus(candidates, width, height) {
  return candidates.map((candidate) => {
    const matching = candidates.filter((other) => cornerDistance(candidate.corners, other.corners, width, height) < .035);
    const consensus = Math.min(1, Math.max(0, matching.length - 1) / 4);
    const totalWeight = matching.reduce((sum, match) => sum + Math.max(.1, match.score), 0);
    const corners = candidate.corners.map((_, index) => matching.reduce((point, match) => {
      const weight = Math.max(.1, match.score);
      return { x: point.x + match.corners[index].x * weight / totalWeight, y: point.y + match.corners[index].y * weight / totalWeight };
    }, { x: 0, y: 0 }));
    return { ...candidate, corners, consensus, rankedScore: candidate.score + consensus * .095 };
  }).sort((a, b) => b.rankedScore - a.rankedScore);
}

function collectCandidates(cv, binary, width, height, candidates, edgeMap, grayMap, sourceBias = 0, allowFallback = true) {
  const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const frameArea = width * height; const viable = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index); const area = Math.abs(cv.contourArea(contour));
      if (area > frameArea * .035 && area < frameArea * .992) viable.push({ contour, area });
      else contour.delete();
    }
    viable.sort((a, b) => b.area - a.area);
    for (let index = 0; index < viable.length; index += 1) {
      const { contour, area } = viable[index];
      if (index < 36) {
        const exact = contourQuad(cv, contour, width, height);
        if (exact) candidates.push({ corners: exact, ...candidateScore(exact, area, width, height, true, edgeMap, grayMap, sourceBias) });
        else if (allowFallback && area > frameArea * .12) {
          const fallback = rotatedFallback(cv, contour, width, height);
          if (fallback) candidates.push({ corners: fallback, ...candidateScore(fallback, area, width, height, false, edgeMap, grayMap, sourceBias - .06) });
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
  const canny = new cv.Mat(); const softCanny = new cv.Mat(); const structure = new cv.Mat(); const structureCanny = new cv.Mat(); const combinedEdges = new cv.Mat();
  const adaptive = new cv.Mat(); const adaptiveInverted = new cv.Mat();
  const otsu = new cv.Mat(); const inverted = new cv.Mat(); const gradient = new cv.Mat(); const gradientBinary = new cv.Mat();
  const edgeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  const regionKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const structureKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const candidates = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.equalizeHist(blurred, equalized);

    const median = medianIntensity(blurred); const low = Math.max(22, Math.round(median * .55)); const high = Math.max(low + 35, Math.min(230, Math.round(median * 1.35)));
    cv.Canny(blurred, canny, low, high, 3, true);
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
    cv.dilate(canny, canny, edgeKernel, new cv.Point(-1, -1), 1);
    collectCandidates(cv, canny, canvas.width, canvas.height, candidates, canny, blurred, .05, true);

    cv.Canny(equalized, softCanny, 24, 92, 3, true);
    cv.morphologyEx(softCanny, softCanny, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, softCanny, canvas.width, canvas.height, candidates, softCanny, blurred, .025, false);

    cv.morphologyEx(blurred, structure, cv.MORPH_CLOSE, structureKernel, new cv.Point(-1, -1), 1);
    cv.Canny(structure, structureCanny, Math.max(14, low * .7), Math.max(58, high * .82), 3, true);
    cv.morphologyEx(structureCanny, structureCanny, cv.MORPH_CLOSE, edgeKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, structureCanny, canvas.width, canvas.height, candidates, structureCanny, blurred, .045, true);
    cv.bitwise_or(canny, structureCanny, combinedEdges);
    collectLineCandidates(cv, combinedEdges, blurred, canvas.width, canvas.height, candidates, .035);

    const blockSize = Math.max(21, Math.min(61, Math.round(Math.min(canvas.width, canvas.height) / 10) | 1));
    cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 7);
    cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, adaptive, canvas.width, canvas.height, candidates, canny, blurred, .015, false);
    cv.bitwise_not(adaptive, adaptiveInverted);
    collectCandidates(cv, adaptiveInverted, canvas.width, canvas.height, candidates, canny, blurred, 0, false);

    cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, otsu, canvas.width, canvas.height, candidates, canny, blurred, .035, true);
    cv.bitwise_not(otsu, inverted);
    collectCandidates(cv, inverted, canvas.width, canvas.height, candidates, canny, blurred, .02, false);

    cv.morphologyEx(blurred, gradient, cv.MORPH_GRADIENT, regionKernel);
    cv.threshold(gradient, gradientBinary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(gradientBinary, gradientBinary, cv.MORPH_CLOSE, regionKernel, new cv.Point(-1, -1), 2);
    collectCandidates(cv, gradientBinary, canvas.width, canvas.height, candidates, canny, blurred, .02, false);

    candidates.sort((a, b) => b.score - a.score);
    const ranked = rankWithConsensus(candidates.slice(0, 80), canvas.width, canvas.height);
    if (!ranked.length || ranked[0].rankedScore < .25 || ranked[0].coverage < .035) return null;
    const best = ranked[0]; const runnerUp = ranked.find((candidate) => cornerDistance(best.corners, candidate.corners, canvas.width, canvas.height) > .07);
    const margin = runnerUp ? Math.max(0, best.rankedScore - runnerUp.rankedScore) : .12;
    return {
      corners: best.corners.map((point) => ({ x: Math.max(0, Math.min(1, point.x / canvas.width)), y: Math.max(0, Math.min(1, point.y / canvas.height)) })),
      confidence: Math.max(.18, Math.min(.99, .16 + best.rankedScore * .55 + best.support * .16 + best.consensus * .12 + margin * .55)),
      coverage: best.coverage,
      method: best.lineBased ? 'lines' : 'contour',
    };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); equalized.delete(); canny.delete(); softCanny.delete(); structure.delete(); structureCanny.delete(); combinedEdges.delete(); adaptive.delete(); adaptiveInverted.delete();
    otsu.delete(); inverted.delete(); gradient.delete(); gradientBinary.delete(); edgeKernel.delete(); regionKernel.delete();
    structureKernel.delete();
  }
}

export async function detectDocument(source, maxDimension = 900) {
  return (await detectDocumentDetailed(source, maxDimension))?.corners || null;
}

// A single reusable scratch canvas keeps the live viewfinder loop from
// allocating (and garbage collecting) a fresh frame buffer on every tick,
// which matters a great deal on phones.
let scratch;
function scratchCanvas(width, height) {
  if (!scratch) {
    scratch = document.createElement('canvas');
    // Priming the context with willReadFrequently lets the browser keep the
    // bitmap on the CPU, which is what OpenCV's imread needs every frame.
    scratch.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  if (scratch.width !== width) scratch.width = width;
  if (scratch.height !== height) scratch.height = height;
  return scratch;
}

// A deliberately lean detector for the real-time camera preview. It runs one
// Canny + contour pass at a small resolution instead of the eight-pass
// consensus pipeline in detectDocumentDetailed, so it stays responsive at a
// few frames per second on a phone. The heavy detector is reserved for the
// one-shot still after the shutter is pressed, where quality matters more
// than latency.
export async function detectDocumentLive(source, maxDimension = 480) {
  const cv = await prepareDetector();
  const image = source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement ? source : await new Promise((resolve, reject) => {
    const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = source;
  });
  const naturalWidth = image.videoWidth || image.naturalWidth || image.width;
  const naturalHeight = image.videoHeight || image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = scratchCanvas(width, height);
  canvas.getContext('2d', { alpha: false, willReadFrequently: true }).drawImage(image, 0, 0, width, height);

  const src = cv.imread(canvas); const gray = new cv.Mat(); const blurred = new cv.Mat(); const canny = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const candidates = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const median = medianIntensity(blurred);
    const low = Math.max(20, Math.round(median * 0.5));
    const high = Math.max(low + 30, Math.min(220, Math.round(median * 1.3)));
    cv.Canny(blurred, canny, low, high, 3, true);
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    cv.dilate(canny, canny, kernel, new cv.Point(-1, -1), 1);
    collectCandidates(cv, canny, width, height, candidates, canny, blurred, 0, true);
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score < 0.3 || best.coverage < 0.06 || best.support < 0.22) return null;
    return {
      corners: best.corners.map((point) => ({ x: Math.max(0, Math.min(1, point.x / width)), y: Math.max(0, Math.min(1, point.y / height)) })),
      confidence: Math.max(0.2, Math.min(0.98, 0.18 + best.score * 0.6 + best.support * 0.22)),
    };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); canny.delete(); kernel.delete();
  }
}
