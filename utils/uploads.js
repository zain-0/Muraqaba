/**
 * Documents attached to estimates, invoices, purchasing's papers, scrap requests and sales. Files
 * are kept in memory until the request has passed every check, then written under a name built
 * from the attachment id, so a stored file never carries a name chosen by the sender. They are
 * served only through the API.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../middleware/errorMiddleware.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads', import.meta.url));
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

// The type stored and served comes from this list, not from what the browser claimed.
const ALLOWED_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const FILE_TYPE_MESSAGE = 'Attach PDF, image, Word or Excel files only';

// Browsers send UTF-8 names, which multer reads as latin1; Arabic names need turning back.
const displayName = (original) => {
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  // eslint-disable-next-line no-control-regex
  return basename(decoded.replace(/\\/g, '/')).replace(/[\u0000-\u001f"]/g, '').slice(-150) || 'file';
};

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES, fields: 10 },
  fileFilter: (req, file, callback) => {
    if (ALLOWED_TYPES[extname(displayName(file.originalname)).toLowerCase()]) return callback(null, true);
    return callback(new AppError(FILE_TYPE_MESSAGE, 400, 'VALIDATION_ERROR', [{ field: 'attachments', message: FILE_TYPE_MESSAGE }]));
  },
}).array('attachments', MAX_FILES);

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'Each file must be 10 MB or smaller',
  LIMIT_FILE_COUNT: 'Attach up to 5 files at a time',
  LIMIT_UNEXPECTED_FILE: 'Attach up to 5 files at a time',
};

/** Reads a multipart form into req.body and req.files, turning its errors into field errors. */
export const parseAttachments = (req, res, next) => {
  parser(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = MULTER_MESSAGES[err.code] || 'The files could not be read';
      return next(new AppError(message, 400, 'VALIDATION_ERROR', [{ field: 'attachments', message }]));
    }
    return next(err);
  });
};

export const storedPath = (attachment) => join(UPLOAD_DIR, `${attachment._id}${extname(attachment.name).toLowerCase()}`);

/** Sends one stored file as a download under its own name; a file missing on disk is a 404. */
export const sendStored = async (res, attachment) => {
  if (!attachment) throw new AppError('File not found', 404, 'NOT_FOUND');
  res.attachment(attachment.name);
  res.type(attachment.mimeType);
  await new Promise((resolve, reject) => {
    res.sendFile(storedPath(attachment).slice(UPLOAD_DIR.length + 1), { root: UPLOAD_DIR }, (err) => (err ? reject(new AppError('File not found', 404, 'NOT_FOUND')) : resolve()));
  });
};

/**
 * Writes the request's files and returns their attachment records. `commit` saves the
 * ticket; if that fails (say another request got there first) the files are removed again.
 */
export const withStoredAttachments = async (files = [], commit) => {
  const attachments = files.map((file) => {
    const name = displayName(file.originalname);
    return { _id: new mongoose.Types.ObjectId(), name, size: file.size, mimeType: ALLOWED_TYPES[extname(name).toLowerCase()] };
  });
  if (attachments.length) await mkdir(UPLOAD_DIR, { recursive: true });
  const remove = () => Promise.allSettled(attachments.map((a) => unlink(storedPath(a))));
  try {
    await Promise.all(attachments.map((a, i) => writeFile(storedPath(a), files[i].buffer)));
    return await commit(attachments);
  } catch (err) {
    await remove();
    throw err;
  }
};
