const mongoose = require('mongoose');

const DebtProfileSchema = new mongoose.Schema({
  sNo: Number,
  loanApplicant: String,
  bank: String,
  loanType: String,
  loanAmount: Number,
  emi: Number,
  roi: Number,
  sanctionDate: String,
  tenure: Number,
  emiStartDate: String,
  emiEndDate: String,
  monthsCompleted: Number,
  percentTenureCompleted: Number,
  proposalId: String,
  emiBankStatementProvided: { type: Boolean, default: false },
  emiBankAccountNumber: String
});

module.exports = mongoose.model('DebtProfile', DebtProfileSchema);