import { useRef, useState, useCallback, useEffect } from 'react';
import { COUNTRY_PRESETS, mmToPx, type CountryPreset } from '../lib/countries';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pos { x: number; y: number }

async function compositeOnWhite(blob: Blob): Promise<string> {
  const bitmapUrl = URL.createObjectURL(blob);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = rej;
    el.src = bitmapUrl;
  });
  URL.revokeObjectURL(bitmapUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d')!;
  tc.drawImage(img, 0, 0);
  const id = tc.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 15) d[i] = 0;
    else if (d[i] > 240) d[i] = 255;
  }
  tc.putImageData(id, 0, 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oc = out.getContext('2d')!;
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, w, h);
  oc.drawImage(tmp, 0, 0);
  return new Promise<string>((res, rej) =>
    out.toBlob(b => b ? res(URL.createObjectURL(b)) : rej(new Error('toBlob failed')), 'image/jpeg', 0.95),
  );
}

// ─── Guideline overlay drawn on the crop canvas ───────────────────────────────

function drawGuidelines(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  preset: CountryPreset,
) {
  const D = canvasH / preset.height;  // px per mm
  const cx = canvasW / 2;
  const k = preset.faceWidthRatio ?? 0.7;
  const minFace = preset.faceHeight.min;
  const maxFace = preset.faceHeight.max;
  const avgFace = (minFace + maxFace) / 2;

  // Calculate a SHARED vertical center for both ovals (concentric design).
  // State Dept tool places eyes at 41 % from top; eye ≈ 40 % down from crown,
  // so face center = eyeY + 10 % of face height.
  let centerMm: number;
  if (preset.eyeLevel) {
    const avgEyeFromBottom = (preset.eyeLevel.min + preset.eyeLevel.max) / 2;
    const eyeFromTop = preset.height - avgEyeFromBottom;
    centerMm = eyeFromTop + 0.10 * avgFace;
  } else if (preset.topMargin) {
    const avgTopMargin = (preset.topMargin.min + preset.topMargin.max) / 2;
    centerMm = avgTopMargin + avgFace / 2;
  } else {
    centerMm = preset.height * 0.45;
  }

  const centerY = centerMm * D;
  const innerSemiH = (minFace / 2) * D;
  const innerSemiW = innerSemiH * k;
  const outerSemiH = (maxFace / 2) * D;
  const outerSemiW = outerSemiH * k;

  // Dim the area OUTSIDE the outer oval using even-odd fill.
  // The interior of the oval stays clear so the face is easy to see.
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, canvasW, canvasH);
  ctx.ellipse(cx, centerY, outerSemiW, outerSemiH, 0, 0, Math.PI * 2);
  ctx.fill('evenodd');
  ctx.restore();

  // Outer oval — face must NOT exceed this (max face height)
  ctx.save();
  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.ellipse(cx, centerY, outerSemiW, outerSemiH, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Inner oval — face must reach AT LEAST this size (min face height)
  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.ellipse(cx, centerY, innerSemiW, innerSemiH, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Labels — inside the clear zone, near the top of each oval
  const drawLabel = (text: string, color: string, y: number) => {
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = `bold ${Math.round(10 * (canvasW / 560))}px sans-serif`;
    const tw = ctx.measureText(text).width;
    const lx = cx - tw / 2;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(text, lx, y);
    ctx.fillStyle = color;
    ctx.fillText(text, lx, y);
    ctx.restore();
  };

  drawLabel(`max ${maxFace} mm`, '#f97316', centerY - outerSemiH + 18 * (canvasW / 560));
  drawLabel(`min ${minFace} mm`, '#22c55e', centerY - innerSemiH + 18 * (canvasW / 560));

  // Vertical centre guide
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, canvasH);
  ctx.stroke();
  ctx.restore();
}

// ─── Print sheet generator ────────────────────────────────────────────────────

async function generatePrintSheet(
  photoDataUrl: string,
  preset: CountryPreset,
  copies: number,
): Promise<string> {
  // 4×6 inch sheet at 300 DPI
  const sheetW = mmToPx(152.4); // 6 inches
  const sheetH = mmToPx(101.6); // 4 inches
  const photoPxW = preset.exportWidth ?? mmToPx(preset.width);
  const photoPxH = preset.exportHeight ?? mmToPx(preset.height);
  const gap = 10; // px between photos

  const img = await loadImage(photoDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = sheetH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheetW, sheetH);

  const cols = Math.floor((sheetW + gap) / (photoPxW + gap));
  const rows = Math.floor((sheetH + gap) / (photoPxH + gap));
  const actualCopies = Math.min(copies, cols * rows);

  let placed = 0;
  outer: for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (placed >= actualCopies) break outer;
      const x = c * (photoPxW + gap) + gap / 2;
      const y = r * (photoPxH + gap) + gap / 2;
      ctx.drawImage(img, x, y, photoPxW, photoPxH);
      placed++;
    }
  }

  return canvas.toDataURL('image/jpeg', 0.95);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function autoFitFace(
  imageSrc: string,
  preset: CountryPreset,
  displayW: number,
  displayH: number,
): Promise<{ zoom: number; pos: Pos }> {
  const img = await loadImage(imageSrc);
  const DPR = 2;
  const CW = displayW * DPR;
  const CH = displayH * DPR;
  const baseScale = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);

  // Oval center in canvas pixels (mirrors drawGuidelines logic)
  const D = CH / preset.height;
  const avgFace = (preset.faceHeight.min + preset.faceHeight.max) / 2;
  let centerMm: number;
  if (preset.eyeLevel) {
    const avgEye = (preset.eyeLevel.min + preset.eyeLevel.max) / 2;
    centerMm = (preset.height - avgEye) + 0.10 * avgFace;
  } else if (preset.topMargin) {
    centerMm = (preset.topMargin.min + preset.topMargin.max) / 2 + avgFace / 2;
  } else {
    centerMm = preset.height * 0.45;
  }
  const ovalCenterY = centerMm * D;

  // Detect face — fall back to portrait heuristic if API unavailable
  // Heuristic: for a typical headshot the face center is ~25% from top, ~25% of image height
  let faceCX = img.naturalWidth / 2;
  let faceCY = img.naturalHeight * 0.25;
  let faceH = img.naturalHeight * 0.25;

  if ('FaceDetector' in window) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detector = new (window as any).FaceDetector({ fastMode: false, maxDetectedFaces: 1 });
      const faces = await detector.detect(img);
      if (faces.length > 0) {
        const b = faces[0].boundingBox;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const wRatio = b.width / img.naturalWidth;
        const hRatio = b.height / img.naturalHeight;
        // Only trust detection if face is a plausible fraction of the image
        if (cx > 0 && cx < img.naturalWidth && cy > 0 && cy < img.naturalHeight
            && wRatio > 0.05 && wRatio < 0.5
            && hRatio > 0.05 && hRatio < 0.5) {
          faceCX = cx;
          faceCY = cy;
          faceH = b.height; // bbox is roughly chin-to-crown for passport purposes
        }
      }
    } catch { /* unsupported — use heuristic */ }
  }

  // Zoom so face height ≈ avg of min/max face requirement
  const targetFacePx = avgFace * D;
  const scale = targetFacePx / faceH;
  const zoom = Math.max(0.3, Math.min(5, scale / baseScale));
  const actualScale = baseScale * zoom;

  // Shift so face center lands on oval center
  const iw = img.naturalWidth * actualScale;
  const ih = img.naturalHeight * actualScale;
  const posX = (iw / 2 - faceCX * actualScale) / DPR;
  const posY = (ovalCenterY - CH / 2 + ih / 2 - faceCY * actualScale) / DPR;

  return { zoom, pos: { x: posX, y: posY } };
}

// ─── Crop canvas ──────────────────────────────────────────────────────────────

interface CropCanvasProps {
  imageSrc: string;
  preset: CountryPreset;
  zoom: number;
  pos: Pos;
  onZoomChange: (z: number) => void;
  onPosChange: (p: Pos) => void;
}

function CropCanvas({ imageSrc, preset, zoom, pos, onZoomChange, onPosChange }: CropCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragging = useRef(false);
  const lastMouse = useRef<Pos>({ x: 0, y: 0 });
  const pinch = useRef({ active: false, dist: 0, zoom: 1, mid: { x: 0, y: 0 }, pos: { x: 0, y: 0 } });

  // canvas display size — fixed at 280×360 (scaled by css), actual render at 2x
  const DISPLAY_W = 280;
  const DISPLAY_H = Math.round(DISPLAY_W * (preset.height / preset.width));
  const DPR = 2;
  const CW = DISPLAY_W * DPR;
  const CH = DISPLAY_H * DPR;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    canvas.width = CW;
    canvas.height = CH;
    const ctx = canvas.getContext('2d')!;

    const baseScale = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
    const scale = baseScale * zoom;
    const iw = img.naturalWidth * scale;
    const ih = img.naturalHeight * scale;
    const x = CW / 2 - iw / 2 + pos.x * DPR;
    const y = CH / 2 - ih / 2 + pos.y * DPR;

    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, CW, CH);
    ctx.drawImage(img, x, y, iw, ih);
    drawGuidelines(ctx, CW, CH, preset);
  }, [CW, CH, DPR, zoom, pos, preset]);

  useEffect(() => {
    loadImage(imageSrc).then(img => {
      imgRef.current = img;
      draw();
    });
  }, [imageSrc, draw]);

  useEffect(() => { draw(); }, [draw]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    onZoomChange(Math.max(0.3, Math.min(5, zoom - e.deltaY * 0.001)));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    onPosChange({ x: pos.x + dx, y: pos.y + dy });
  };
  const onMouseUp = () => { dragging.current = false; };

  const getTouchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const getTouchMid = (t: React.TouchList) => ({
    x: (t[0].clientX + t[1].clientX) / 2,
    y: (t[0].clientY + t[1].clientY) / 2,
  });

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinch.current = { active: true, dist: getTouchDist(e.touches), zoom, mid: getTouchMid(e.touches), pos };
    } else {
      lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinch.current.active) {
      const ratio = getTouchDist(e.touches) / pinch.current.dist;
      onZoomChange(Math.max(0.3, Math.min(5, pinch.current.zoom * ratio)));
    } else if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - lastMouse.current.x;
      const dy = e.touches[0].clientY - lastMouse.current.y;
      lastMouse.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      onPosChange({ x: pos.x + dx, y: pos.y + dy });
    }
  };
  const onTouchEnd = () => { pinch.current.active = false; };

  return (
    <canvas
      ref={canvasRef}
      style={{ width: DISPLAY_W, height: DISPLAY_H, cursor: 'grab', touchAction: 'none', display: 'block' }}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    />
  );
}

// ─── Export cropped photo ─────────────────────────────────────────────────────

async function exportCroppedPhoto(
  imageSrc: string,
  preset: CountryPreset,
  zoom: number,
  pos: Pos,
  displayW: number,
  displayH: number,
): Promise<string> {
  const outW = preset.exportWidth ?? mmToPx(preset.width);
  const outH = preset.exportHeight ?? mmToPx(preset.height);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);

  const img = await loadImage(imageSrc);
  const DPR = 2;
  const CW = displayW * DPR;
  const CH = displayH * DPR;
  const baseScale = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
  const scale = baseScale * zoom;
  const iw = img.naturalWidth * scale;
  const ih = img.naturalHeight * scale;
  const ix = CW / 2 - iw / 2 + pos.x * DPR;
  const iy = CH / 2 - ih / 2 + pos.y * DPR;

  // map crop canvas coords → output coords
  const scaleOut = outW / CW;
  ctx.drawImage(img, ix * scaleOut, iy * scaleOut, iw * scaleOut, ih * scaleOut);

  if (preset.exportWidth) {
    // digital submissions: JPEG with quality cap
    return canvas.toDataURL('image/jpeg', 0.9);
  }
  return canvas.toDataURL('image/png');
}

// ─── Main Editor Page ─────────────────────────────────────────────────────────

type Step = 'upload' | 'crop' | 'download';

export default function EditorPage({ base = '' }: { base?: string }) {
  const preloaded = (() => {
    if (typeof sessionStorage !== 'undefined') {
      const saved = sessionStorage.getItem('bgRemovedImage');
      if (saved) { sessionStorage.removeItem('bgRemovedImage'); return saved; }
    }
    return null;
  })();
  const [step, setStep] = useState<Step>(preloaded ? 'crop' : 'upload');
  const [imageSrc, setImageSrc] = useState<string | null>(preloaded);
  const [countryKey, setCountryKey] = useState('usa');
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState<Pos>({ x: 0, y: 0 });
  const [croppedUrl, setCroppedUrl] = useState<string | null>(null);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [sheetCopies, setSheetCopies] = useState(4);
  const [processing, setProcessing] = useState(false);
  const [removeBg, setRemoveBg] = useState(false);
  const [bgStatus, setBgStatus] = useState<'idle' | 'loading-model' | 'processing'>('idle');

  const preset = COUNTRY_PRESETS[countryKey];
  const DISPLAY_W = 280;
  const DISPLAY_H = Math.round(DISPLAY_W * (preset.height / preset.width));

  const loadFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setCroppedUrl(null);
    setSheetUrl(null);

    let src: string;
    if (removeBg) {
      try {
        setBgStatus('loading-model');
        const { removeBackground } = await import('@imgly/background-removal');
        setBgStatus('processing');
        const blob = await removeBackground(file, { model: 'isnet', output: { format: 'image/png', quality: 1 } });
        src = await compositeOnWhite(blob);
      } catch {
        src = await new Promise<string>(res => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result as string);
          reader.readAsDataURL(file);
        });
      }
    } else {
      src = await new Promise<string>(res => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.readAsDataURL(file);
      });
    }

    const { zoom: autoZoom, pos: autoPos } = await autoFitFace(src!, preset, DISPLAY_W, DISPLAY_H);
    setZoom(autoZoom);
    setPos(autoPos);
    setImageSrc(src!);
    setBgStatus('idle');
    setStep('crop');
  }, [removeBg, preset, DISPLAY_W, DISPLAY_H]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const onCountryChange = (key: string) => {
    setCountryKey(key);
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };

  const handleCrop = async () => {
    if (!imageSrc) return;
    setProcessing(true);
    try {
      const url = await exportCroppedPhoto(imageSrc, preset, zoom, pos, DISPLAY_W, DISPLAY_H);
      setCroppedUrl(url);
      setStep('download');
    } finally {
      setProcessing(false);
    }
  };

  const handleGenerateSheet = async () => {
    if (!croppedUrl) return;
    setProcessing(true);
    try {
      const url = await generatePrintSheet(croppedUrl, preset, sheetCopies);
      setSheetUrl(url);
    } finally {
      setProcessing(false);
    }
  };

  const reset = () => {
    setStep('upload');
    setImageSrc(null);
    setCroppedUrl(null);
    setSheetUrl(null);
    setZoom(1);
    setPos({ x: 0, y: 0 });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold mb-1">Passport Photo Editor</h1>
      <p className="text-gray-500 mb-8">Upload, crop, and download a print-ready passport photo.</p>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        {(['upload', 'crop', 'download'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs
              ${step === s ? 'bg-indigo-600 text-white' :
                (step === 'crop' && s === 'upload') || step === 'download'
                  ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-200 text-gray-400'}`}>
              {i + 1}
            </div>
            <span className={step === s ? 'font-semibold text-indigo-700' : 'text-gray-400'}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </span>
            {i < 2 && <span className="text-gray-300 mx-1">→</span>}
          </div>
        ))}
      </div>

      {/* ── Upload ── */}
      {step === 'upload' && (
        <div className="space-y-4">
          <div className="relative">
            <div
              className="border-2 border-dashed border-gray-300 rounded-2xl p-16 text-center hover:border-green-400 transition-colors cursor-pointer"
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => document.getElementById('file-input')?.click()}
            >
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="m21 15-5-5L5 21"/>
              </svg>
              <p className="text-lg font-medium text-gray-600 mb-1">Click to upload or drag & drop</p>
              <p className="text-sm text-gray-400">PNG, JPG, WEBP — any portrait photo</p>
              <input id="file-input" type="file" accept="image/*" className="hidden" onChange={onFile} />
            </div>
            {bgStatus !== 'idle' && (
              <div className="absolute inset-0 bg-white/80 rounded-2xl flex flex-col items-center justify-center gap-3">
                <div className="w-10 h-10 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-gray-700 font-medium">
                  {bgStatus === 'loading-model' ? 'Loading AI model…' : 'Removing background…'}
                </p>
                <p className="text-sm text-gray-400">This may take a moment on first use</p>
              </div>
            )}
          </div>
          <label className="flex items-center gap-3 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              checked={removeBg}
              onChange={e => setRemoveBg(e.target.checked)}
              className="w-4 h-4 accent-indigo-600"
            />
            <span className="text-sm text-gray-700 font-medium">Remove background automatically (AI, runs in browser)</span>
          </label>
        </div>
      )}

      {/* ── Crop ── */}
      {step === 'crop' && imageSrc && (
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Controls */}
          <div className="flex-1 space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Country / Format</label>
              <select
                value={countryKey}
                onChange={e => onCountryChange(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {Object.entries(COUNTRY_PRESETS).map(([key, p]) => (
                  <option key={key} value={key}>{p.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">{preset.description}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Zoom — {zoom.toFixed(2)}×
              </label>
              <input
                type="range" min="0.3" max="5" step="0.01" value={zoom}
                onChange={e => setZoom(Number(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>

            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-sm text-indigo-800">
              <p className="font-medium mb-1">How to crop</p>
              <ul className="space-y-0.5 text-xs text-indigo-700 list-disc list-inside">
                <li>Drag to pan the image</li>
                <li>Scroll wheel or slider to zoom</li>
                <li>Align your face between the <span className="text-indigo-600 font-medium">green</span> (min) and <span className="text-orange-500 font-medium">orange</span> (max) ovals</li>
                <li>Face should fill the ovals chin-to-crown</li>
              </ul>
            </div>

            <div className="flex gap-3">
              <button
                onClick={reset}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition-colors"
              >
                ← Back
              </button>
              <button
                onClick={handleCrop}
                disabled={processing}
                className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {processing ? 'Processing…' : 'Crop & Continue →'}
              </button>
            </div>
          </div>

          {/* Canvas */}
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl overflow-hidden shadow-lg border border-gray-200" style={{ width: DISPLAY_W }}>
              <CropCanvas
                imageSrc={imageSrc}
                preset={preset}
                zoom={zoom}
                pos={pos}
                onZoomChange={setZoom}
                onPosChange={setPos}
              />
            </div>
            <p className="text-xs text-gray-400">
              {preset.width}×{preset.height} mm — drag to position
            </p>
          </div>
        </div>
      )}

      {/* ── Download ── */}
      {step === 'download' && croppedUrl && (
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Preview */}
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-xl overflow-hidden shadow-lg border border-gray-200">
              <img src={croppedUrl} alt="Cropped passport photo" style={{ display: 'block', maxWidth: 280 }} />
            </div>
            <p className="text-xs text-gray-400">{preset.label}</p>
          </div>

          {/* Actions */}
          <div className="flex-1 space-y-5">
            <div>
              <h2 className="text-xl font-semibold mb-1">Your photo is ready!</h2>
              <p className="text-sm text-gray-500">Download the single photo or generate a print-ready 4×6 sheet.</p>
            </div>

            <a
              href={croppedUrl}
              download={`passport-photo-${countryKey}.${preset.exportWidth ? 'jpg' : 'png'}`}
              className="flex items-center justify-center gap-2 w-full py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <path d="m7 10 5 5 5-5"/>
              </svg>
              Download Single Photo
            </a>

            <div className="border rounded-xl p-4 space-y-3">
              <h3 className="font-medium text-sm">Print Sheet (4×6 inch)</h3>
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-600">Copies:</label>
                <input
                  type="number" min={1} max={12} value={sheetCopies}
                  onChange={e => { setSheetCopies(Number(e.target.value)); setSheetUrl(null); }}
                  className="w-16 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <button
                onClick={handleGenerateSheet}
                disabled={processing}
                className="w-full py-2 border-2 border-indigo-600 text-indigo-600 rounded-lg text-sm font-semibold hover:bg-indigo-50 disabled:opacity-50 transition-colors"
              >
                {processing ? 'Generating…' : 'Generate Print Sheet'}
              </button>
              {sheetUrl && (
                <a
                  href={sheetUrl}
                  download={`passport-photo-sheet-${countryKey}.jpg`}
                  className="flex items-center justify-center gap-2 w-full py-2 bg-gray-800 text-white rounded-lg text-sm font-semibold hover:bg-gray-700 transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <path d="m7 10 5 5 5-5"/>
                  </svg>
                  Download Print Sheet
                </a>
              )}
              {sheetUrl && (
                <img src={sheetUrl} alt="Print sheet preview" className="w-full rounded border mt-2" />
              )}
            </div>

            <button
              onClick={() => { setStep('crop'); setCroppedUrl(null); setSheetUrl(null); }}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← Re-crop
            </button>
            <button
              onClick={reset}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              Upload new photo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
