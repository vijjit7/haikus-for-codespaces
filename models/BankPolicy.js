const mongoose = require('mongoose');

const BankPolicySchema = new mongoose.Schema({
  bank_name: { type: String, required: true, index: true },
  bank_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', index: true },
  department: { type: String, enum: ['Prime', 'Affordable', 'Micro', 'SME', 'Corporate', 'Standard', 'Other'], default: 'Other' },
  loan_type: { type: String, index: true },
  product_type: {
    type: String,
    enum: ['HL', 'LAP', 'LRD', 'BT_TopUp', 'Commercial_Purchase', 'Other', ''],
    default: ''
  },
  loan_min_lakhs: Number,
  loan_max_lakhs: Number,
  roi_min_pct: Number,
  roi_max_pct: Number,
  ltv_pct: Number,
  ltv_min_pct: Number,
  geo_limits_km: Number,
  profiles: [String],
  eligibility_profiles: { type: mongoose.Schema.Types.Mixed },
  min_cibil: Number,
  max_tenure_years: Number,
  collateral_types: [String],
  loan_nature: { type: String, enum: ['Secured', 'Unsecured', 'Both', ''], default: '' },
  own_house_required: { type: String, enum: ['Yes', 'No', 'Not specified', ''], default: '' },
  max_usl: Number,
  processing_fee_pct: Number,
  special_conditions: String,
  programs: [String],       // e.g. ['NIP', 'LIP', 'Banking Surrogate', 'ITR Program']
  other_remarks: String,    // e.g. 'Cash Salary considered'
  banker_name: String,
  banker_contact: String,
  policy_label: String, // human-readable: "axis-lap-prime-50L-10Cr-9.5%-75LTV"

  // Dedup
  policy_signature: { type: String, unique: true, index: true },

  // Source tracking
  chat_import_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatImport' },
  message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage' },
  message_date: Date,
  sender_name: String,
  raw_message_text: String,

  // Soft delete
  is_deleted: { type: Boolean, default: false },
  deleted_at: Date
}, { timestamps: true });

module.exports = mongoose.model('BankPolicy', BankPolicySchema);
