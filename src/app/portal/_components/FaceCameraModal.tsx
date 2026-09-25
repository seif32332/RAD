"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle, RefreshCw } from 'lucide-react';
import Modal from '@/components/ui/Modal';

/** Width of the image sent to the server (the face service downsizes to 640 anyway). */
const CAPTURE_WIDTH = 640;
const JPEG_QUALITY = 0.85;

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
}

/**
 * Live front-camera capture (no gallery upload). Shows a mirrored preview with an oval guide,
 * captures a still into a canvas and hands back a JPEG after the employee confirms it.
 */
export default function FaceCameraModal({ open, onClose, onCapture, title, description, confirmLabel, busy }: FaceCameraModalProps) {
  // The body mounts only while the dialog is open, so every opening starts with a fresh state.
  return (
    <Modal open={open} onClose={onClose} busy={busy} tone="emerald" icon={<Camera size={22} />} title={title} description={description} size="md">
      <CameraBody onCapture={onCapture} confirmLabel={confirmLabel} busy={busy} />
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

function CameraBody({ onCapture, confirmLabel, busy }: Pick<FaceCameraModalProps, 'onCapture' | 'confirmLabel' | 'busy'>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(cameraSupportProblem);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  /** Incremented by "retake" to (re)open the camera. */
  const [attempt, setAttempt] = useState(0);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
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
          const video = videoRef.current;
          if (video) {
            video.srcObject = stream;
            void video.play().catch(() => undefined);
          }
          setReady(true);
        },
        (err: unknown) => {
          if (!cancelled) setError(cameraErrorMessage(err));
        },
      );
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [attempt, stopStream]);

  // (Re)attach the stream once the <video> is mounted (after a retake it replaces the <img>).
  useEffect(() => {
    const video = videoRef.current;
    if (!ready || shot || !video || !streamRef.current || video.srcObject === streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => undefined);
  }, [ready, shot]);

  // Release the preview URL when it is replaced or the dialog closes.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, CAPTURE_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The preview is mirrored for comfort; the captured image keeps the real orientation.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
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

  return (
      <div className="p-5 md:p-6 space-y-4">
        <div className="relative mx-auto w-full max-w-sm aspect-[3/4] rounded-3xl overflow-hidden bg-slate-900">
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not an optimizable asset
            <img src={shot.url} alt="الصورة الملتقطة" className="w-full h-full object-cover" />
          ) : (
            <video ref={videoRef} playsInline muted autoPlay className="w-full h-full object-cover [transform:scaleX(-1)]" aria-label="معاينة الكاميرا الأمامية" />
          )}
          {!shot && ready && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-[62%] aspect-[3/4] rounded-[50%] border-4 border-white/80 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]" />
            </div>
          )}
          {!shot && !ready && !error && (
            <p className="absolute inset-0 flex items-center justify-center text-white/80 font-bold text-[13px]">جاري تشغيل الكاميرا...</p>
          )}
        </div>

        {error ? (
          <div role="alert" className="bg-rose-50 border border-rose-100 text-rose-800 rounded-2xl p-3 text-[13px] font-bold leading-relaxed">{error}</div>
        ) : (
          <p className="text-[12px] font-bold text-slate-500 text-center leading-relaxed">
            اجعل وجهك داخل الإطار في مكان مضاء، وانظر مباشرة إلى الكاميرا. لا تستخدم صورة أو شاشة.
          </p>
        )}

        <div className="flex gap-3">
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
