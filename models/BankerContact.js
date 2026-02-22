const mongoose = require('mongoose');

const BankerContactSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  name: { type: String, default: '' },
  bank: { type: String, default: '' },
  bank_type: { type: String, enum: ['', 'Bank', 'NBFC', 'HFC'], default: '' },
  message_count: { type: Number, default: 0 },
  last_active: Date,
  source: { type: String, default: 'whatsapp_chat' }
}, { timestamps: true });

// Unique on phone so re-saving updates instead of duplicating
BankerContactSchema.index({ phone: 1 }, { unique: true });

module.exports = mongoose.model('BankerContact', BankerContactSchema);
