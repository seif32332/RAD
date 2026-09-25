"use client";

import React, { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, UserPen } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { readApiError, toast } from "@/components/ui/feedback";
import { uploadFile, validateUploadFile } from "@/components/upload-client";

const AVATAR_ACCEPT = ".jpg,.jpeg,.png,.webp,.gif";

interface EditProfileModalProps {
  initialName: string;
  initialAvatarUrl: string | null;
  onClose: () => void;
  /** Called after the server accepted the change (the shell re-reads the session). */
  onSaved: () => void | Promise<void>;
}

export default function EditProfileModal({ initialName, initialAvatarUrl, onClose, onSaved }: EditProfileModalProps) {
  const [name, setName] = useState(initialName);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(initialAvatarUrl);
  const [isSaving, setIsSaving] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Release the preview object URL when the modal closes.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = validateUploadFile(file, AVATAR_ACCEPT);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setAvatarFile(file);
    setAvatarPreview(objectUrlRef.current);
  };

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isSaving) return;
    setIsSaving(true);
    try {
      let avatarUrl = initialAvatarUrl;
      if (avatarFile) avatarUrl = (await uploadFile(avatarFile)).url;

      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, avatarUrl }),
      });
      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!res.ok) {
        toast.error(await readApiError(res, "فشل في تحديث الملف الشخصي"));
        return;
      }
      toast.success("تم تحديث الملف الشخصي بنجاح");
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "فشل في تحديث الملف الشخصي");
    } finally {
      setIsSaving(false);
    }
  };

  // Accessible dialog (focus trap, Escape, focus restore) from the shared <Modal>.
  return (
    <Modal open onClose={onClose} busy={isSaving} tone="blue" size="sm" icon={<UserPen size={22} />} title="تعديل الملف الشخصي">
      <form onSubmit={save} className="p-6 md:p-8">
        {/* Avatar Upload */}
        <div className="flex justify-center mb-6">
          <button
            type="button"
            className="relative group cursor-pointer rounded-2xl focus:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30"
            onClick={() => avatarInputRef.current?.click()}
            aria-label="تغيير الصورة الشخصية"
            disabled={isSaving}
          >
            <span className="block w-24 h-24 rounded-2xl overflow-hidden border-4 border-white shadow-lg">
              {avatarPreview ? (
                // eslint-disable-next-line @next/next/no-img-element -- user uploads / blob previews
                <img src={avatarPreview} alt="الصورة الشخصية" className="w-full h-full object-cover" />
              ) : (
                <span className="w-full h-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-black text-3xl">
                  {name.trim().charAt(0) || "م"}
                </span>
              )}
            </span>
            <span className="absolute inset-0 rounded-2xl bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
              <Camera size={24} className="text-white" />
            </span>
            <span className="absolute -bottom-1 -right-1 w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center shadow-md border-2 border-white">
              <Camera size={12} className="text-white" />
            </span>
          </button>
          <input
            ref={avatarInputRef}
            type="file"
            accept={AVATAR_ACCEPT}
            onChange={handleAvatarSelect}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
        <p className="text-center text-[12px] text-slate-500 font-bold mb-6">اضغط على الصورة لتغييرها</p>

        <div className="mb-6">
          <label htmlFor="profile-display-name" className="block text-[13px] font-black text-slate-700 mb-2 text-right">
            الاسم المعروض
          </label>
          <input
            id="profile-display-name"
            type="text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="أدخل اسمك هنا..."
            className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-slate-50 text-right text-[14px] font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
          />
        </div>

        <button
          type="submit"
          disabled={isSaving || !name.trim()}
          className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[14px] transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving ? (
            <>
              <Loader2 size={18} className="animate-spin" /> جاري الحفظ...
            </>
          ) : (
            <>
              <CheckCircle2 size={18} /> حفظ التعديلات
            </>
          )}
        </button>
      </form>
    </Modal>
  );
}
