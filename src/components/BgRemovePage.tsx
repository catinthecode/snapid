import { useState, useRef, useCallback } from 'react';

async function compositeOnWhite(blob: Blob): Promise<Blob> {
  const bitmapUrl = URL.createObjectURL(blob);
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = rej;
    el.src = bitmapUrl;
  });
  URL.revokeObjectURL(bitmapUrl);

  const w = img.naturalWidth;
  const h = img.naturalHeight;

  // Step 1: draw the RGBA cutout so we can access pixel data
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tc = tmp.getContext('2d')!;
  tc.drawImage(img, 0, 0);

  // Step 2: clean up the alpha channel
  //  • Pixels nearly transparent (< 15/255 ≈ 6%) → fully transparent.
  //    Removes isolated background speckles and fringe strips the AI missed.
  //  • Pixels mostly opaque (> 240/255 ≈ 94%) → fully opaque.
  //    Avoids a semi-transparent halo around hair/shoulders on the white bg.
  const id = tc.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] < 15) d[i] = 0;
    else if (d[i] > 240) d[i] = 255;
  }
  tc.putImageData(id, 0, 0);

  // Step 3: composite the cleaned RGBA onto white
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const oc = out.getContext('2d')!;
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, w, h);
  oc.drawImage(tmp, 0, 0);

  return new Promise<Blob>((res, rej) =>
    out.toBlob(b => b ? res(b) : rej(new Error('Canvas toBlob failed')), 'image/jpeg', 0.95),
  );
}

type Status = 'idle' | 'loading-model' | 'processing' | 'done' | 'error';

export default function BgRemovePage({ base = '' }: { base?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;

    const original = URL.createObjectURL(file);
    setOriginalUrl(original);
    setResultUrl(null);
    setShowOriginal(false);
    setProgress(0);
    setErrorMsg('');

    try {
      setStatus('loading-model');

      // Dynamically import so the heavy WASM only loads when used
      const { removeBackground } = await import('@imgly/background-removal');

      setStatus('processing');

      const resultBlob = await removeBackground(file, {
        // isnet = full-precision model; better than default isnet_fp16 for
        // complex backgrounds, hair, and clothing edges.
        model: 'isnet',
        progress: (key: string, current: number, total: number) => {
          if (total > 0) setProgress(Math.round((current / total) * 100));
        },
        output: {
          format: 'image/png',
          quality: 1,
        },
      });

      // Composite the cutout onto a white canvas — passport photos require white background
      const whiteBlob = await compositeOnWhite(resultBlob);
      const url = URL.createObjectURL(whiteBlob);
      // Blob URLs survive same-tab navigation — store the short URL string, not the data
      sessionStorage.setItem('bgRemovedImage', url);
      setResultUrl(url);
      setStatus('done');
    } catch (err) {
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : 'Background removal failed.');
      setStatus('error');
    }
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const reset = () => {
    setStatus('idle');
    setOriginalUrl(null);
    setResultUrl(null);
    setProgress(0);
    setErrorMsg('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold mb-1">Remove Background</h1>
      <p className="text-gray-500 mb-2">
        AI-powered background removal — runs entirely in your browser, nothing is uploaded.
      </p>
      <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-8">
        The AI model downloads once and is cached. First run may take 15–40 seconds depending on your connection.
      </p>

      {/* Upload zone */}
      {status === 'idle' && (
        <div
          className="border-2 border-dashed border-gray-300 rounded-2xl p-16 text-center hover:border-green-400 transition-colors cursor-pointer"
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/>
            <path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/>
            <path d="M14.8 14.8 20 20"/>
          </svg>
          <p className="text-lg font-medium text-gray-600 mb-1">Click to upload or drag & drop</p>
          <p className="text-sm text-gray-400">PNG, JPG, WEBP</p>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
        </div>
      )}

      {/* Processing state */}
      {(status === 'loading-model' || status === 'processing') && (
        <div className="text-center py-16 space-y-4">
          <div className="w-16 h-16 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mx-auto" />
          <p className="font-medium text-gray-700">
            {status === 'loading-model' ? 'Loading AI model…' : 'Removing background…'}
          </p>
          {progress > 0 && (
            <div className="max-w-xs mx-auto">
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-1">{progress}%</p>
            </div>
          )}
          {originalUrl && (
            <img src={originalUrl} alt="Original" className="max-h-48 mx-auto rounded-lg opacity-40 mt-4" />
          )}
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="text-center py-12 space-y-4">
          <p className="text-red-600 font-medium">Something went wrong</p>
          <p className="text-sm text-gray-500">{errorMsg}</p>
          <button onClick={reset} className="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
            Try again
          </button>
        </div>
      )}

      {/* Result */}
      {status === 'done' && resultUrl && originalUrl && (
        <div className="space-y-6">
          {/* Before / After toggle */}
          <div className="flex justify-center gap-2">
            <button
              onClick={() => setShowOriginal(false)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${!showOriginal ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Result
            </button>
            <button
              onClick={() => setShowOriginal(true)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${showOriginal ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Original
            </button>
          </div>

          {/* Image preview */}
          <div className="flex justify-center">
            <div className="rounded-2xl overflow-hidden shadow-lg border border-gray-200 max-w-md bg-white">
              <img
                src={showOriginal ? originalUrl : resultUrl}
                alt={showOriginal ? 'Original' : 'White background applied'}
                className="block max-w-full"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href={resultUrl}
              download="white-background.jpg"
              className="flex items-center justify-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <path d="m7 10 5 5 5-5"/>
              </svg>
              Download (White Background)
            </a>
            <a
              href={`${base}/editor`}
              className="flex items-center justify-center gap-2 px-6 py-3 border-2 border-green-600 text-green-600 rounded-lg font-semibold hover:bg-green-50 transition-colors"
            >
              Continue to Editor →
            </a>
            <button
              onClick={reset}
              className="px-6 py-3 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              New image
            </button>
          </div>

          <p className="text-center text-xs text-gray-400">
            Download the PNG, then upload it in the editor to crop to your country's passport size.
          </p>
        </div>
      )}
    </div>
  );
}
