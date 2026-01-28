const mongoose = require('mongoose');

const DebtProfileSchema = new mongoose.Schema({
  sNo: Number,
  loanApplicant: String,
  bank: String,
  loanType: String,
  loanAmount: Number,
  emi: Number,
  emiStartDate: String,
  tenure: String,
  emiEndDate: String,
  roi: Number,
  currentOutstanding: Number
});

module.exports = mongoose.model('DebtProfile', DebtProfileSchema);