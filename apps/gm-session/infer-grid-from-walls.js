/**
 * Infer square grid pitch/phase from wall-like linear segments on a battlemap.
 * Browser: window.InferGridFromWalls ; Node tests: vm + globalThis.InferGridFromWalls
 */
(function (root) {
  "use strict";

  function collapseAxis(segs, orient, gapPx) {
    if (!segs.length) return [];
    segs.sort(function (a, b) {
      var pa = orient === "h" ? a.y1 : a.x1;
      var pb = orient === "h" ? b.y1 : b.x1;
      if (pa !== pb) return pa - pb;
      return orient === "h" ? a.x1 - b.x1 : a.y1 - b.y1;
    });
    var used = new Array(segs.length).fill(false);
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      var a = segs[i];
      var mid = orient === "h" ? a.y1 : a.x1;
      var count = 1;
      var x1 = Math.min(a.x1, a.x2);
      var x2 = Math.max(a.x1, a.x2);
      var y1 = Math.min(a.y1, a.y2);
      var y2 = Math.max(a.y1, a.y2);
      var a0 = orient === "h" ? Math.min(a.x1, a.x2) : Math.min(a.y1, a.y2);
      var a1 = orient === "h" ? Math.max(a.x1, a.x2) : Math.max(a.y1, a.y2);
      for (var j = i + 1; j < segs.length; j++) {
        if (used[j]) continue;
        var b = segs[j];
        var pa = orient === "h" ? a.y1 : a.x1;
        var pb = orient === "h" ? b.y1 : b.x1;
        if (Math.abs(pb - pa) > gapPx * 2) break;
        var b0 = orient === "h" ? Math.min(b.x1, b.x2) : Math.min(b.y1, b.y2);
        var b1 = orient === "h" ? Math.max(b.x1, b.x2) : Math.max(b.y1, b.y2);
        var overlap = Math.min(a1, b1) - Math.max(a0, b0);
        if (overlap < Math.min(a.length, b.length) * 0.35) continue;
        if (Math.abs(pb - pa) <= gapPx) {
          used[j] = true;
          mid += pb;
          count++;
          if (orient === "h") {
            x1 = Math.min(x1, b0);
            x2 = Math.max(x2, b1);
          } else {
            y1 = Math.min(y1, b0);
            y2 = Math.max(y2, b1);
          }
        }
      }
      mid /= count;
      if (orient === "h") {
        out.push({
          x1: x1,
          y1: mid,
          x2: x2,
          y2: mid,
          orient: "h",
          length: Math.max(1, x2 - x1),
        });
      } else {
        out.push({
          x1: mid,
          y1: y1,
          x2: mid,
          y2: y2,
          orient: "v",
          length: Math.max(1, y2 - y1),
        });
      }
    }
    return out;
  }

  function collapseParallelSegments(segments, gapPx) {
    if (gapPx == null) gapPx = 4;
    var hs = segments.filter(function (s) { return s.orient === "h"; }).map(function (s) { return Object.assign({}, s); });
    var vs = segments.filter(function (s) { return s.orient === "v"; }).map(function (s) { return Object.assign({}, s); });
    return collapseAxis(hs, "h", gapPx).concat(collapseAxis(vs, "v", gapPx));
  }

  function distToGridLine(pos, pitch, phase) {
    var p = ((phase % pitch) + pitch) % pitch;
    var t = ((pos - p) % pitch + pitch) % pitch;
    return Math.min(t, pitch - t);
  }

  function scoreWallGrid(segments, pitch, phaseX, phaseY, tol) {
    if (tol == null) tol = 2.5;
    if (!(pitch > 0) || !segments.length) return 0;
    var aligned = 0;
    var total = 0;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      var len = s.length || 1;
      total += len;
      if (s.orient === "h") {
        var y = (s.y1 + s.y2) / 2;
        if (distToGridLine(y, pitch, phaseY) <= tol) aligned += len;
      } else {
        var x = (s.x1 + s.x2) / 2;
        if (distToGridLine(x, pitch, phaseX) <= tol) aligned += len;
      }
    }
    return total > 0 ? aligned / total : 0;
  }

  function collectPitchCandidates(positions, minP, maxP, out) {
    var sorted = positions.slice().sort(function (a, b) { return a - b; });
    for (var i = 0; i < sorted.length; i++) {
      for (var j = i + 1; j < sorted.length; j++) {
        var d = Math.abs(sorted[j] - sorted[i]);
        if (d < minP) continue;
        if (d > maxP * 3) break;
        for (var k = 1; k <= 5; k++) {
          var p = d / k;
          if (p >= minP && p <= maxP) out.add(Math.round(p * 2) / 2);
        }
      }
    }
  }

  function bestPhase(positions, pitch) {
    if (!positions.length || !(pitch > 0)) return 0;
    var bins = 24;
    var hist = new Float64Array(bins);
    for (var i = 0; i < positions.length; i++) {
      var t = ((positions[i] % pitch) + pitch) % pitch;
      var b = Math.min(bins - 1, Math.floor((t / pitch) * bins));
      hist[b] += 1;
    }
    var bestB = 0;
    for (var i = 1; i < bins; i++) if (hist[i] > hist[bestB]) bestB = i;
    return ((bestB + 0.5) / bins) * pitch;
  }

  function proposeGridFromWalls(segments, minP, maxP, opts) {
    opts = opts || {};
    var tol = opts.tol != null ? opts.tol : 2.5;
    var minScore = opts.minScore != null ? opts.minScore : 0.5;
    var collapsed = collapseParallelSegments(
      segments,
      opts.gapPx != null ? opts.gapPx : 4
    );
    if (!collapsed.length) return null;

    var hs = collapsed.filter(function (s) { return s.orient === "h"; });
    var vs = collapsed.filter(function (s) { return s.orient === "v"; });

    var candidates = new Set();
    collectPitchCandidates(
      hs.map(function (s) { return s.y1; }),
      minP,
      maxP,
      candidates
    );
    collectPitchCandidates(
      vs.map(function (s) { return s.x1; }),
      minP,
      maxP,
      candidates
    );
    var step = Math.max(1, Math.floor((maxP - minP) / 40));
    for (var p = Math.ceil(minP); p <= Math.floor(maxP); p += step) {
      candidates.add(p);
    }
    if (!candidates.size) return null;

    var best = null;
    candidates.forEach(function (pitch) {
      if (!(pitch >= minP && pitch <= maxP)) return;
      function tryPitch(p2) {
        if (!(p2 >= minP && p2 <= maxP)) return;
        var phaseY = bestPhase(
          hs.map(function (s) { return s.y1; }),
          p2
        );
        var phaseX = bestPhase(
          vs.map(function (s) { return s.x1; }),
          p2
        );
        var score = scoreWallGrid(collapsed, p2, phaseX, phaseY, tol);
        if (!best || score > best.score) {
          best = { pitch: p2, phaseX: phaseX, phaseY: phaseY, score: score };
        }
      }
      tryPitch(pitch);
      tryPitch(pitch - 1);
      tryPitch(pitch - 0.5);
      tryPitch(pitch + 0.5);
      tryPitch(pitch + 1);
    });
    if (!best || !(best.score > minScore)) return null;
    return best;
  }

  function extractWallSegmentsFromImageData(imgData, w, h, opts) {
    opts = opts || {};
    var minLen =
      opts.minLen != null
        ? opts.minLen
        : Math.max(12, Math.floor(Math.min(w, h) / 40));
    var data = imgData.data;
    var gray = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
    var edge = new Float32Array(w * h);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var idx = y * w + x;
        var gx = gray[idx + 1] - gray[idx - 1];
        var gy = gray[idx + w] - gray[idx - w];
        edge[idx] = Math.abs(gx) + Math.abs(gy);
      }
    }
    var sample = [];
    var sampStep = Math.max(1, Math.floor((w * h) / 8000));
    for (var si = 0; si < w * h; si += sampStep) {
      if (edge[si] > 0) sample.push(edge[si]);
    }
    sample.sort(function (a, b) { return a - b; });
    var thresh = sample.length ? sample[Math.floor(sample.length * 0.88)] : 40;

    var mask = new Uint8Array(w * h);
    for (var mi = 0; mi < w * h; mi++) {
      if (edge[mi] >= thresh && gray[mi] < 200) mask[mi] = 1;
    }

    var segs = [];
    for (var yy = 0; yy < h; yy++) {
      var xx = 0;
      while (xx < w) {
        while (xx < w && !mask[yy * w + xx]) xx++;
        var x0 = xx;
        while (xx < w && mask[yy * w + xx]) xx++;
        if (xx - x0 >= minLen) {
          segs.push({
            x1: x0,
            y1: yy,
            x2: xx - 1,
            y2: yy,
            orient: "h",
            length: xx - x0,
          });
        }
      }
    }
    for (var xv = 0; xv < w; xv++) {
      var yv = 0;
      while (yv < h) {
        while (yv < h && !mask[yv * w + xv]) yv++;
        var y0 = yv;
        while (yv < h && mask[yv * w + xv]) yv++;
        if (yv - y0 >= minLen) {
          segs.push({
            x1: xv,
            y1: y0,
            x2: xv,
            y2: yv - 1,
            orient: "v",
            length: yv - y0,
          });
        }
      }
    }
    return segs;
  }

  function inferGridFromWallImageData(imgData, w, h, minP, maxP) {
    var segs = extractWallSegmentsFromImageData(imgData, w, h);
    return proposeGridFromWalls(segs, minP, maxP);
  }

  var api = {
    collapseParallelSegments: collapseParallelSegments,
    scoreWallGrid: scoreWallGrid,
    proposeGridFromWalls: proposeGridFromWalls,
    extractWallSegmentsFromImageData: extractWallSegmentsFromImageData,
    inferGridFromWallImageData: inferGridFromWallImageData,
  };

  root.InferGridFromWalls = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
