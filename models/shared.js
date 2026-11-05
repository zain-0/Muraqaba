import mongoose from 'mongoose';

/** A file kept under the API's upload folder, named by this record's _id. */
export const AttachmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  size: { type: Number, required: true },
  mimeType: { type: String, required: true },
});
