"use client";

import React, { useId, useRef, useState } from 'react';
import { Upload, FileCheck, X, Loader2, ExternalLink } from 'lucide-react';
import { toast } from '@/components/ui/feedback';
import { DEFAULT_UPLOAD_ACCEPT, fileNameFromUrl, uploadFile, validateUploadFile } from '@/components/upload-client';

/** Minimal change-event shape passed to onChange (compatible with input change handlers). */
export interface FileFieldChangeEvent {
  target: { name: string; value: string };
}

interface FileUploadFieldProps {
  /** Employee the document belongs to (sets its owner for access control). */
  employeeId?: string | null;
  label: string;
  name: string;
  value: string;
  // Method syntax keeps handlers typed as React.ChangeEvent<...> assignable.
  onChange(e: FileFieldChangeEvent): void;
  accept?: string;
  required?: boolean;
  disabled?: boolean;
}

export default function FileUploadField({ label, name, value, onChange, accept, required = false, disabled = false, employeeId }: FileUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  // Name of the file uploaded in this session; existing values fall back to a name derived from the URL.
  const [uploaded, setUploaded] = useState<{ url: string; name: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const labelId = useId();
  const acceptList = accept || DEFAULT_UPLOAD_ACCEPT;

  const fileName = uploaded && uploaded.url === value ? uploaded.name : fileNameFromUrl(value);

  const handleUpload = async (file: File) => {
    if (isUploading || disabled) return;
    const problem = validateUploadFile(file, acceptList);
    if (problem) {
      toast.error(problem);
      return;
    }
    setIsUploading(true);
    try {
      const result = await uploadFile(file, { field: name, employeeId });
      setUploaded({ url: result.url, name: file.name });
      onChange({ target: { name, value: result.url } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'فشل في رفع الملف');
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleUpload(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleUpload(file);
  };

  const handleRemove = () => {
    setUploaded(null);
    onChange({ target: { name, value: '' } });
    if (inputRef.current) inputRef.current.value = '';
  };

  const hasFile = !!value;

  return (
    <div className="flex flex-col gap-2 group w-full">
      <span id={labelId} className="text-[12px] font-extrabold text-slate-800 transition-colors group-hover:text-blue-600">
        {label} {required && <span className="text-red-500 font-bold" aria-hidden="true">*</span>}
      </span>

      <input
        ref={inputRef}
        type="file"
        accept={acceptList}
        onChange={handleFileChange}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      <div className="relative">
        {/* Carries `required` for native form validation (hidden/file inputs cannot). */}
        {required && (
          <input
            value={value}
            required
            onChange={() => {}}
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            style={{ bottom: 0, right: '50%' }}
            ref={(el) => el?.setCustomValidity(value ? '' : `يرجى إرفاق ${label}`)}
          />
        )}

        {!hasFile ? (
          /* Drop Zone */
          <button
            type="button"
            aria-labelledby={labelId}
            aria-busy={isUploading}
            disabled={disabled || isUploading}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`
              relative w-full cursor-pointer rounded-[1.25rem] border-2 border-dashed transition-all duration-200 focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-100
              ${dragActive ? 'border-blue-400 bg-blue-50/80 scale-[1.01]' : 'border-slate-200 bg-[#F4F4F6] hover:border-blue-300 hover:bg-blue-50/30'}
              ${isUploading ? 'pointer-events-none opacity-70' : ''}
              ${disabled ? 'cursor-not-allowed opacity-60' : ''}
            `}
          >
            <div className="flex flex-col items-center justify-center py-6 px-4 gap-2">
              {isUploading ? (
                <>
                  <Loader2 size={28} className="text-blue-500 animate-spin" />
                  <p className="text-[12px] font-bold text-blue-600">جاري رفع الملف...</p>
                </>
              ) : (
                <>
                  <div className="w-11 h-11 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-1">
                    <Upload size={20} className="text-blue-500" />
                  </div>
                  <p className="text-[13px] font-bold text-slate-600">
                    اضغط لاختيار ملف <span className="text-slate-400">أو اسحب وأفلت هنا</span>
                  </p>
                  <p className="text-[10px] font-bold text-slate-400">PDF, صور, Word, Excel — حتى 10 ميجابايت</p>
                </>
              )}
            </div>
          </button>
        ) : (
          /* File Attached State */
          <div className="flex items-center gap-3 px-4 py-3 bg-emerald-50 border-2 border-emerald-200 rounded-[1.25rem] transition-all">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 border border-emerald-200 flex items-center justify-center shrink-0">
              <FileCheck size={20} className="text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-black text-emerald-800 truncate" title={fileName || undefined} dir="auto">
                {fileName || 'ملف مرفق'}
              </p>
              <p className="text-[10px] font-bold text-emerald-500">تم الرفع بنجاح ✓</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <a
                href={value}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`عرض الملف: ${fileName || label}`}
                className="w-8 h-8 rounded-lg bg-emerald-100 hover:bg-emerald-200 flex items-center justify-center text-emerald-600 transition"
              >
                <ExternalLink size={14} />
              </a>
              {!disabled && (
                <button
                  type="button"
                  onClick={handleRemove}
                  aria-label={`إزالة الملف: ${fileName || label}`}
                  className="w-8 h-8 rounded-lg bg-red-50 hover:bg-red-100 flex items-center justify-center text-red-500 transition"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
