"use client";

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import DashboardLayout from '@/components/DashboardLayout';
import { Search, Users, Building2, ChevronLeft, MapPin, Briefcase, AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { readApiError } from '@/components/ui/feedback';

interface EmployeeHit {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic?: string | null;
  jobTitle?: string | null;
}

interface BranchHit {
  id: string;
  nameArabic: string;
  nameEnglish?: string | null;
}

interface CompanyHit {
  id: string;
  nameArabic: string;
  commercialRegNum?: string | null;
  registrationNumber?: string | null;
}

interface SearchResults {
  employees: EmployeeHit[];
  branches: BranchHit[];
  companies: CompanyHit[];
}

const EMPTY_RESULTS: SearchResults = { employees: [], branches: [], companies: [] };

function SearchResultsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = (searchParams.get('q') || '').trim();
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string, signal?: AbortSignal) => {
    if (!q) {
      setResults(EMPTY_RESULTS);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) {
        setError(await readApiError(res, 'تعذر تنفيذ البحث'));
        return;
      }
      const data = (await res.json()) as { results?: Partial<SearchResults> };
      setResults({
        employees: data.results?.employees ?? [],
        branches: data.results?.branches ?? [],
        companies: data.results?.companies ?? [],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('تعذر الاتصال بالخادم. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    runSearch(query, controller.signal);
    return () => controller.abort();
  }, [query, runSearch]);

  const totalResults = results.employees.length + results.branches.length + results.companies.length;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8 md:py-12 mb-32 space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* Search Header */}
      <div className="flex flex-col items-center justify-center text-center pb-8 border-b border-slate-200 gap-4">
        <div className="w-20 h-20 bg-blue-50 text-blue-500 rounded-[2rem] flex items-center justify-center shadow-inner">
          <Search size={40} />
        </div>
        <div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">
            نتائج البحث الشامل
          </h1>
          <p className="text-slate-500 font-bold mt-2 text-[16px] bg-slate-100 px-4 py-1.5 rounded-full inline-block">
            {query ? `بحثنا عن: " ${query} "` : 'لا توجد عبارة للبحث'}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
           <div className="flex flex-col items-center gap-4 text-slate-400">
             <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
             <p className="font-bold text-[15px]">زحمة ملفات... جاري تصفح السجلات 🕵️‍♂️</p>
           </div>
        </div>
      ) : error ? (
        <div className="text-center py-20 bg-rose-50/50 border border-rose-200 border-dashed rounded-[3rem] flex flex-col items-center">
          <AlertTriangle size={36} className="text-rose-400 mb-3" />
          <h2 className="text-xl font-black text-slate-700 mb-2">تعذر تنفيذ البحث</h2>
          <p className="text-slate-500 font-bold text-[14px] mb-6">{error}</p>
          <button type="button" onClick={() => runSearch(query)} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-black text-[13px] transition-colors">
            <RefreshCw size={16} /> إعادة المحاولة
          </button>
        </div>
      ) : !query ? (
        <div className="text-center py-20 bg-slate-50 border border-slate-200 border-dashed rounded-[3rem]">
          <h2 className="text-xl font-black text-slate-500 mb-2">اكتب عبارة في شريط البحث للبدء</h2>
          <p className="text-slate-400 font-bold text-[14px]">يمكنك البحث بالاسم، الرقم الوظيفي، رقم الهوية، الفرع أو الشركة.</p>
        </div>
      ) : totalResults === 0 ? (
        <div className="text-center py-20 bg-slate-50 border border-slate-200 border-dashed rounded-[3rem]">
          <h2 className="text-2xl font-black text-slate-500 mb-2">أوبس! لم نجد شيئاً 🤷‍♂️</h2>
          <p className="text-slate-400 font-bold text-[14px]">حاول استخدام مصطلحات أخرى، ربما الاسم الأول أو رقم الهوية.</p>
        </div>
      ) : (
        <div className="space-y-10">

          {/* Employees Results */}
          {results.employees.length > 0 && (
            <div>
              <h2 className="font-extrabold text-xl text-slate-800 flex items-center gap-3 mb-6">
                 <span className="bg-indigo-100 text-indigo-600 p-2 rounded-xl"><Users size={20} /></span>
                 الموظفين المطابقين <span className="text-[12px] bg-slate-200 text-slate-600 px-3 py-1 rounded-full">{results.employees.length}</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {results.employees.map((emp) => (
                  <Link href={`/employees/${emp.id}`} key={emp.id} className="bg-white border border-slate-200 p-5 rounded-3xl hover:border-indigo-300 hover:shadow-xl hover:shadow-indigo-500/10 transition-all group flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center font-black text-xl shadow-inner group-hover:scale-110 transition">
                         {emp.firstNameArabic.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-extrabold text-[15px] text-slate-800 group-hover:text-indigo-600 transition">{emp.firstNameArabic} {emp.lastNameArabic}</h3>
                        <p className="text-slate-500 font-bold text-[12px] mt-1 flex items-center gap-2">
                          <span>#{emp.employeeId}</span>
                          <span className="w-1 h-1 bg-slate-300 rounded-full block"></span>
                          <span className="flex items-center gap-1"><Briefcase size={12}/> {emp.jobTitle || 'غير محدد'}</span>
                        </p>
                      </div>
                    </div>
                    <div className="text-slate-300 group-hover:text-indigo-500 transition translate-x-4 group-hover:translate-x-0">
                      <ChevronLeft />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Branches Results */}
          {results.branches.length > 0 && (
            <div>
              <h2 className="font-extrabold text-xl text-slate-800 flex items-center gap-3 mb-6">
                 <span className="bg-teal-100 text-teal-600 p-2 rounded-xl"><MapPin size={20} /></span>
                 الفروع / المواقع <span className="text-[12px] bg-slate-200 text-slate-600 px-3 py-1 rounded-full">{results.branches.length}</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {results.branches.map((branch) => (
                  <Link href={`/branches/${branch.id}`} key={branch.id} className="bg-white border border-slate-200 p-5 rounded-3xl hover:border-teal-300 hover:shadow-xl hover:shadow-teal-500/10 transition-all group">
                    <h3 className="font-extrabold text-[15px] text-slate-800 group-hover:text-teal-600 transition">{branch.nameArabic}</h3>
                    <p className="text-slate-400 font-bold text-[12px] mt-1">{branch.nameEnglish || 'بدون اسم إنجليزي'}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Companies Results */}
          {results.companies.length > 0 && (
            <div>
              <h2 className="font-extrabold text-xl text-slate-800 flex items-center gap-3 mb-6">
                 <span className="bg-amber-100 text-amber-600 p-2 rounded-xl"><Building2 size={20} /></span>
                 الشركات المشغلة <span className="text-[12px] bg-slate-200 text-slate-600 px-3 py-1 rounded-full">{results.companies.length}</span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {results.companies.map((co) => (
                  <Link href={`/companies/${co.id}`} key={co.id} className="bg-white border border-slate-200 p-5 rounded-3xl hover:border-amber-300 hover:shadow-xl hover:shadow-amber-500/10 transition-all group">
                    <h3 className="font-extrabold text-[15px] text-slate-800 group-hover:text-amber-600 transition">{co.nameArabic}</h3>
                    <p className="text-slate-500 font-bold text-[12px] mt-1">سجل رقم: {co.commercialRegNum || co.registrationNumber || 'غير متوفر'}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={<div className="p-10 text-center font-bold text-slate-400">تحضير مساحة البحث...</div>}>
         <SearchResultsContent />
      </Suspense>
    </DashboardLayout>
  );
}
