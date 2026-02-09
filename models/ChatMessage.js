const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
  chat_import_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatImport', required: true, index: true },

  // Content dedup
  content_hash: { type: String, required: true, index: true }, // SHA256 of normalized text
  message_content: { type: String },
  sender_number: { type: String, index: true },
  sender_name: String,
  timestamp: Date,
  message_date_str: { type: String }, // original date string from chat

  // Classification
  message_type: {
    type: String,
    enum: ['text', 'image', 'file', 'deleted', 'group_event'],
    default: 'text'
  },
  group_event_type: {
    type: String,
    enum: ['added_member', 'removed_member', 'name_change', ''],
    default: ''
  },

  // Level 2 dedup tracking
  is_duplicate: { type: Boolean, default: false, index: true },
  duplicate_of_message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },

  // Processing
  policy_relevance_score: { type: Number, default: 0 }
}, { timestamps: true });

// Level 1 dedup: compound unique index (scoped to import so re-imports work)
ChatMessageSchema.index(
  { chat_import_id: 1, content_hash: 1, sender_number: 1, message_date_str: 1 },
  { unique: true, name: 'msg_dedup_import_hash_sender_date' }
);

// Text index for searching message content
ChatMessageSchema.index({ message_content: 'text' });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
