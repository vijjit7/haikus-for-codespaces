const mongoose = require('mongoose');

const BankerMatchSchema = new mongoose.Schema({
  proposal_id: { type: String, required: true, index: true },
  matches: [{
    bank_name: String,
    bank_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bank' },
    department: String,
    loan_type: String,
    product_type: String,
    policy_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BankPolicy' },
    match_score: { type: Number, default: 0 },
    match_reasons: [String],
    disqualify_reasons: [String],
    surrogate_matches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SurrogateProgram' }],
    status: { type: String, enum: ['matched', 'shortlisted', 'applied', 'approved', 'rejected', 'disqualified'], default: 'matched' }
  }],
  proposal_snapshot: {
    applicant_name: String,
    loan_amount: Number,
    loan_type: String,
    loan_nature: String,
    cibil_score: Number,
    industry: String,
    applicant_type: String
  },
  last_matched_at: Date
}, { timestamps: true });

module.exports = mongoose.model('BankerMatch', BankerMatchSchema);
