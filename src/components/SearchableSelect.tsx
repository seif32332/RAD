"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';

interface Option {
  label: string;
  value: string;
}

/** Minimal change-event shape passed to onChange (compatible with input change handlers). */
export interface SelectChangeEvent {
  target: { name: string; value: string };
}

interface SearchableSelectProps {
  name: string;
  value: string;
  // Method syntax keeps handlers typed as React.ChangeEvent<...> assignable.
  onChange(e: SelectChangeEvent): void;
  label: string;
  options: Option[];
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  accentColor?: string; // tailwind color like 'indigo', 'teal', 'red', 'orange'
}

/** Static class lists (Tailwind cannot see dynamically built class names). */
const COLOR_MAP: Record<string, { ring: string; border: string; bg: string; text: string; dot: string }> = {
  indigo: { ring: 'focus-within:ring-indigo-100 focus:ring-indigo-100', border: 'border-indigo-400', bg: 'bg-indigo-50', text: 'text-indigo-600', dot: 'bg-indigo-500' },
  teal: { ring: 'focus-within:ring-teal-100 focus:ring-teal-100', border: 'border-teal-400', bg: 'bg-teal-50', text: 'text-teal-600', dot: 'bg-teal-500' },
  red: { ring: 'focus-within:ring-red-100 focus:ring-red-100', border: 'border-red-400', bg: 'bg-red-50', text: 'text-red-600', dot: 'bg-red-500' },
  orange: { ring: 'focus-within:ring-orange-100 focus:ring-orange-100', border: 'border-orange-400', bg: 'bg-orange-50', text: 'text-orange-600', dot: 'bg-orange-500' },
  blue: { ring: 'focus-within:ring-blue-100 focus:ring-blue-100', border: 'border-blue-400', bg: 'bg-blue-50', text: 'text-blue-600', dot: 'bg-blue-500' },
  amber: { ring: 'focus-within:ring-amber-100 focus:ring-amber-100', border: 'border-amber-400', bg: 'bg-amber-50', text: 'text-amber-600', dot: 'bg-amber-500' },
  emerald: { ring: 'focus-within:ring-emerald-100 focus:ring-emerald-100', border: 'border-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-600', dot: 'bg-emerald-500' },
  violet: { ring: 'focus-within:ring-violet-100 focus:ring-violet-100', border: 'border-violet-400', bg: 'bg-violet-50', text: 'text-violet-600', dot: 'bg-violet-500' },
  rose: { ring: 'focus-within:ring-rose-100 focus:ring-rose-100', border: 'border-rose-400', bg: 'bg-rose-50', text: 'text-rose-600', dot: 'bg-rose-500' },
  purple: { ring: 'focus-within:ring-purple-100 focus:ring-purple-100', border: 'border-purple-400', bg: 'bg-purple-50', text: 'text-purple-600', dot: 'bg-purple-500' },
  slate: { ring: 'focus-within:ring-slate-100 focus:ring-slate-100', border: 'border-slate-400', bg: 'bg-slate-100', text: 'text-slate-700', dot: 'bg-slate-500' },
};

export default function SearchableSelect({
  name,
  value,
  onChange,
  label,
  options,
  required = false,
  placeholder = '— اختر —',
  disabled = false,
  accentColor = 'indigo',
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const validityInputRef = useRef<HTMLInputElement>(null);

  const baseId = useId();
  const labelId = `${baseId}-label`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, search]);

  const selectedOption = options.find((o) => o.value === value);
  const colors = COLOR_MAP[accentColor] || COLOR_MAP.indigo;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) searchInputRef.current?.focus();
  }, [isOpen]);

  // Arabic validation message instead of the browser's generic one.
  useEffect(() => {
    validityInputRef.current?.setCustomValidity(required && !value ? 'يرجى اختيار ' + label : '');
  }, [required, value, label]);

  // Keep the highlighted option visible while navigating with the keyboard.
  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, isOpen]);

  const open = () => {
    if (disabled) return;
    const selectedIdx = options.findIndex((o) => o.value === value);
    setSearch('');
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : options.length > 0 ? 0 : -1);
    setIsOpen(true);
  };

  const close = (returnFocus = true) => {
    setIsOpen(false);
    setSearch('');
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  };

  const handleSelect = (val: string) => {
    onChange({ target: { name, value: val } });
    close();
  };

  const handleSearchChange = (text: string) => {
    setSearch(text);
    setActiveIndex(text.trim() ? 0 : -1);
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    const count = filtered.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (count) setActiveIndex((i) => (i + 1 >= count ? 0 : i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (count) setActiveIndex((i) => (i <= 0 ? count - 1 : i - 1));
        break;
      case 'Home':
        if (count) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (count) {
          e.preventDefault();
          setActiveIndex(count - 1);
        }
        break;
      case 'Enter':
        // Never let Enter submit the surrounding form while the list is open.
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < count) handleSelect(filtered[activeIndex].value);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  const activeDescendant = isOpen && activeIndex >= 0 && activeIndex < filtered.length ? optionId(activeIndex) : undefined;

  return (
    <div className={`flex flex-col gap-2 group ${isOpen ? 'relative z-50' : ''}`} ref={containerRef}>
      <label id={labelId} className={`text-[12px] font-extrabold text-slate-700 ${isOpen ? colors.text : ''} transition-colors`}>
        {label} {required && <span className="text-red-500" aria-hidden="true">*</span>}
      </label>

      <div className="relative">
        {/*
          Focusable-but-invisible input that carries the value for native form submission and
          validation: browsers ignore `required` on type="hidden", so this one is a real text input.
          When it is invalid the browser blocks submit and shows its message under the trigger.
        */}
        <input
          ref={validityInputRef}
          name={name}
          value={value}
          required={required}
          disabled={disabled}
          onChange={() => {}}
          tabIndex={-1}
          aria-hidden="true"
          autoComplete="off"
          className="sr-only"
          style={{ bottom: 0, right: '50%' }}
        />

        {/* Trigger */}
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-required={required || undefined}
          disabled={disabled}
          onClick={() => (isOpen ? close() : open())}
          onKeyDown={handleTriggerKeyDown}
          className={`w-full px-5 py-4 bg-slate-50 border-2 ${isOpen ? colors.border : 'border-transparent'} ${isOpen ? 'bg-white' : ''} rounded-[1.25rem] font-bold text-slate-800 text-[14px] focus:outline-none focus:ring-4 ${colors.ring} transition-all flex items-center justify-between gap-2 text-right disabled:opacity-60 disabled:cursor-not-allowed`}
        >
          <span className={selectedOption ? 'text-slate-800' : 'text-slate-400'}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {/* Space for the clear button, which is rendered over it as a sibling. */}
            {value && !disabled && <span className="w-5 h-5" aria-hidden="true" />}
            <ChevronDown size={16} className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        </button>

        {/* Clear control (a sibling button: buttons cannot be nested) */}
        {value && !disabled && (
          <button
            type="button"
            onClick={() => handleSelect('')}
            aria-label={`مسح اختيار ${label}`}
            className="absolute left-[2.5rem] top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-200 hover:bg-red-100 flex items-center justify-center transition text-slate-500 hover:text-red-500"
          >
            <X size={12} />
          </button>
        )}

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute z-50 top-full mt-2 w-full bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Search Input */}
            <div className="p-3 border-b border-slate-100 sticky top-0 bg-white z-10">
              <div className="relative">
                <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  role="searchbox"
                  aria-label={`بحث في ${label}`}
                  aria-controls={listboxId}
                  aria-activedescendant={activeDescendant}
                  aria-autocomplete="list"
                  value={search}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onKeyDown={handleListKeyDown}
                  placeholder="ابحث هنا..."
                  className="w-full pl-3 pr-9 py-2.5 bg-slate-50 rounded-xl text-[13px] font-bold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200 border-none"
                />
              </div>
            </div>

            {/* Options List */}
            <div ref={listRef} id={listboxId} role="listbox" aria-labelledby={labelId} className="max-h-[240px] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-5 py-8 text-center text-slate-400 font-bold text-[13px]" role="presentation">
                  لا توجد نتائج مطابقة
                </div>
              ) : (
                filtered.map((option, index) => {
                  const isSelected = option.value === value;
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={option.value}
                      id={optionId(index)}
                      data-index={index}
                      role="option"
                      aria-selected={isSelected}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => handleSelect(option.value)}
                      className={`w-full cursor-pointer text-right px-5 py-3.5 text-[13px] font-bold transition-all flex items-center justify-between gap-2 ${
                        isSelected
                          ? `${colors.bg} ${colors.text} font-extrabold`
                          : isActive
                            ? 'bg-slate-100 text-slate-800'
                            : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span>{option.label}</span>
                      {isSelected && <span className={`w-2 h-2 rounded-full opacity-60 ${colors.dot}`} aria-hidden="true" />}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
