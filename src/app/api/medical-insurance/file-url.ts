import { z } from 'zod';
import { isStoredFileUrl } from '@/app/medical-insurance/_components/stored-file';

const FILE_URL_MESSAGE = 'المرفق غير صالح: يرجى رفع الملف مرة أخرى';

/**
 * Optional attachment URL: '' / null -> null (clears the column), otherwise it must be a stored
 * file URL (see isStoredFileUrl). Bare file names are rejected: they cannot be opened.
 */
export const zOptFileUrl = z
  .preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z
      .string()
      .trim()
      .max(2000)
      .refine((v) => isStoredFileUrl(v), FILE_URL_MESSAGE)
      .nullable(),
  )
  .optional();
