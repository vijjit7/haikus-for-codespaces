const mongoose = require('mongoose');

const SurrogateProgramSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankPolicy', index: true },
  message_id: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', index: true },
  bank_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank', index: true },

  program_signature: { type: String, unique: true, index: true }, // dedup key
  program_type: {
    type: String,
    enum: ['Banking_Surrogate', 'GST', 'Gross_Turnover', 'LIP', 'Low_LTV'],
    required: true
  },

  // Program parameters
  program_loan_limit_lakhs: Number,
  abb_multiplier: Number,    // Average Bank Balance multiplier
  margin_pct: Number,
  dsra_months: Number,       // Debt Service Reserve Account months

  // Extracted details
  program_details: String,
  bank_name: String,
  loan_type: String
}, { timestamps: true });

module.exports = mongoose.model('SurrogateProgram', SurrogateProgramSchema);
