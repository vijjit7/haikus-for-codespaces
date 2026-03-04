const mongoose = require('mongoose');

const ProposalSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  applicantName: String,
  applicantType: String,
  coApplicants: [mongoose.Schema.Types.Mixed],
  loanAmount: String,
  natureOfLoan: String,
  typeOfLoan: String,
  natureOfCollateral: String,
  contactPerson: String,
  designation: String,
  email: String,
  phone: String,
  address: String,
  city: String,
  state: String,
  zipCode: String,
  industry: String,
  yearsInBusiness: String,
  annualRevenue: String,
  employeeCount: String,
  creditRating: String,
  existingBankRelations: String,
  status: String,
  currentStage: Number,
  documents: [mongoose.Schema.Types.Mixed],
  createdAt: String
}, { strict: false });

module.exports = mongoose.model('Proposal', ProposalSchema);
