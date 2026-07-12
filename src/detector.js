let cvPromise;

async function getCv() {
  if (!cvPromise) {
    cvPromise = import('@techstark/opencv-js').then(async ({ default: module }) => {
      const cv = module instanceof Promise ? await module : module;
      if (cv.Mat) return cv;
      await new Promise((resolve) => { cv.onRuntimeInitialized = resolve; });
      return cv;
    });
  }
  return cvPromise;
}

function orderCorners(points) {
  const byY = [...points].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bottom = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bottom[1], bottom[0]];
}

function contourCorners(cv, contour, width, height) {
  const perimeter = cv.arcLength(contour, true);
  for (const epsilon of [0.012, 0.018, 0.025, 0.035, 0.05, 0.07]) {
    const approximate = new cv.Mat();
    cv.approxPolyDP(contour, approximate, Math.max(4, perimeter * epsilon), true);
    if (approximate.rows === 4 && cv.isContourConvex(approximate)) {
      const points = [];
      for (let index = 0; index < 4; index += 1) points.push({ x: approximate.data32S[index * 2], y: approximate.data32S[index * 2 + 1] });
      approximate.delete();
      const ordered = orderCorners(points);
      const edge = 5;
      const touchesWholeFrame = ordered.filter((p) => p.x < edge || p.y < edge || p.x > width - edge || p.y > height - edge).length >= 3;
      return touchesWholeFrame ? null : ordered;
    }
    approximate.delete();
  }
  return null;
}

export async function detectDocument(source, maxDimension = 760) {
  const cv = await getCv();
  const image = source instanceof HTMLCanvasElement || source instanceof HTMLVideoElement ? source : await new Promise((resolve, reject) => {
    const element = new Image(); element.onload = () => resolve(element); element.onerror = reject; element.src = source;
  });
  const naturalWidth = image.videoWidth || image.naturalWidth || image.width;
  const naturalHeight = image.videoHeight || image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) return null;
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);

  const src = cv.imread(canvas); const gray = new cv.Mat(); const blurred = new cv.Mat();
  const edges = new cv.Mat(); const closed = new cv.Mat(); const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
  let kernel;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 45, 145);
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    cv.dilate(closed, closed, kernel, new cv.Point(-1, -1), 1);
    cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const minimumArea = canvas.width * canvas.height * 0.075;
    const candidates = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      if (area >= minimumArea) {
        const corners = contourCorners(cv, contour, canvas.width, canvas.height);
        if (corners) candidates.push({ area, corners });
      }
      contour.delete();
    }
    candidates.sort((a, b) => b.area - a.area);
    if (!candidates.length) return null;
    return candidates[0].corners.map((point) => ({
      x: Math.max(0, Math.min(1, point.x / canvas.width)),
      y: Math.max(0, Math.min(1, point.y / canvas.height)),
    }));
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete(); closed.delete(); contours.delete(); hierarchy.delete(); kernel?.delete();
  }
}
