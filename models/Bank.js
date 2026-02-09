const mongoose = require('mongoose');

const BankSchema = new mongoose.Schema({
  bank_name: { type: String, required: true, unique: true, index: true },
  bank_key: { type: String, unique: true, index: true }, // slug e.g. "axis-bank"
  bank_type: {
    type: String,
    enum: ['Bank', 'NBFC', 'HFC'],
    default: 'Bank'
  },
  branch_location: String,
  contact_person: String,
  designation: String,
  contact_number: {
    type: String,
    sparse: true,
    index: { unique: true, sparse: true }
  },
  first_seen_date: Date,
  last_seen_date: Date
}, { timestamps: true });

module.exports = mongoose.model('Bank', BankSchema);
