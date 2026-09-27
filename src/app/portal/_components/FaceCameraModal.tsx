"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle, RefreshCw } from 'lucide-react';
import Modal from '@/components/ui/Modal';

/** Width of the image sent to the server (the face service downsizes to 640 anyway). */
const CAPTURE_WIDTH = 640;
const JPEG_QUALITY = 0.85;
/** Width / height of the preview box (aspect-[3/4]); the capture keeps exactly what the preview shows. */
const PREVIEW_ASPECT = 3 / 4;

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'تم رفض إذن الكاميرا. اسمح للموقع باستخدام الكاميرا ثم أعد المحاولة: في iPhone من الإعدادات > Safari > الكاميرا، وفي Android من رمز القفل بجانب عنوان الموقع > الأذونات.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'لم يتم العثور على كاميرا أمامية في هذا الجهاز.';
    case 'NotReadableError':
      return 'الكاميرا مستخدمة من تطبيق آخر. أغلقه ثم أعد المحاولة.';
    default:
      return 'تعذر تشغيل الكاميرا. أعد المحاولة.';
  }
}

interface FaceCameraModalProps {
  open: boolean;
  onClose: () => void;
  /** Receives the confirmed JPEG capture. */
  onCapture: (image: Blob) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  busy?: boolean;
  /** Why the last submission failed (shown in the dialog, next to the buttons). */
  error?: string | null;
  /** Live status line under the preview (e.g. the location fix). */
  hint?: React.ReactNode;
}

/**
 * Live front-camera capture (no gallery upload). Shows a mirrored preview with an oval guide,
 * captures a still into a canvas and hands back a JPEG after the employee confirms it.
 */
export default function FaceCameraModal({ open, onClose, onCapture, title, description, confirmLabel, busy, error, hint }: FaceCameraModalProps) {
  // The body mounts only while the dialog is open, so every opening starts with a fresh state.
  return (
    <Modal open={open} onClose={onClose} busy={busy} tone="emerald" icon={<Camera size={22} />} title={title} description={description} size="md">
      <CameraBody onCapture={onCapture} confirmLabel={confirmLabel} busy={busy} submitError={error} hint={hint} />
    </Modal>
  );
}

/** Why the camera cannot work in this browser at all (checked before asking for permission). */
function cameraSupportProblem(): string | null {
  if (typeof window === 'undefined') return null;
  if (!window.isSecureContext) return 'الكاميرا تعمل فقط عبر اتصال آمن (https).';
  if (!navigator.mediaDevices?.getUserMedia) return 'المتصفح لا يدعم تشغيل الكاميرا. استخدم Safari أو Chrome بإصدار حديث.';
  return null;
}

interface CameraBodyProps extends Pick<FaceCameraModalProps, 'onCapture' | 'confirmLabel' | 'busy' | 'hint'> {
  submitError?: string | null;
}

function CameraBody({ onCapture, confirmLabel, busy, hint, submitError }: CameraBodyProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(cameraSupportProblem);
  /** A camera stream is open (permission granted). */
  const [streaming, setStreaming] = useState(false);
  /** The preview has real dimensions (loadedmetadata): only then can a frame be captured. */
  const [ready, setReady] = useState(false);
  /** The browser refused to autoplay the preview: one tap starts it. */
  const [needsTap, setNeedsTap] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  /** Incremented by "retake" to (re)open the camera. */
  const [attempt, setAttempt] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStreaming(false);
    setReady(false);
  }, []);

  const startPreview = useCallback((video: HTMLVideoElement, stream: MediaStream) => {
    video.srcObject = stream;
    video.play().then(
      () => setNeedsTap(false),
      () => setNeedsTap(true),
    );
  }, []);

  // Opens the front camera (an external resource); state changes only in the promise callbacks.
  useEffect(() => {
    if (cameraSupportProblem()) return;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(
        (stream) => {
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          // The camera can stop on its own (another app took it, the phone was locked).
          stream.getVideoTracks()[0]?.addEventListener('ended', () => {
            if (streamRef.current !== stream) return;
            stopStream();
            setError('توقفت الكاميرا. اضغط «إعادة المحاولة».');
          });
          const video = videoRef.current;
          if (video) startPreview(video, stream);
          setStreaming(true);
        },
        (err: unknown) => {
          if (!cancelled) setError(cameraErrorMessage(err));
        },
      );
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [attempt, stopStream, startPreview]);

  // (Re)attach the stream once the <video> is mounted (after a retake it replaces the <img>).
  useEffect(() => {
    const video = videoRef.current;
    if (!streaming || shot || !video || !streamRef.current || video.srcObject === streamRef.current) return;
    startPreview(video, streamRef.current);
  }, [streaming, shot, startPreview]);

  // Release the preview URL when it is replaced or the dialog closes.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    // Same center crop as the preview's object-cover: a landscape laptop webcam would otherwise send
    // the whole wide frame, where the face is too small for enrollment.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sw = vw / vh > PREVIEW_ASPECT ? Math.round(vh * PREVIEW_ASPECT) : vw;
    const sh = vw / vh > PREVIEW_ASPECT ? vh : Math.round(vw / PREVIEW_ASPECT);
    const scale = Math.min(1, CAPTURE_WIDTH / sw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('تعذر التقاط الصورة في هذا المتصفح.');
      return;
    }
    // The preview is mirrored for comfort; the captured image keeps the real orientation.
    ctx.drawImage(video, Math.round((vw - sw) / 2), Math.round((vh - sh) / 2), sw, sh, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError('تعذر التقاط الصورة. اضغط «إعادة المحاولة».');
          return;
        }
        setShot({ blob, url: URL.createObjectURL(blob) });
        stopStream();
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  };

  const retake = () => {
    setShot(null);
    setError(cameraSupportProblem());
    setAttempt((n) => n + 1);
  };

  const tapToStart = () => {
    const video = videoRef.current;
    if (!video) return;
    video.play().then(
      () => setNeedsTap(false),
      () => setError('تعذر تشغيل الكاميرا. أعد المحاولة.'),
    );
  };

  return (
    <div className="p-5 md:p-6 space-y-4">
      {/* Sized from the viewport height too, so the buttons stay on screen in a phone's bottom sheet. */}
      <div className="relative mx-auto w-[min(100%,34dvh)] min-w-[200px] max-w-sm aspect-[3/4] rounded-3xl overflow-hidden bg-slate-900">
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not an optimizable asset
          <img src={shot.url} alt="الصورة الملتقطة" className="w-full h-full object-cover" />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            onLoadedMetadata={() => setReady(true)}
            onPlaying={() => setReady(true)}
            className="w-full h-full object-cover [transform:scaleX(-1)]"
            aria-label="معاينة الكاميرا الأمامية"
          />
        )}
        {!shot && ready && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="w-[62%] aspect-[3/4] rounded-[50%] border-4 border-white/80 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]" />
          </div>
        )}
        {!shot && !ready && !error && !needsTap && (
          <p className="absolute inset-0 flex items-center justify-center text-white/80 font-bold text-[13px]">جاري تشغيل الكاميرا...</p>
        )}
        {!shot && needsTap && !error && (
          <button type="button" onClick={tapToStart} className="absolute inset-0 flex items-center justify-center text-white font-black text-[14px] bg-slate-900/60">
            اضغط هنا لتشغيل الكاميرا
          </button>
        )}
      </div>

      {error ? (
        <div role="alert" className="bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl p-3 text-[13px] font-bold leading-relaxed">{error}</div>
      ) : (
        <p className="text-[12px] font-bold text-slate-500 text-center leading-relaxed">
          اجعل وجهك داخل الإطار في مكان مضاء، وانظر مباشرة إلى الكاميرا. لا تستخدم صورة أو شاشة.
        </p>
      )}

      {submitError && (
        <div role="alert" className="bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl p-3 text-[13px] font-bold leading-relaxed">{submitError}</div>
      )}

      {hint && (
        <div role="status" aria-live="polite">
          {hint}
        </div>
      )}

      {/* Stays visible at the bottom of the sheet even when the content above scrolls. */}
      <div className="sticky bottom-0 -mx-5 md:-mx-6 px-5 md:px-6 py-3 bg-white flex gap-3">
        {shot ? (
          <>
            <button type="button" onClick={() => onCapture(shot.blob)} disabled={busy} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50 flex items-center justify-center gap-2">
              <CheckCircle size={18} aria-hidden="true" /> {busy ? 'جاري الإرسال...' : confirmLabel}
            </button>
            <button type="button" onClick={retake} disabled={busy} className="px-5 bg-slate-100 hover:bg-slate-200 text-slate-700 py-3.5 rounded-2xl font-bold transition disabled:opacity-50 flex items-center gap-2">
              <RefreshCw size={16} aria-hidden="true" /> إعادة
            </button>
          </>
        ) : error ? (
          <button type="button" onClick={retake} className="flex-1 bg-slate-800 hover:bg-slate-900 text-white py-3.5 rounded-2xl font-black transition">
            إعادة المحاولة
          </button>
        ) : (
          <button type="button" onClick={capture} disabled={!ready} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white py-3.5 rounded-2xl font-black transition disabled:opacity-50 flex items-center justify-center gap-2">
            <Camera size={18} aria-hidden="true" /> التقاط الصورة
          </button>
        )}
      </div>
    </div>
  );
}
