export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" aria-hidden="true" />
        <p className="text-[13px] font-bold text-slate-400">جاري التحميل...</p>
      </div>
    </div>
  );
}
