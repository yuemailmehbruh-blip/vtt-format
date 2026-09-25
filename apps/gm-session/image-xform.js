/**
 * Shared image transform helpers (map layers + token image crop).
 * A transformable box is { x, y, w, h, flipX, flipY, rotation } where x/y/w/h is
 * the axis-aligned bounding box AFTER rotation (same semantics map layers have
 * always used: a 90/270° rotation swaps w/h).
 *
 * Token crop boxes use "frame units": the token frame's square bounding box is
 * [0,1]×[0,1] (circle token inscribed). Storing frame units (not pixels) keeps the
 * crop valid at any zoom and if the token's tiles-across changes.
 */
(function (global) {
  "use strict";

  function normRotation(r) {
    const n = Number(r) || 0;
    const q = Math.round(n / 90) * 90;
    return ((q % 360) + 360) % 360;
  }

  /** Draw img into screen AABB (sx,sy,sw,sh) with rotation (deg, 90 steps) + flips. */
  function drawTransformed(ctx, img, sx, sy, sw, sh, rotation, flipX, flipY) {
    const rot = normRotation(rotation);
    const fx = !!flipX;
    const fy = !!flipY;
    if (rot || fx || fy) {
      // AABB is w×h; after 90/270 the content box is the swapped size.
      const odd = rot === 90 || rot === 270;
      const cw = odd ? sh : sw;
      const ch = odd ? sw : sh;
      ctx.save();
      ctx.translate(sx + sw / 2, sy + sh / 2);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
      ctx.drawImage(img, -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh);
    }
  }

  function toggleFlip(box, axis) {
    if (axis === "h") box.flipX = !box.flipX;
    else box.flipY = !box.flipY;
    return box;
  }

  /**
   * Rotate 90° clockwise; swap w/h to keep the AABB. Map layers keep their
   * top-left (historic behaviour); crops keep their center (keepCenter).
   */
  function rotateCw(box, opts) {
    const keepCenter = !!(opts && opts.keepCenter);
    const w = Number(box.w) || 0;
    const h = Number(box.h) || 0;
    if (w > 0 && h > 0) {
      if (keepCenter) {
        const cx = (Number(box.x) || 0) + w / 2;
        const cy = (Number(box.y) || 0) + h / 2;
        box.x = cx - h / 2;
        box.y = cy - w / 2;
      }
      box.w = h;
      box.h = w;
    }
    box.rotation = (normRotation(box.rotation) + 90) % 360;
    return box;
  }

  /** "Scale H/V tiles": set AABB size from tiles × unit (unit = world px per tile, or frame units per tile). */
  function scaleToTiles(box, tilesW, tilesH, unit, opts) {
    const min = opts && opts.min != null ? opts.min : 0.5;
    const tw = Math.max(min, Number(tilesW) || 0);
    const th = Math.max(min, Number(tilesH) || 0);
    const keepCenter = !!(opts && opts.keepCenter);
    const cx = (Number(box.x) || 0) + (Number(box.w) || 0) / 2;
    const cy = (Number(box.y) || 0) + (Number(box.h) || 0) / 2;
    box.w = tw * unit;
    box.h = th * unit;
    if (keepCenter) {
      box.x = cx - box.w / 2;
      box.y = cy - box.h / 2;
    }
    return { tw, th };
  }

  // --- Token crop (frame units) ---

  /** Cover-fit an image of natural size iw×ih into the unit frame, centered. */
  function defaultCrop(iw, ih) {
    const a = iw > 0 && ih > 0 ? iw / ih : 1;
    const w = a >= 1 ? a : 1;
    const h = a >= 1 ? 1 : 1 / a;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h, flipX: false, flipY: false, rotation: 0 };
  }

  /**
   * Snap: "left"/"right" move x only, "top"/"bottom" move y only, "center" both.
   * The other axis is never reset.
   */
  function snapCrop(crop, where) {
    const c = { ...crop };
    if (where === "left") c.x = 0;
    else if (where === "right") c.x = 1 - c.w;
    else if (where === "top") c.y = 0;
    else if (where === "bottom") c.y = 1 - c.h;
    else if (where === "center") {
      c.x = (1 - c.w) / 2;
      c.y = (1 - c.h) / 2;
    }
    return c;
  }

  /** Uniform zoom by factor about pivot (frame units; default frame center). */
  function zoomCrop(crop, factor, px, py) {
    const f = Number(factor) > 0 ? Number(factor) : 1;
    const pivX = px == null ? 0.5 : px;
    const pivY = py == null ? 0.5 : py;
    const nw = Math.min(50, Math.max(0.05, crop.w * f));
    const k = nw / crop.w;
    return {
      ...crop,
      x: pivX - (pivX - crop.x) * k,
      y: pivY - (pivY - crop.y) * k,
      w: nw,
      h: crop.h * k,
    };
  }

  function panCrop(crop, dx, dy) {
    return { ...crop, x: crop.x + dx, y: crop.y + dy };
  }

  function r6(n) {
    return Math.round(n * 1e6) / 1e6;
  }

  /** Normalize a stored crop (tolerant of old/partial data); returns null if unusable. */
  function normalizeCrop(raw) {
    if (!raw || typeof raw !== "object") return null;
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (!(w > 0) || !(h > 0)) return null;
    return {
      x: Number(raw.x) || 0,
      y: Number(raw.y) || 0,
      w,
      h,
      flipX: !!raw.flipX,
      flipY: !!raw.flipY,
      rotation: normRotation(raw.rotation),
    };
  }

  /** Serializable crop (rounded) for appearance.image.crop. */
  function cropToJSON(crop) {
    const c = normalizeCrop(crop);
    if (!c) return null;
    return {
      x: r6(c.x),
      y: r6(c.y),
      w: r6(c.w),
      h: r6(c.h),
      flipX: c.flipX,
      flipY: c.flipY,
      rotation: c.rotation,
    };
  }

  /** Screen rect for a crop drawn in a frame whose square bbox is (fx,fy,side). */
  function cropScreenRect(crop, fx, fy, side) {
    return {
      x: fx + crop.x * side,
      y: fy + crop.y * side,
      w: crop.w * side,
      h: crop.h * side,
    };
  }

  const api = {
    normRotation,
    drawTransformed,
    toggleFlip,
    rotateCw,
    scaleToTiles,
    defaultCrop,
    snapCrop,
    zoomCrop,
    panCrop,
    normalizeCrop,
    cropToJSON,
    cropScreenRect,
  };
  global.ImageXform = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
