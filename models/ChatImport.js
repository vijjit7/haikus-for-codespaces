const mongoose = require('mongoose');

const ChatImportSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  file_hash_sha256: { type: String, unique: true, index: true },
  file_size_bytes: Number,
  import_type: { type: String, enum: ['whatsapp_chat', 'pasted_text', 'pdf_document', 'image_document'], default: 'whatsapp_chat' },
  total_messages: { type: Number, default: 0 },
  policies_extracted: { type: Number, default: 0 },
  policies_deduplicated: { type: Number, default: 0 },
  messages_stored: { type: Number, default: 0 },
  messages_deduplicated: { type: Number, default: 0 },
  unique_senders: { type: Number, default: 0 },
  surrogates_extracted: { type: Number, default: 0 },
  banks_identified: { type: Number, default: 0 },
  status: { type: String, enum: ['uploading', 'parsing', 'storing_messages', 'ocr_extracting', 'extracting', 'saving', 'completed', 'failed'], default: 'uploading' },
  error_message: String,
  detected_format: String,
  chat_date_range: {
    start: Date,
    end: Date
  },
  processing_log: [String]
}, { timestamps: true });

module.exports = mongoose.model('ChatImport', ChatImportSchema);
