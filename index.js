let express = require('express');
let app = express();

// IMPORTANT: JSON body parser must be before routes
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const { execFile } = require('child_process');
const mongoose = require('mongoose');
const DebtProfile = require('./models/DebtProfile');
let ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const AdmZip = require('adm-zip');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');
const axios = require('axios');
const { spawn } = require('child_process');
const FormData = require('form-data');
const xlsx = require('xlsx');

// Claude Agent API Endpoint
app.post('/api/claude', (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }
  execFile('python3', ['claude_agent.py'], { env: process.env }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ success: false, error: stderr || error.message });
    }
    res.json({ success: true, response: stdout.trim() });
  });
});
// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/haikusdb')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));
// Multer storage for Excel uploads
const debtProfileStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, 'debt_profile_' + Date.now() + '_' + file.originalname);
  }
});

// Debt Profile Pending page
app.get('/debt-profile/pending', async (req, res) => {
  try {
    const debtProfiles = await DebtProfile.find({});
    res.render('debt-profile-pending', { debtProfiles });
  } catch (err) {
    res.status(500).send('Error loading debt profile data');
  }
});
const debtProfileUpload = multer({ storage: debtProfileStorage });

// Helper function to parse Excel date or string date
function parseExcelDate(value) {
  if (!value) return '';
  // If it's an Excel serial number
  if (typeof value === 'number') {
    const date = new Date((value - 25569) * 86400 * 1000);
    return date.toLocaleDateString('en-IN');
  }
  return String(value);
}

// Helper function to calculate months completed and percentage
function calculateTenureProgress(emiStartDate, tenure) {
  if (!emiStartDate || !tenure) return { monthsCompleted: 0, percentCompleted: 0 };

  let startDate;
  if (typeof emiStartDate === 'number') {
    startDate = new Date((emiStartDate - 25569) * 86400 * 1000);
  } else {
    // Try to parse date string (DD/MM/YYYY or DD-MM-YYYY or other formats)
    const parts = String(emiStartDate).split(/[\/\-\.]/);
    if (parts.length === 3) {
      // Assume DD/MM/YYYY format
      startDate = new Date(parts[2], parts[1] - 1, parts[0]);
    } else {
      startDate = new Date(emiStartDate);
    }
  }

  if (isNaN(startDate.getTime())) return { monthsCompleted: 0, percentCompleted: 0 };

  const now = new Date();
  const monthsDiff = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
  const monthsCompleted = Math.max(0, monthsDiff);
  const tenureMonths = parseInt(tenure) || 0;
  const percentCompleted = tenureMonths > 0 ? Math.min(100, Math.round((monthsCompleted / tenureMonths) * 100)) : 0;

  return { monthsCompleted, percentCompleted };
}

// Helper function to calculate EMI end date
function calculateEmiEndDate(emiStartDate, tenure) {
  if (!emiStartDate || !tenure) return '';

  let startDate;
  if (typeof emiStartDate === 'number') {
    startDate = new Date((emiStartDate - 25569) * 86400 * 1000);
  } else {
    const parts = String(emiStartDate).split(/[\/\-\.]/);
    if (parts.length === 3) {
      startDate = new Date(parts[2], parts[1] - 1, parts[0]);
    } else {
      startDate = new Date(emiStartDate);
    }
  }

  if (isNaN(startDate.getTime())) return '';

  const tenureMonths = parseInt(tenure) || 0;
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + tenureMonths);
  return endDate.toLocaleDateString('en-IN');
}

// Helper function to get value from row with flexible column name matching
function getRowValue(row, ...possibleNames) {
  // First try exact match
  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== '') return row[name];
  }

  // Then try case-insensitive match with trimmed keys
  const rowKeys = Object.keys(row);
  for (const name of possibleNames) {
    const normalizedName = name.toLowerCase().trim();
    for (const key of rowKeys) {
      if (key.toLowerCase().trim() === normalizedName) {
        if (row[key] !== undefined && row[key] !== '') return row[key];
      }
    }
  }

  // Try partial match (key contains the name or name contains the key)
  for (const name of possibleNames) {
    const normalizedName = name.toLowerCase().trim();
    for (const key of rowKeys) {
      const normalizedKey = key.toLowerCase().trim();
      if (normalizedKey.includes(normalizedName) || normalizedName.includes(normalizedKey)) {
        if (row[key] !== undefined && row[key] !== '') return row[key];
      }
    }
  }

  return '';
}

// Helper function to process debt profile Excel data
function processDebtProfileData(data, proposalId) {
  return data.map((row, idx) => {
    // Get values using flexible matching
    const emiStartDate = getRowValue(row, 'EMI Start Date', 'EMI Start', 'Start Date', 'emi start date');
    const tenure = getRowValue(row, 'Tenure', 'Loan Tenure', 'Tenure (Months)', 'tenure');
    const sanctionDate = getRowValue(row, 'Sanction Date', 'Date of Sanction', 'sanction date');

    const { monthsCompleted, percentCompleted } = calculateTenureProgress(emiStartDate, tenure);
    const emiEndDateValue = getRowValue(row, 'EMI End Date', 'EMI End', 'End Date', 'emi end date');
    const emiEndDate = emiEndDateValue || calculateEmiEndDate(emiStartDate, tenure);

    return {
      sNo: getRowValue(row, 'S.No', 'SNo', 'Sr.No', 's.no', 'sno') || idx + 1,
      loanApplicant: getRowValue(row, 'Applicant', 'Loan Applicant', 'Borrower', 'Name', 'applicant'),
      bank: getRowValue(row, 'Bank Name', 'Bank', 'Lender', 'Financial Institution', 'bank name'),
      loanType: getRowValue(row, 'Loan Type', 'Type of Loan', 'Product', 'loan type'),
      loanAmount: Number(String(getRowValue(row, 'Loan Amount', 'Amount', 'Sanctioned Amount', 'loan amount') || 0).replace(/[^0-9.-]/g, '')) || 0,
      emi: Number(String(getRowValue(row, 'EMI', 'Monthly EMI', 'emi') || 0).replace(/[^0-9.-]/g, '')) || 0,
      roi: Number(String(getRowValue(row, 'ROI', 'Rate of Interest', 'Interest Rate', 'Rate', 'roi') || 0).replace(/[^0-9.-]/g, '')) || 0,
      sanctionDate: parseExcelDate(sanctionDate),
      tenure: parseInt(tenure) || 0,
      emiStartDate: parseExcelDate(emiStartDate),
      emiEndDate: parseExcelDate(emiEndDate),
      monthsCompleted: monthsCompleted,
      percentTenureCompleted: percentCompleted,
      proposalId: proposalId || ''
    };
  });
}

// Route to upload Excel and store debt profile data
app.post('/upload-debt-profile', debtProfileUpload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const mappedData = processDebtProfileData(data, req.body.proposalId || '');

    // Remove all previous debt profiles for this proposal and insert new
    if (req.body.proposalId) {
      await DebtProfile.deleteMany({ proposalId: req.body.proposalId });
    } else {
      await DebtProfile.deleteMany({});
    }
    await DebtProfile.insertMany(mappedData);

    res.json({ success: true, message: 'Debt profile data uploaded and saved.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Error processing file.' });
  }
});

// Helper function to find header row in Excel data
function findHeaderRowAndParseExcel(sheet) {
  // Read raw data (array of arrays)
  const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });

  // Keywords to identify header row (case insensitive)
  const headerKeywords = ['s.no', 'sno', 'sr.no', 'applicant', 'bank', 'loan', 'emi', 'tenure', 'roi'];

  let headerRowIndex = -1;

  // Find the row that contains header keywords
  for (let i = 0; i < Math.min(rawData.length, 10); i++) { // Check first 10 rows
    const row = rawData[i];
    if (!row || row.length === 0) continue;

    const rowText = row.map(cell => String(cell || '').toLowerCase().trim()).join(' ');
    const matchCount = headerKeywords.filter(kw => rowText.includes(kw)).length;

    if (matchCount >= 3) { // At least 3 keywords found
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    // Fallback: use first row as header
    return xlsx.utils.sheet_to_json(sheet, { defval: '' });
  }

  // Extract headers from the header row
  const headers = rawData[headerRowIndex].map(h => String(h || '').trim());

  // Convert remaining rows to objects using these headers
  const result = [];
  for (let i = headerRowIndex + 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

    const obj = {};
    headers.forEach((header, idx) => {
      if (header) {
        obj[header] = row[idx] !== undefined ? row[idx] : '';
      }
    });

    // Only add if there's meaningful data (at least has a loan amount or bank name)
    if (obj['loan amount'] || obj[' loan amount'] || obj['bank name'] || obj['bank'] || obj['emi']) {
      result.push(obj);
    }
  }

  return result;
}

// Route to extract debt profile from uploaded Excel files in the proposal
app.post('/stage2/:proposalId/extract-debt-profile', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = getProposalById(proposalId);

    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    // Find Excel files in debtProfile category
    const debtProfileDocs = (proposal.documents || []).filter(doc =>
      doc.category === 'debtProfile' &&
      (doc.filename.endsWith('.xlsx') || doc.filename.endsWith('.xls'))
    );

    if (debtProfileDocs.length === 0) {
      return res.status(400).json({ success: false, message: 'No Excel files found in Debt Profile category' });
    }

    let allDebtProfiles = [];

    for (const doc of debtProfileDocs) {
      const filePath = path.join(UPLOADS_DIR, proposalId, doc.filename);
      if (fs.existsSync(filePath)) {
        try {
          const workbook = xlsx.readFile(filePath);
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];

          // Use smart header detection
          const data = findHeaderRowAndParseExcel(sheet);
          console.log('Parsed Excel data:', JSON.stringify(data.slice(0, 2), null, 2));

          const mappedData = processDebtProfileData(data, proposalId);
          allDebtProfiles = allDebtProfiles.concat(mappedData);
        } catch (excelErr) {
          console.error(`Error reading Excel file ${doc.filename}:`, excelErr);
        }
      }
    }

    if (allDebtProfiles.length === 0) {
      return res.status(400).json({ success: false, message: 'No data could be extracted from Excel files' });
    }

    // Remove previous debt profiles for this proposal and insert new
    await DebtProfile.deleteMany({ proposalId: proposalId });
    await DebtProfile.insertMany(allDebtProfiles);

    res.json({ success: true, message: `Extracted ${allDebtProfiles.length} loan records`, count: allDebtProfiles.length });
  } catch (err) {
    console.error('Error extracting debt profile:', err);
    res.status(500).json({ success: false, message: 'Error processing debt profile' });
  }
});

// Route to re-extract turnover (GST) documents with full text for analysis
app.post('/stage2/:proposalId/extract-turnover', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = getProposalById(proposalId);

    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    // Find turnover PDF documents (GSTR-3B returns)
    const turnoverDocs = (proposal.documents || []).filter(doc =>
      doc.category === 'turnover' &&
      doc.filename.toLowerCase().endsWith('.pdf')
    );

    if (turnoverDocs.length === 0) {
      return res.status(400).json({ success: false, message: 'No PDF files found in Turnover category' });
    }

    let extractedCount = 0;

    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];
      if (doc.category !== 'turnover' || !doc.filename.toLowerCase().endsWith('.pdf')) continue;

      const filePath = path.join(UPLOADS_DIR, proposalId, doc.filename);
      if (fs.existsSync(filePath)) {
        try {
          const pdfResult = await extractPDFWithTableDetection(filePath);
          proposal.documents[i].extractedText = pdfResult.text; // Full text
          proposal.documents[i].pages = pdfResult.numPages;
          extractedCount++;
          console.log(`✓ Re-extracted turnover document: ${doc.originalName} (${pdfResult.text.length} chars)`);
        } catch (pdfErr) {
          console.error(`Error extracting PDF ${doc.filename}:`, pdfErr);
        }
      }
    }

    if (extractedCount > 0) {
      updateProposal(proposalId, { documents: proposal.documents });
    }

    res.json({ success: true, message: `Re-extracted ${extractedCount} turnover documents`, count: extractedCount });
  } catch (err) {
    console.error('Error extracting turnover documents:', err);
    res.status(500).json({ success: false, message: 'Error processing turnover documents' });
  }
});

// API: Get single debt profile
app.get('/api/debt-profile/:id', async (req, res) => {
  try {
    const profile = await DebtProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Update debt profile
app.put('/api/debt-profile/:id', async (req, res) => {
  try {
    const { loanApplicant, bank, loanType, loanAmount, emi, roi, sanctionDate, tenure, emiStartDate, emiEndDate, emiBankStatementProvided, emiBankAccountNumber } = req.body;

    // Build update object dynamically to support partial updates
    const updateData = {};

    // Handle EMI bank statement fields (for quick checkbox/dropdown updates)
    if (emiBankStatementProvided !== undefined) {
      updateData.emiBankStatementProvided = emiBankStatementProvided;
    }
    if (emiBankAccountNumber !== undefined) {
      updateData.emiBankAccountNumber = emiBankAccountNumber;
    }

    // Handle full profile edit fields
    if (loanApplicant !== undefined) updateData.loanApplicant = loanApplicant;
    if (bank !== undefined) updateData.bank = bank;
    if (loanType !== undefined) updateData.loanType = loanType;
    if (loanAmount !== undefined) updateData.loanAmount = Number(loanAmount) || 0;
    if (emi !== undefined) updateData.emi = Number(emi) || 0;
    if (roi !== undefined) updateData.roi = Number(roi) || 0;
    if (sanctionDate !== undefined) updateData.sanctionDate = sanctionDate;
    if (tenure !== undefined) updateData.tenure = parseInt(tenure) || 0;
    if (emiStartDate !== undefined) updateData.emiStartDate = emiStartDate;
    if (emiEndDate !== undefined) updateData.emiEndDate = emiEndDate;

    // Recalculate months completed and percentage if relevant fields are provided
    if (emiStartDate && tenure) {
      const parts = String(emiStartDate).split(/[\/\-\.]/);
      if (parts.length === 3) {
        const startDate = new Date(parts[2], parts[1] - 1, parts[0]);
        if (!isNaN(startDate.getTime())) {
          const now = new Date();
          const monthsDiff = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
          updateData.monthsCompleted = Math.max(0, monthsDiff);
          const tenureMonths = parseInt(tenure) || 0;
          updateData.percentTenureCompleted = tenureMonths > 0 ? Math.min(100, Math.round((updateData.monthsCompleted / tenureMonths) * 100)) : 0;
        }
      }
    }

    const updatedProfile = await DebtProfile.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!updatedProfile) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }

    res.json({ success: true, data: updatedProfile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// API: Delete debt profile
app.delete('/api/debt-profile/:id', async (req, res) => {
  try {
    const deletedProfile = await DebtProfile.findByIdAndDelete(req.params.id);
    if (!deletedProfile) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }
    res.json({ success: true, message: 'Profile deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const port = process.env.PORT || 3000;

// Configure pdfjs-dist worker - disable worker to avoid errors
pdfjsLib.GlobalWorkerOptions.workerSrc = false;

// PDF Extraction Service Configuration
const PDF_SERVICE_URL = 'http://localhost:5001';
const PDF_SERVICE_TIMEOUT = 30000; // 30 seconds

// OpenRouter API Configuration for Document AI
const OPENROUTER_API_KEY = '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';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Middleware
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Configure multer for file uploads
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const proposalId = req.body.proposalId || req.params.proposalId;
    const proposalDir = path.join(UPLOADS_DIR, proposalId);
    if (!fs.existsSync(proposalDir)) {
      fs.mkdirSync(proposalDir, { recursive: true });
    }
    cb(null, proposalDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|doc|docx|jpg|jpeg|png|xls|xlsx|zip/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    
    // Allow if extension matches
    if (extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only documents, images, and zip files are allowed!'));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const PROPOSALS_FILE = path.join(DATA_DIR, 'proposals.json');
const BANKERS_FILE = path.join(DATA_DIR, 'bankers.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Initialize data files if they don't exist
if (!fs.existsSync(PROPOSALS_FILE)) {
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify([], null, 2));
}
if (!fs.existsSync(BANKERS_FILE)) {
  fs.writeFileSync(BANKERS_FILE, JSON.stringify([], null, 2));
}

// Helper functions to read/write data
function getProposals() {
  return JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf8'));
}

function getProposalById(proposalId) {
  const proposals = getProposals();
  return proposals.find(p => p.id === proposalId);
}

function saveProposal(proposal) {
  const proposals = getProposals();
  proposal.id = Date.now().toString();
  proposal.createdAt = new Date().toISOString();
  proposal.status = 'Stage 1 - Proposal Submitted';
  proposal.currentStage = 1;
  proposals.push(proposal);
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(proposals, null, 2));
  return proposal;
}

function updateProposal(proposalId, updates) {
  const proposals = getProposals();
  const index = proposals.findIndex(p => p.id === proposalId);
  if (index !== -1) {
    proposals[index] = { ...proposals[index], ...updates };
    fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(proposals, null, 2));
    return proposals[index];
  }
  return null;
}

// Required documents list
const REQUIRED_DOCUMENTS = [
  'PAN Card',
  'Aadhar Card',
  'GST Certificate',
  'Labour License',
  'UDYAM Certificate',
  'Partnership Deed',
  'Certificate of Incorporation',
  'Memorandum of Association',
  'Articles of Association',
  'Credit Report',
  'ITR (Current Year)',
  'ITR (Previous Year)',
  'ITR (Preceding Year)',
  'Bank Statement',
  'GST 3B Returns',
  'GST 1 Returns',
  'Loan Details',
  'Title Documents',
  'Tax Receipts',
  'Sanction Plan',
  'Encumberance Certificate'
];

// Auto-categorization function
function autoCategorizeDocument(filename, extractedText = '') {
  const lowerName = filename.toLowerCase();
  const lowerText = extractedText.toLowerCase();
  
  // Personal ID keywords
  if (lowerName.includes('pan') && !lowerName.includes('company') && !lowerName.includes('firm')) {
    return 'personalId';
  }
  if (lowerName.includes('aadhar') || lowerName.includes('aadhaar') || lowerName.includes('adhaar')) {
    return 'personalId';
  }
  
  // Business ID keywords
  if (lowerName.includes('gst') && !lowerName.includes('return') && !lowerName.includes('3b') && !lowerName.includes('gstr')) {
    return 'businessId';
  }
  if (lowerName.includes('pan') && (lowerName.includes('company') || lowerName.includes('firm') || lowerName.includes('business'))) {
    return 'businessId';
  }
  if (lowerName.includes('labour') || lowerName.includes('labor')) {
    return 'businessId';
  }
  if (lowerName.includes('udyam') || lowerName.includes('msme')) {
    return 'businessId';
  }
  
  // Incorporation keywords
  if (lowerName.includes('partnership') && lowerName.includes('deed')) {
    return 'incorporation';
  }
  if (lowerName.includes('incorporation') || lowerName.includes('coi')) {
    return 'incorporation';
  }
  if (lowerName.includes('moa') || lowerName.includes('memorandum')) {
    return 'incorporation';
  }
  if (lowerName.includes('aoa') || lowerName.includes('articles')) {
    return 'incorporation';
  }
  if (lowerName.includes('shareholder') || lowerName.includes('share holder') || lowerName.includes('directors')) {
    return 'incorporation';
  }
  
  // Credit Reports keywords
  if ((lowerName.includes('credit') || lowerName.includes('cibil') || lowerName.includes('experian')) && 
      (lowerName.includes('report') || lowerName.includes('score'))) {
    return 'creditReports';
  }
  
  // Financials keywords
  if (lowerName.includes('itr') || lowerName.includes('income') && lowerName.includes('tax')) {
    return 'financials';
  }
  if (lowerName.includes('26as') || lowerName.includes('form26') || lowerName.includes('form 26')) {
    return 'financials';
  }
  if (lowerName.includes('p&l') || lowerName.includes('profit') || lowerName.includes('balance') && lowerName.includes('sheet')) {
    return 'financials';
  }
  
  // Banking keywords
  if (lowerName.includes('bank') && lowerName.includes('statement')) {
    return 'banking';
  }
  if (lowerName.includes('passbook') || lowerName.includes('account') && lowerName.includes('statement')) {
    return 'banking';
  }
  if (lowerName.includes('od') && lowerName.includes('statement')) {
    return 'banking';
  }
  if (lowerName.includes('overdraft')) {
    return 'banking';
  }
  
  // Turnover keywords
  if (lowerName.includes('gst') && (lowerName.includes('3b') || lowerName.includes('return') || lowerName.includes('gstr'))) {
    return 'turnover';
  }
  if (lowerName.includes('gstr-1') || lowerName.includes('gstr1') || lowerName.includes('gst 1')) {
    return 'turnover';
  }
  if (lowerName.includes('gstr-3b') || lowerName.includes('gstr3b') || lowerName.includes('gst 3b')) {
    return 'turnover';
  }
  
  // Debt Profile keywords
  if (lowerName.includes('loan') && (lowerName.includes('detail') || lowerName.includes('statement') || lowerName.includes('sanction'))) {
    return 'debtProfile';
  }
  if (lowerName.includes('existing') && lowerName.includes('loan')) {
    return 'debtProfile';
  }
  if (lowerName.includes('emi') || lowerName.includes('liability')) {
    return 'debtProfile';
  }
  
  // Collateral keywords
  if (lowerName.includes('title') && lowerName.includes('deed')) {
    return 'collateral';
  }
  if (lowerName.includes('property') && lowerName.includes('document')) {
    return 'collateral';
  }
  if (lowerName.includes('tax') && lowerName.includes('receipt')) {
    return 'collateral';
  }
  if (lowerName.includes('sanction') && lowerName.includes('plan')) {
    return 'collateral';
  }
  if (lowerName.includes('encumbrance') || lowerName.includes('ec')) {
    return 'collateral';
  }
  if (lowerName.includes('7/12') || lowerName.includes('8a')) {
    return 'collateral';
  }
  
  // Default: uncategorized
  return '';
}

// Auto-classify document to specific document type within a category
async function autoClassifyDocument(filename, extractedText, category, proposal) {
  const lowerName = filename.toLowerCase();
  const lowerText = extractedText ? extractedText.toLowerCase() : '';
  
  // Build list of available document types for this category based on proposal
  const docTypes = getDocumentTypesForCategory(category, proposal);
  
  if (docTypes.length === 0) {
    return ''; // No specific types for this category
  }
  
  // Try rule-based classification first (faster)
  const ruleBasedClass = ruleBasedClassification(lowerName, lowerText, category, docTypes);
  if (ruleBasedClass) {
    console.log(`📋 Rule-based classification: ${ruleBasedClass}`);
    return ruleBasedClass;
  }
  
  // If rule-based fails and we have extracted text, try AI classification
  if (extractedText && extractedText.length > 50) {
    try {
      const aiClass = await aiClassifyDocument(extractedText, docTypes, filename);
      if (aiClass) {
        console.log(`🤖 AI classification: ${aiClass}`);
        return aiClass;
      }
    } catch (err) {
      console.error('AI classification error:', err.message);
    }
  }
  
  return '';
}

// Get all document types for a category based on proposal data
function getDocumentTypesForCategory(category, proposal) {
  const docTypes = [];
  const applicantName = proposal.applicantName || proposal.customerName || 'Applicant';
  
  switch (category) {
    case 'personalId':
      if (proposal.applicantType === 'Individual') {
        docTypes.push(`PAN Card of ${applicantName}`);
        docTypes.push(`Aadhar Card of ${applicantName}`);
      }
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type === 'Individual' && co.name) {
            docTypes.push(`PAN Card of ${co.name}`);
            docTypes.push(`Aadhar Card of ${co.name}`);
          }
        });
      }
      break;
      
    case 'businessId':
      if (proposal.applicantType !== 'Individual') {
        docTypes.push(`PAN Card of ${applicantName} (Non Individual)`);
        docTypes.push(`GST Certificate of ${applicantName}`);
        docTypes.push(`Labour License of ${applicantName}`);
        docTypes.push(`UDYAM Certificate of ${applicantName}`);
      }
      break;
      
    case 'incorporation':
      if (proposal.applicantType === 'Partnership') {
        docTypes.push('Partnership deed - Date of deed, Profit & Loss share of partners');
        docTypes.push('Reconstituted partnership deed - Date of deed, Profit & Loss share of partners');
      } else if (proposal.applicantType === 'Private Limited' || proposal.applicantType === 'Public Limited') {
        docTypes.push('Certificate of Incorporation');
        docTypes.push('Memorandum of Association');
        docTypes.push('Articles of Association');
      }
      break;
      
    case 'creditReports':
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type === 'Individual' && co.name) {
            docTypes.push(`Personal Credit Report of ${co.name}`);
          }
        });
      }
      if (proposal.applicantType !== 'Individual') {
        docTypes.push(`Business Credit Report of ${applicantName}`);
      }
      break;
      
    case 'financials':
      docTypes.push(`ITR of Current Year of ${applicantName}`);
      docTypes.push(`ITR of Previous Year of ${applicantName}`);
      docTypes.push(`ITR of Preceding previous year of ${applicantName}`);
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type === 'Individual' && co.name) {
            docTypes.push(`ITR of Current Year of ${co.name}`);
            docTypes.push(`ITR of Previous Year of ${co.name}`);
            docTypes.push(`ITR of Preceding previous year of ${co.name}`);
          }
        });
      }
      break;
      
    case 'banking':
      docTypes.push(`Bank Statement of ${applicantName}`);
      docTypes.push(`Overdraft Bank Statement of ${applicantName}`);
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type === 'Individual' && co.name) {
            docTypes.push(`Bank Statement of ${co.name}`);
          }
        });
      }
      break;
      
    case 'turnover':
      docTypes.push('GST 3B returns for last 12 months');
      docTypes.push('GST 1 returns for last 12 months');
      break;
      
    case 'debtProfile':
      docTypes.push('All Existing Loan Details');
      break;
      
    case 'collateral':
      docTypes.push('Title Documents');
      docTypes.push('Tax paid Receipts');
      docTypes.push('Approved Sanction Plan');
      docTypes.push('Encumberance Certificate');
      docTypes.push('Title Documents - Unregistered');
      break;
  }
  
  return docTypes;
}

// Rule-based classification for quick matching
function ruleBasedClassification(lowerName, lowerText, category, docTypes) {
  switch (category) {
    case 'personalId':
      // Check for PAN Card
      if (lowerName.includes('pan') || lowerText.includes('permanent account number') || lowerText.includes('income tax department')) {
        // Try to match with a specific person's PAN
        for (const docType of docTypes) {
          if (docType.includes('PAN Card')) {
            const personName = docType.replace('PAN Card of ', '').toLowerCase();
            if (lowerName.includes(personName.split(' ')[0]) || lowerText.includes(personName)) {
              return docType;
            }
          }
        }
        // Return first PAN card type if no specific match
        return docTypes.find(d => d.includes('PAN Card')) || '';
      }
      // Check for Aadhar Card
      if (lowerName.includes('aadhar') || lowerName.includes('aadhaar') || 
          lowerText.includes('unique identification') || lowerText.includes('aadhaar')) {
        for (const docType of docTypes) {
          if (docType.includes('Aadhar Card')) {
            const personName = docType.replace('Aadhar Card of ', '').toLowerCase();
            if (lowerName.includes(personName.split(' ')[0]) || lowerText.includes(personName)) {
              return docType;
            }
          }
        }
        return docTypes.find(d => d.includes('Aadhar Card')) || '';
      }
      break;
      
    case 'businessId':
      if (lowerName.includes('pan') || lowerText.includes('permanent account number')) {
        return docTypes.find(d => d.includes('PAN Card')) || '';
      }
      if (lowerName.includes('gst') || lowerText.includes('goods and services tax')) {
        return docTypes.find(d => d.includes('GST Certificate')) || '';
      }
      if (lowerName.includes('labour') || lowerName.includes('labor')) {
        return docTypes.find(d => d.includes('Labour License')) || '';
      }
      if (lowerName.includes('udyam') || lowerName.includes('msme')) {
        return docTypes.find(d => d.includes('UDYAM')) || '';
      }
      break;
      
    case 'incorporation':
      if (lowerName.includes('reconstitut') || lowerText.includes('reconstitution')) {
        return docTypes.find(d => d.includes('Reconstituted')) || '';
      }
      if (lowerName.includes('partnership') || lowerText.includes('partnership deed')) {
        return docTypes.find(d => d.includes('Partnership deed') && !d.includes('Reconstituted')) || '';
      }
      if (lowerName.includes('incorporation') || lowerName.includes('coi')) {
        return 'Certificate of Incorporation';
      }
      if (lowerName.includes('moa') || lowerName.includes('memorandum')) {
        return 'Memorandum of Association';
      }
      if (lowerName.includes('aoa') || lowerName.includes('articles')) {
        return 'Articles of Association';
      }
      break;
      
    case 'turnover':
      if (lowerName.includes('3b') || lowerName.includes('gstr3b') || lowerName.includes('gstr-3b')) {
        return 'GST 3B returns for last 12 months';
      }
      if (lowerName.includes('gstr1') || lowerName.includes('gstr-1') || lowerName.includes('gst1')) {
        return 'GST 1 returns for last 12 months';
      }
      break;
      
    case 'debtProfile':
      return 'All Existing Loan Details';
      
    case 'collateral':
      if (lowerName.includes('tax') && lowerName.includes('receipt')) {
        return 'Tax paid Receipts';
      }
      if (lowerName.includes('sanction') || lowerName.includes('plan')) {
        return 'Approved Sanction Plan';
      }
      if (lowerName.includes('encumbr') || lowerName.includes('ec')) {
        return 'Encumberance Certificate';
      }
      if (lowerName.includes('unregist')) {
        return 'Title Documents - Unregistered';
      }
      if (lowerName.includes('title') || lowerName.includes('deed')) {
        return 'Title Documents';
      }
      break;
  }
  
  return '';
}

// AI-based classification using OpenRouter
async function aiClassifyDocument(extractedText, docTypes, filename) {
  if (!process.env.OPENROUTER_API_KEY) {
    return '';
  }
  
  const prompt = `You are a document classifier for a loan application system.

Based on the document content below, classify it into ONE of the following document types:
${docTypes.map((d, i) => `${i + 1}. ${d}`).join('\n')}

Document filename: ${filename}
Document content (first 1500 characters):
${extractedText.substring(0, 1500)}

Respond with ONLY the exact document type from the list above that best matches this document. If you cannot determine the type, respond with "UNKNOWN".`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/copilot',
        'X-Title': 'Document Classifier'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.1
      })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    const result = data.choices[0]?.message?.content?.trim() || '';
    
    // Validate that the result is one of the expected types
    if (result && result !== 'UNKNOWN' && docTypes.includes(result)) {
      return result;
    }
    
    // Try partial match
    for (const docType of docTypes) {
      if (result.toLowerCase().includes(docType.toLowerCase().substring(0, 20))) {
        return docType;
      }
    }
    
    return '';
  } catch (error) {
    console.error('AI classification API error:', error.message);
    return '';
  }
}

// ============================================
// 3-TIER PDF EXTRACTION SYSTEM
// ============================================
// Tier 1: PyMuPDF (fastest and best quality)
// Tier 2: pdfplumber fallback
// Tier 3: Node.js pdf-parse as final fallback

/**
 * Tier 1: Extract PDF using PyMuPDF (fastest and best quality)
 */
async function extractWithPyMuPDF(pdfPath) {
  console.log('🔹 Tier 1: Attempting PyMuPDF extraction (fastest)...');

  return new Promise((resolve, reject) => {
    // Try 'python' first, then 'python3'
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const scriptPath = path.join(__dirname, 'extract_pdf_pymupdf.py');

    const pythonProcess = spawn(pythonCmd, [scriptPath, pdfPath]);

    let resultText = '';
    let errorText = '';

    pythonProcess.stdout.on('data', (data) => {
      resultText += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorText += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`✗ PyMuPDF process exited with code ${code}`);
        console.error(`stderr: ${errorText}`);
        reject(new Error(`PyMuPDF failed with code ${code}: ${errorText}`));
      } else {
        try {
          const result = JSON.parse(resultText);
          if (result.success) {
            console.log(`✓ PyMuPDF extraction complete: ${result.totalChars} chars, ${result.numPages} pages`);
            resolve({
              text: result.text,
              numPages: result.numPages,
              method: 'pymupdf',
              success: true
            });
          } else {
            reject(new Error(result.error || 'PyMuPDF extraction failed'));
          }
        } catch (parseError) {
          console.error('✗ Failed to parse PyMuPDF output:', parseError.message);
          reject(parseError);
        }
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('✗ Failed to start PyMuPDF process:', err);
      reject(err);
    });
  });
}

/**
 * Tier 2: Direct pdfplumber extraction (fallback)
 */
async function extractWithPdfplumber(pdfPath) {
  console.log('🔹 Tier 2: Attempting pdfplumber extraction...');

  return new Promise((resolve, reject) => {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonProcess = spawn(pythonCmd, ['extract_pdf.py', pdfPath]);

    let resultText = '';
    let errorText = '';

    pythonProcess.stdout.on('data', (data) => {
      resultText += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorText += data.toString();
      console.log(`pdfplumber: ${data}`);
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`✗ pdfplumber process exited with code ${code}`);
        reject(new Error(`pdfplumber failed with code ${code}`));
      } else {
        // Parse JSON output from Python script
        try {
          const result = JSON.parse(resultText);
          console.log(`✓ pdfplumber extraction complete: ${result.text.length} chars, ${result.numPages} pages`);
          resolve(result);
        } catch (parseError) {
          // Fallback: treat as plain text (backward compatibility)
          console.log(`✓ pdfplumber extraction complete: ${resultText.length} chars (plain text)`);
          resolve({ text: resultText, numPages: 1 });
        }
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('✗ Failed to start pdfplumber process:', err);
      reject(err);
    });
  });
}

/**
 * Tier 3: Node.js pdf-parse extraction (final fallback)
 */
async function extractWithPdfParse(pdfPath) {
  console.log('🔹 Tier 3: Attempting Node.js pdf-parse extraction...');
  
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const pdfData = await pdfParse(dataBuffer);
    
    console.log(`✓ pdf-parse extraction complete: ${pdfData.text.length} chars`);
    
    return {
      text: pdfData.text,
      numPages: pdfData.numpages,
      method: 'nodejs-pdfparse',
      success: true
    };
  } catch (error) {
    console.error('✗ pdf-parse extraction failed:', error.message);
    throw error;
  }
}

/**
 * Main PDF extraction function with 3-tier fallback system
 */
async function extractPDFWithFallback(pdfPath) {
  console.log('\n========================================');
  console.log('📄 STARTING 3-TIER PDF EXTRACTION');
  console.log(`File: ${path.basename(pdfPath)}`);
  console.log('========================================\n');

  // Tier 1: Try PyMuPDF (fastest and best quality)
  try {
    const result = await extractWithPyMuPDF(pdfPath);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: PyMuPDF extraction completed\n');
      return result;
    }
  } catch (tier1Error) {
    console.log('⚠ Tier 1 (PyMuPDF) failed, falling back to Tier 2...\n');
  }

  // Tier 2: Try pdfplumber
  try {
    const result = await extractWithPdfplumber(pdfPath);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: pdfplumber extraction completed\n');
      return {
        text: result.text,
        numPages: result.numPages || 1,
        method: 'pdfplumber',
        success: true
      };
    }
  } catch (tier2Error) {
    console.log('⚠ Tier 2 (pdfplumber) failed, falling back to Tier 3...\n');
  }

  // Tier 3: Try Node.js pdf-parse
  try {
    const result = await extractWithPdfParse(pdfPath);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: pdf-parse extraction completed\n');
      return result;
    }
  } catch (tier3Error) {
    console.log('✗ All tiers failed\n');
  }

  // All tiers failed
  console.log('========================================');
  console.log('✗ EXTRACTION FAILED: All methods exhausted');
  console.log('========================================\n');

  return {
    text: '',
    numPages: 0,
    method: 'none',
    success: false,
    error: 'All extraction methods failed'
  };
}

// Legacy function for backwards compatibility - redirects to new system
async function extractPDFWithTableDetection(pdfPath) {
  const result = await extractPDFWithFallback(pdfPath);
  
  // Convert to legacy format for backwards compatibility
  return {
    text: result.text,
    tables: [],
    structuredContent: [{
      pageNum: 1,
      text: result.text,
      hasTable: false,
      tables: []
    }],
    numPages: result.numPages,
    success: result.success,
    method: result.method
  };
}

// Detect and extract tables from page lines (Tabula/Camelot-like algorithm)
function detectAndExtractTables(pageLines, pageNum) {
  const tables = [];
  let currentTable = [];
  let inTable = false;
  let columnPositions = [];
  
  pageLines.forEach((line, index) => {
    const lineText = line.text.trim();
    
    // Detect table indicators: pipes, multiple columns, percentage signs
    const hasPipes = lineText.includes('|');
    const hasMultipleColumns = line.items.length >= 3;
    const hasTableKeywords = /partner|name|profit|loss|ratio|percentage|account|bank|date|period/i.test(lineText);
    const isLikelyTableRow = hasPipes || (hasMultipleColumns && line.items.some(item => /\d+(?:\.\d+)?%|\d{4}/.test(item.text)));
    
    if (isLikelyTableRow || (hasMultipleColumns && hasTableKeywords)) {
      if (!inTable) {
        inTable = true;
        // Establish column positions from first row
        columnPositions = line.items.map(item => ({ x: item.x, width: item.width }));
      }
      
      // Extract cells based on pipe delimiters or position alignment
      let cells = [];
      if (hasPipes) {
        cells = lineText.split('|').map(c => c.trim()).filter(c => c);
      } else {
        // Group items by proximity to column positions
        cells = line.items.map(item => item.text.trim());
      }
      
      currentTable.push(cells);
    } else if (inTable && lineText === '') {
      // Empty line ends table
      if (currentTable.length > 1) {
        tables.push({
          pageNum,
          headers: currentTable[0],
          rows: currentTable.slice(1),
          type: detectTableType(currentTable)
        });
      }
      currentTable = [];
      inTable = false;
      columnPositions = [];
    } else if (inTable && !isLikelyTableRow) {
      // Non-table line while in table - end current table
      if (currentTable.length > 1) {
        tables.push({
          pageNum,
          headers: currentTable[0],
          rows: currentTable.slice(1),
          type: detectTableType(currentTable)
        });
      }
      currentTable = [];
      inTable = false;
      columnPositions = [];
    }
  });
  
  // Add last table if exists
  if (currentTable.length > 1) {
    tables.push({
      pageNum,
      headers: currentTable[0],
      rows: currentTable.slice(1),
      type: detectTableType(currentTable)
    });
  }
  
  return tables;
}

// Detect table type for specialized extraction
function detectTableType(tableData) {
  const allText = JSON.stringify(tableData).toLowerCase();
  
  if (/partner.*profit.*loss|profit.*loss.*ratio/.test(allText)) {
    return 'partnership-profit-loss';
  } else if (/bank.*account|account.*holder/.test(allText)) {
    return 'bank-statement';
  } else if (/transaction|debit|credit/.test(allText)) {
    return 'transaction-table';
  }
  
  return 'general';
}

// ============================================
// DOCUMENT AI SERVICE (OpenRouter)
// ============================================

// Use Document AI (via OpenRouter) for intelligent structured extraction
async function extractWithDocumentAI(text, documentType, tables = []) {
  try {
    let prompt = '';
    
    if (documentType === 'partnership-deed') {
      prompt = `You are a document extraction AI. Extract the following information from this partnership deed document:

1. Date of Execution: Find the date when the deed was executed/signed. Look for phrases like:
   - "made and executed on this [day] of [month], [year]"
   - "dated [day] [month] [year]"
   - "executed on [date]"
   - Extract the full date in format: "DD Month YYYY" (e.g., "11 June 2025")

2. Partners: Extract ALL partner names with their profit and loss sharing percentages. 
   
   CRITICAL: Search through ALL numbered points/clauses in the document to find the clause that discusses:
   - "Profit and Loss Sharing" or "Distribution of Profit and Loss"
   - "Sharing Ratio" or "Profit Sharing Ratio"
   - "Division of Profits" or "Loss Distribution"
   
   This information could be in ANY point number (e.g., Point 5, 10, 15, 20, etc.). 
   Read the ENTIRE document and identify which clause contains the profit/loss sharing details.
   
   Also look for:
   - Partner names in tables or lists
   - Profit/loss sharing ratios (e.g., "50:50", "60% profit", "equal shares")
   - Capital contributions with associated names
   - Percentages associated with partner names (e.g., "Partner A: 60%, Partner B: 40%")

Document Text:
${text.substring(0, 8000)}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables, null, 2)}` : ''}

IMPORTANT INSTRUCTIONS:
- For dates like "11th day of JUNE, 2025" or "11" day of JUNE, 2025", extract as "11 June 2025"
- Convert month names to proper case (e.g., JUNE → June)
- SCAN ALL numbered clauses/points to find the one about "profit and loss sharing" - it could be anywhere
- CAREFULLY READ the clause about profit and loss sharing and extract exact percentages
- For profit/loss percentages, extract numeric values only (e.g., if it says "60% and 40%", extract 60.0 and 40.0)
- If profit and loss ratios are mentioned as "60:40", extract profit as 60.0 and loss as 40.0
- If "equal shares" or "equally" is mentioned, calculate equal percentages among all partners
- Match each partner name with their specific profit and loss percentages
- If profit/loss ratio is not explicitly stated, return null for those values
- Include ALL partners mentioned in the document

Respond ONLY with valid JSON in this exact format:
{
  "dateOfExecution": "DD Month YYYY" or null,
  "partners": [
    {
      "name": "Partner Name",
      "profitPercentage": 50.0,
      "lossPercentage": 50.0
    }
  ]
}`;
    } else if (documentType === 'bank-statement') {
      prompt = `You are a document extraction AI. Extract the following from this bank statement:

1. Bank Name
2. Account Holder Name
3. Account Number
4. Statement Period (from date to date)

Document Text:
${text.substring(0, 4000)}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables, null, 2)}` : ''}

Respond ONLY with valid JSON in this exact format:
{
  "bankName": "Bank Name" or null,
  "accountHolder": "Account Holder Name" or null,
  "accountNumber": "1234567890" or null,
  "periodFrom": "DD/MM/YYYY" or null,
  "periodTo": "DD/MM/YYYY" or null
}`;
    }
    
    // Retry logic for rate limiting
    let retries = 3;
    let delay = 10000; // Start with 10 second delay for rate limits
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`🤖 AI Extraction attempt ${attempt}/${retries}...`);
        
        const response = await axios.post(
          OPENROUTER_API_URL,
          {
            model: 'openai/gpt-4o', // GPT-4o for best quality document analysis
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.1, // Low temperature for consistent extraction
            max_tokens: 1000
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'http://localhost:3000',
              'X-Title': 'Customer Profiling App'
            },
            timeout: 30000 // 30 second timeout for GPT-4o
          }
        );
        
        const content = response.data.choices[0].message.content;
        console.log('📄 Document AI Response:', content);
        
        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const extracted = JSON.parse(jsonMatch[0]);
          return {
            success: true,
            data: extracted,
            method: 'openrouter-document-ai'
          };
        }
        
        return { success: false, error: 'No JSON found in response' };
      } catch (error) {
        if (error.response && error.response.status === 429 && attempt < retries) {
          console.log(`⚠️ Rate limit hit (429), waiting ${delay}ms before retry ${attempt + 1}/${retries}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
          continue;
        }
        
        // If not a rate limit error or last attempt, throw
        console.error('Document AI extraction error:', error.message);
        return { 
          success: false, 
          error: error.response?.status === 429 
            ? 'API rate limit reached. Please wait a moment and try again.' 
            : error.message 
        };
      }
    }
    
    return { success: false, error: 'Max retries reached' };
  } catch (error) {
    console.error('Document AI extraction error:', error.message);
    return { success: false, error: error.message };
  }
}

// Helper function to normalize deed date format
function normalizeDeedDate(dateStr) {
  if (!dateStr) return null;
  
  // Remove ordinal suffixes (st, nd, rd, th)
  let normalized = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  
  // Remove "day of" phrase
  normalized = normalized.replace(/\s+day\s+of\s+/gi, ' ');
  
  // Clean up extra spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();
  
  // Try to parse and format as DD Month YYYY
  const monthNames = {
    'january': 'January', 'jan': 'January',
    'february': 'February', 'feb': 'February',
    'march': 'March', 'mar': 'March',
    'april': 'April', 'apr': 'April',
    'may': 'May',
    'june': 'June', 'jun': 'June',
    'july': 'July', 'jul': 'July',
    'august': 'August', 'aug': 'August',
    'september': 'September', 'sep': 'September',
    'october': 'October', 'oct': 'October',
    'november': 'November', 'nov': 'November',
    'december': 'December', 'dec': 'December'
  };
  
  // Match pattern: number month year
  const match = normalized.match(/(\d{1,2})\s+([a-z]+)[,\s]+(\d{4})/i);
  if (match) {
    const day = match[1];
    const month = monthNames[match[2].toLowerCase()] || match[2];
    const year = match[3];
    return `${day} ${month} ${year}`;
  }
  
  return normalized;
}

// ============================================
// IMAGE OCR SERVICE (OpenAI Vision via OpenRouter)
// ============================================

/**
 * Extract text from images (JPG/PNG) using OpenAI Vision API via OpenRouter
 * Used for banker policy documents and other image-based documents
 */
async function extractTextFromImage(imagePath) {
  try {
    console.log('🖼️ Starting image OCR extraction:', path.basename(imagePath));
    
    // Read image file and convert to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Determine image MIME type
    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') {
      mimeType = 'image/png';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    }
    
    console.log(`Image size: ${(imageBuffer.length / 1024).toFixed(2)} KB, Type: ${mimeType}`);
    
    // Retry logic for rate limiting
    let retries = 3;
    let delay = 10000;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`🤖 Vision API attempt ${attempt}/${retries}...`);
        
        const response = await axios.post(
          OPENROUTER_API_URL,
          {
            model: 'openai/gpt-4o', // GPT-4o with vision capabilities
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Extract all text from this image. This is a document (possibly a banker policy, financial document, or business document). 
                    
Please:
1. Extract ALL text visible in the image
2. Maintain the document structure and formatting as much as possible
3. Preserve tables, lists, and hierarchical information
4. Include headers, footers, and any metadata
5. If this is a banker policy or financial document, pay special attention to:
   - Policy details
   - Names and addresses
   - Account numbers
   - Dates
   - Amounts and percentages
   - Terms and conditions

Return the extracted text in a clear, structured format.`
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${mimeType};base64,${base64Image}`
                    }
                  }
                ]
              }
            ],
            temperature: 0.1,
            max_tokens: 4000
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'http://localhost:3000',
              'X-Title': 'Customer Profiling App'
            },
            timeout: 60000 // 60 second timeout for vision processing
          }
        );
        
        const extractedText = response.data.choices[0].message.content;
        console.log(`✓ Vision OCR successful: ${extractedText.length} characters extracted`);
        
        return {
          success: true,
          text: extractedText,
          method: 'openai-vision-ocr',
          charCount: extractedText.length
        };
        
      } catch (error) {
        if (error.response && error.response.status === 429 && attempt < retries) {
          console.log(`⚠️ Rate limit hit (429), waiting ${delay}ms before retry ${attempt + 1}/${retries}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        
        console.error(`✗ Vision OCR error (attempt ${attempt}):`, error.message);
        
        if (attempt === retries) {
          return {
            success: false,
            text: '',
            method: 'openai-vision-ocr',
            error: error.response?.status === 429 
              ? 'API rate limit reached. Please wait and try again.' 
              : error.message
          };
        }
      }
    }
    
    return {
      success: false,
      text: '',
      method: 'openai-vision-ocr',
      error: 'Max retries reached'
    };
    
  } catch (error) {
    console.error('✗ Image OCR extraction failed:', error.message);
    return {
      success: false,
      text: '',
      method: 'openai-vision-ocr',
      error: error.message
    };
  }
}

// Extract partnership deed details from text or extracted tables
function extractPartnershipDeedDetails(fullText, tables = []) {
  const details = {
    deedDate: null,
    partners: []
  };

  if (!fullText) {
    console.log('No text provided for extraction');
    return details;
  }

  console.log('Extracting from text length:', fullText.length);
  
  // STEP 0: Try Document AI first for most accurate extraction (async will be handled by caller)
  // Note: This function remains synchronous, AI extraction called separately
  
  // STEP 1: Try extracting partners from detected tables first (table-aware approach)
  if (tables && tables.length > 0) {
    const partnershipTable = tables.find(t => t.type === 'partnership-profit-loss');
    
    if (partnershipTable) {
      console.log('✓ Found partnership profit/loss table:', partnershipTable);
      
      // Extract partners from table rows
      partnershipTable.rows.forEach(row => {
        if (row.length >= 2) {
          const name = row[0];
          const profitText = row.find(cell => cell.includes('%')) || row[1] || '';
          const lossText = row.find((cell, idx) => idx > 0 && cell.includes('%')) || row[2] || '';
          
          const profitMatch = profitText.match(/(\d+(?:\.\d+)?)%?/);
          const lossMatch = lossText.match(/(\d+(?:\.\d+)?)%?/);
          
          if (name && name.length > 2 && (profitMatch || lossMatch)) {
            details.partners.push({
              name: name.trim(),
              profitPercent: profitMatch ? parseFloat(profitMatch[1]) : 'Not specified',
              lossPercent: lossMatch ? parseFloat(lossMatch[1]) : 'Not specified'
            });
          }
        }
      });
      
      if (details.partners.length > 0) {
        console.log('✓ Extracted partners from table:', details.partners);
      }
    }
  }
  
  const lowerText = fullText.toLowerCase();
  
  // STEP 2: Extract deed date - comprehensive patterns
  // Priority 1: Look for execution date specifically (most reliable)
  const executionDatePatterns = [
    // "made and executed on this 11t day of JUNE, 2025" - OCR may have "11t" instead of "11th"
    /(?:made\s+and\s+executed\s+on|executed\s+on|this\s+deed.*?made\s+on)\s*(?:this\s+)?(\d{1,2}[a-z]*\s+day\s+of\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)[,\s]+\d{4})/gi,
    // "dated this X day of MONTH, YEAR"
    /(?:dated\s+this|made\s+this)\s+(\d{1,2}[a-z]*\s+(?:day\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)[,\s]+\d{4})/gi,
  ];

  // Try execution date patterns first (highest priority)
  for (const pattern of executionDatePatterns) {
    const matches = [...fullText.matchAll(pattern)];
    if (matches.length > 0) {
      const rawDate = matches[0][1];
      details.deedDate = normalizeDeedDate(rawDate);
      console.log('Found execution date (raw):', rawDate);
      console.log('Found execution date (normalized):', details.deedDate);
      break;
    }
  }

  // Priority 2: Fallback patterns if no execution date found
  if (!details.deedDate) {
    const datePatterns = [
      /(?:dated|executed\s+on|dated\s+this|made\s+this|entered\s+into\s+on|deed\s+dated|this\s+deed\s+of\s+partnership\s+made\s+on|made\s+and\s+executed\s+on\s+this)\s*(?:the\s*)?(\d{1,2}(?:st|nd|rd|th)?[a-z]*\s+(?:day\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[,\s]+\d{4})/gi,
      /(?:deed\s+date|date\s+of\s+deed|execution\s+date|on\s+this|amendment\s+dated)[\s:]+(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4})/gi,
      // Avoid dates after "Dt." which are references to old deeds
      /(?<!Dt\.?\s*)(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{4})/g
    ];

    for (const pattern of datePatterns) {
      const matches = fullText.matchAll(pattern);
      for (const match of matches) {
        if (match[1] || match[0]) {
          const rawDate = match[1] || match[0];
          details.deedDate = normalizeDeedDate(rawDate);
          console.log('Found date (raw):', rawDate);
          console.log('Found date (normalized):', details.deedDate);
          break;
        }
      }
      if (details.deedDate) break;
    }
  }

  // STEP 3: Enhanced profit/loss sharing extraction (fallback if table extraction didn't find partners)
  if (details.partners.length === 0) {
    console.log('Attempting to extract partners from OCR text...');

    // Pattern 1: Match OCR table format - "1 Sri.NAME NAME 50.00% 50.00%" or "Sri NAME NAME | 50.00% | 50.00%"
    // Look for lines with Sri/Smt followed by name and two percentages
    // Allow any prefix (OCR can corrupt numbers like "1" to "18", "2" to "Zs", etc.)
    const ocrTablePattern = /(?:^|\n)\s*(?:[\dA-Z]+\s+)?(?:Sri\.?|Smt\.?|Mr\.?|Mrs\.?|Ms\.?)\s*([A-Z][A-Z\s\.]+?)\s+(\d+(?:\.\d+)?)\s*%\s*[|\s]*(\d+(?:\.\d+)?)\s*%/gi;
    let ocrMatches = [...fullText.matchAll(ocrTablePattern)];

    // Also try a more flexible pattern that looks directly for name + percentage patterns in the profit/loss section
    if (ocrMatches.length < 2) {
      // Look for the PROFIT AND LOSS table and extract all partners
      const profitLossTableMatch = fullText.match(/(?:THE\s+)?PROFIT\s+AND\s+LOSS[\s\S]*?(?:Total|100\.00%\s*\|?\s*100\.00%)/i);
      if (profitLossTableMatch) {
        const tableText = profitLossTableMatch[0];
        // More flexible pattern: any prefix + (Sri/Smt) + NAME + percentage + percentage
        const flexPattern = /(?:[\dA-Za-z]+\s+)?(?:Sri\.?|Smt\.?)\s*\.?\s*([A-Z][A-Z\s\.]+?)\s+(\d+(?:\.\d+)?)\s*%\s*[|\s]*(\d+(?:\.\d+)?)\s*%/gi;
        const flexMatches = [...tableText.matchAll(flexPattern)];
        if (flexMatches.length > ocrMatches.length) {
          ocrMatches = flexMatches;
          console.log('Using flexible pattern, found:', flexMatches.length, 'matches');
        }
      }
    }

    if (ocrMatches.length > 0) {
      console.log('Found OCR table pattern matches:', ocrMatches.length);
      ocrMatches.forEach(match => {
        const name = match[1].trim().replace(/\s+/g, ' ');
        const profit = parseFloat(match[2]);
        const loss = parseFloat(match[3]);

        // Skip if name looks like a header or total
        if (name.toLowerCase().includes('total') || name.toLowerCase().includes('partner') || name.length < 3) {
          return;
        }

        // Check for duplicates
        const isDuplicate = details.partners.some(p =>
          p.name.toLowerCase().replace(/\s+/g, '') === name.toLowerCase().replace(/\s+/g, '')
        );

        if (!isDuplicate && profit > 0) {
          details.partners.push({
            name: name,
            profitPercent: profit,
            lossPercent: loss
          });
          console.log('✓ Found partner from OCR:', name, profit + '%', loss + '%');
        }
      });
    }

    // Pattern 2: Look for profit/loss table section and extract from there
    if (details.partners.length === 0) {
      // Find the profit and loss section
      const profitLossSection = fullText.match(/(?:THE\s+)?PROFIT\s+AND\s+LOSS[\s\S]{0,1500}/i);
      if (profitLossSection) {
        console.log('Found PROFIT AND LOSS section, searching for partners...');

        // Look for pattern: "Sri NAME NAME 50.00% 50.00%" within this section
        const sectionText = profitLossSection[0];
        const partnerPattern = /(?:Sri\.?|Smt\.?)\s*([A-Z][A-Z\s\.]+?(?:REDDY|KUMAR|SINGH|RAO|NAIDU|SHARMA|BOMMU|ALLA)[A-Z\s]*?)\s+(\d+(?:\.\d+)?)\s*%\s*[|\s]*(\d+(?:\.\d+)?)\s*%/gi;

        let partnerMatches = [...sectionText.matchAll(partnerPattern)];
        partnerMatches.forEach(match => {
          const name = match[1].trim().replace(/\s+/g, ' ');
          const profit = parseFloat(match[2]);
          const loss = parseFloat(match[3]);

          if (name.length > 3 && profit > 0) {
            const isDuplicate = details.partners.some(p =>
              p.name.toLowerCase().includes(name.toLowerCase().split(' ')[0])
            );

            if (!isDuplicate) {
              details.partners.push({
                name: 'Sri. ' + name,
                profitPercent: profit,
                lossPercent: loss
              });
              console.log('✓ Found partner in P&L section:', name, profit + '%', loss + '%');
            }
          }
        });
      }
    }

    // Pattern 3: Look for "Name of the Partner" table header and extract rows
    if (details.partners.length === 0) {
      const tableHeaderMatch = fullText.match(/Name\s+of\s+the\s+Partner[\s\S]{0,100}Profit[\s\S]{0,50}Loss([\s\S]{0,1000}?)(?:Total|MANAGEMENT|100\.00%\s*\|?\s*100\.00%)/i);
      if (tableHeaderMatch) {
        console.log('Found partner table with header...');
        const tableContent = tableHeaderMatch[1];

        // Extract rows: "1 | Sri NAME | 50.00% | 50.00%" or similar
        const rowPattern = /(?:\d+\s*[|\s]+)?(?:Sri\.?|Smt\.?)\s*([A-Z][A-Z\s\.]+?)\s+(\d+(?:\.\d+)?)\s*%\s*[|\s]*(\d+(?:\.\d+)?)\s*%/gi;
        let rowMatches = [...tableContent.matchAll(rowPattern)];

        rowMatches.forEach(match => {
          const name = match[1].trim().replace(/\s+/g, ' ');
          const profit = parseFloat(match[2]);
          const loss = parseFloat(match[3]);

          if (name.length > 3 && profit > 0 && !name.toLowerCase().includes('total')) {
            details.partners.push({
              name: 'Sri. ' + name,
              profitPercent: profit,
              lossPercent: loss
            });
            console.log('✓ Found partner in table:', name, profit + '%', loss + '%');
          }
        });
      }
    }

    // Pattern 4: Simple fallback - look for any "NAME 50.00% 50.00%" near profit/loss keywords
    if (details.partners.length === 0) {
      console.log('Trying simple percentage pattern...');
      // Find all instances of "NAME 50.00% 50.00%" pattern
      const simplePattern = /([A-Z][A-Z\s]{5,40}?)\s+(\d{1,3}(?:\.\d{1,2})?)\s*%\s*[|\s]*(\d{1,3}(?:\.\d{1,2})?)\s*%/g;
      let simpleMatches = [...fullText.matchAll(simplePattern)];

      // Filter to only keep likely partner names (near profit/loss section)
      const profitLossIndex = fullText.toUpperCase().indexOf('PROFIT AND LOSS');
      if (profitLossIndex > -1) {
        simpleMatches = simpleMatches.filter(m => {
          const matchIndex = fullText.indexOf(m[0]);
          return matchIndex > profitLossIndex && matchIndex < profitLossIndex + 2000;
        });
      }

      simpleMatches.slice(0, 5).forEach(match => { // Limit to first 5 matches
        const name = match[1].trim().replace(/\s+/g, ' ');
        const profit = parseFloat(match[2]);
        const loss = parseFloat(match[3]);

        // Skip headers, totals, keywords, and short names
        const lowerName = name.toLowerCase();
        if (name.length < 5 || lowerName.includes('total') ||
            lowerName.includes('partner') || lowerName.includes('name') ||
            lowerName.includes('profit') || lowerName.includes('loss') ||
            lowerName.includes('sharing') || lowerName.includes('ratio') ||
            lowerName.includes('percentage') || lowerName.includes('share')) {
          return;
        }

        if (profit > 0 && profit <= 100) {
          details.partners.push({
            name: name,
            profitPercent: profit,
            lossPercent: loss
          });
          console.log('✓ Found partner (simple):', name, profit + '%', loss + '%');
        }
      });
    }
  }

  console.log('Extraction complete. Date:', details.deedDate, 'Partners:', details.partners.length);
  return details;
}

// Extract shareholders and directors for Private Limited companies
function extractPrivateLimitedDetails(fullText, tables = []) {
  const details = {
    companyName: null,
    shareholders: [],
    directors: []
  };

  if (!fullText) {
    console.log('No text provided for Private Limited extraction');
    return details;
  }

  console.log('Extracting Private Limited details from text length:', fullText.length);

  // Extract company name
  const companyNamePatterns = [
    /(?:company\s+name|name\s+of\s+(?:the\s+)?company)[\s:]+([A-Z][A-Za-z\s]+(?:PRIVATE|PVT\.?)\s*(?:LIMITED|LTD\.?))/gi,
    /([A-Z][A-Za-z\s]+(?:PRIVATE|PVT\.?)\s*(?:LIMITED|LTD\.?))/g
  ];

  for (const pattern of companyNamePatterns) {
    const match = fullText.match(pattern);
    if (match && match[0]) {
      details.companyName = match[0].trim();
      console.log('Found company name:', details.companyName);
      break;
    }
  }

  // Extract shareholders from text
  const shareholderPatterns = [
    // Pattern: "Name - X shares" or "Name holding X shares"
    /([A-Z][a-zA-Z\s]+?)(?:\s*[-–]\s*|\s+holding\s+|\s+holds\s+)(\d+(?:,\d+)?)\s*(?:equity\s+)?shares/gi,
    // Pattern: "X shares held by Name"
    /(\d+(?:,\d+)?)\s*(?:equity\s+)?shares?\s+(?:held\s+by|of)\s+([A-Z][a-zA-Z\s]+)/gi,
    // Pattern from table: Name | Shares | Percentage
    /([A-Z][a-zA-Z\s]+?)\s+(\d+(?:,\d+)?)\s+(\d+(?:\.\d+)?)\s*%/g
  ];

  const foundShareholders = new Map();

  for (const pattern of shareholderPatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      let name, shares;
      if (match[1] && !isNaN(parseInt(match[1].replace(/,/g, '')))) {
        // Pattern where shares come first
        shares = match[1].replace(/,/g, '');
        name = match[2];
      } else {
        name = match[1];
        shares = match[2] ? match[2].replace(/,/g, '') : null;
      }

      if (name && name.length > 2 && name.length < 100) {
        const cleanName = name.trim().replace(/\s+/g, ' ');
        if (!foundShareholders.has(cleanName.toLowerCase())) {
          foundShareholders.set(cleanName.toLowerCase(), {
            name: cleanName,
            shares: shares || '-',
            percentage: match[3] || null
          });
        }
      }
    }
  }

  details.shareholders = Array.from(foundShareholders.values());
  console.log('Found shareholders:', details.shareholders.length);

  // Extract directors from text
  const directorPatterns = [
    // Pattern: "DIN: XXXXXXXX Name"
    /DIN[\s:]+(\d{8})\s+([A-Z][a-zA-Z\s]+?)(?:\s+(?:Director|Managing|Whole|Executive))/gi,
    // Pattern: "Name (DIN: XXXXXXXX)"
    /([A-Z][a-zA-Z\s]+?)\s*\(?\s*DIN[\s:]+(\d{8})\s*\)?/gi,
    // Pattern: "Director Name" or "Managing Director Name"
    /(?:Director|Managing\s+Director|Whole\s+Time\s+Director)[\s:]+([A-Z][a-zA-Z\s]+?)(?:\s*[-–,]|\s+DIN)/gi,
    // Pattern from table with DIN
    /([A-Z][a-zA-Z\s]+?)\s+(\d{8})\s+(Director|Managing|Whole|Executive)/gi
  ];

  const foundDirectors = new Map();

  for (const pattern of directorPatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      let name, din, designation;

      // Check if first group is DIN (8 digits)
      if (match[1] && /^\d{8}$/.test(match[1])) {
        din = match[1];
        name = match[2];
        designation = match[3] || 'Director';
      } else {
        name = match[1];
        din = match[2] && /^\d{8}$/.test(match[2]) ? match[2] : null;
        designation = match[3] || 'Director';
      }

      if (name && name.length > 2 && name.length < 100) {
        const cleanName = name.trim().replace(/\s+/g, ' ');
        if (!foundDirectors.has(cleanName.toLowerCase())) {
          foundDirectors.set(cleanName.toLowerCase(), {
            name: cleanName,
            din: din || '-',
            designation: designation || 'Director'
          });
        }
      }
    }
  }

  details.directors = Array.from(foundDirectors.values());
  console.log('Found directors:', details.directors.length);

  // Try to extract from tables if available
  if (tables && tables.length > 0) {
    tables.forEach(table => {
      const headerText = (table.headers || []).join(' ').toLowerCase();

      // Check if it's a shareholders table
      if (headerText.includes('share') || headerText.includes('holder')) {
        table.rows.forEach(row => {
          if (row.length >= 2) {
            const name = row[0];
            const shares = row[1];
            const percentage = row[2] || null;

            if (name && name.length > 2 && !foundShareholders.has(name.toLowerCase())) {
              details.shareholders.push({
                name: name.trim(),
                shares: shares || '-',
                percentage: percentage
              });
            }
          }
        });
      }

      // Check if it's a directors table
      if (headerText.includes('director') || headerText.includes('din')) {
        table.rows.forEach(row => {
          if (row.length >= 1) {
            const name = row[0];
            const din = row.find(cell => /^\d{8}$/.test(cell)) || '-';
            const designation = row.find(cell => /director|managing|executive/i.test(cell)) || 'Director';

            if (name && name.length > 2 && !foundDirectors.has(name.toLowerCase())) {
              details.directors.push({
                name: name.trim(),
                din: din,
                designation: designation
              });
            }
          }
        });
      }
    });
  }

  console.log('Extraction complete. Shareholders:', details.shareholders.length, 'Directors:', details.directors.length);
  return details;
}

// Background file processing function
async function processFilesInBackground(files, proposalId, fileDetails) {
  console.log(`🔄 Starting background processing for ${files.length} files...`);
  
  const proposal = getProposalById(proposalId);
  if (!proposal || !proposal.documents) {
    console.error('Proposal not found for background processing');
    return;
  }
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileDetail = fileDetails[i];
    
    try {
      let extractedText = '';
      let fullText = '';
      let pageCount = null;
      let extractedDetails = null;
      
      // Process PDFs
      if (file.mimetype === 'application/pdf') {
        try {
          console.log(`📄 Processing PDF: ${file.originalname}`);
          // Use 3-tier fallback extraction
          const pdfResult = await extractPDFWithTableDetection(file.path);
          fullText = pdfResult.text;
          extractedText = pdfResult.text.substring(0, 500);
          pageCount = pdfResult.numPages;
          
          // Store extracted tables for later use
          file.extractedTables = pdfResult.tables;
          file.structuredContent = pdfResult.structuredContent;
          
          console.log(`✓ Extracted ${pdfResult.tables.length} tables from ${file.originalname}`);
        } catch (err) {
          console.error('PDF parsing error:', err);
        }
      }
      // Process images (JPG/PNG) with Vision OCR
      else if (file.mimetype && (file.mimetype.startsWith('image/jpeg') || 
                                   file.mimetype.startsWith('image/png') ||
                                   file.mimetype === 'image/jpg')) {
        try {
          console.log(`🖼️ Processing image: ${file.originalname}`);
          const ocrResult = await extractTextFromImage(file.path);
          
          if (ocrResult.success && ocrResult.text) {
            fullText = ocrResult.text;
            extractedText = ocrResult.text.substring(0, 500);
            console.log(`✓ OCR extracted ${ocrResult.charCount} characters from ${file.originalname}`);
          } else {
            console.error('Image OCR failed:', ocrResult.error);
          }
        } catch (err) {
          console.error('Image OCR error:', err);
        }
      }
      
      // Extract specific details for incorporation documents (partnership deeds)
      if (fileDetail.category === 'incorporation' && fullText) {
        console.log('Processing incorporation document:', file.originalname);
        
        // Try Document AI first
        const aiResult = await extractWithDocumentAI(fullText, 'partnership-deed', file.extractedTables || []);
        if (aiResult.success && aiResult.data) {
          console.log('✓ Document AI extraction successful:', aiResult.data);
          // Transform AI result to match expected format
          const partners = (aiResult.data.partners || []).map(p => ({
            name: p.name,
            profitPercent: p.profitPercentage !== null ? p.profitPercentage : 'Not specified',
            lossPercent: p.lossPercentage !== null ? p.lossPercentage : 'Not specified'
          }));
          extractedDetails = {
            deedDate: aiResult.data.dateOfExecution,
            partners: partners
          };
        } else {
          console.log('⚠ Document AI failed, using fallback extraction');
          extractedDetails = extractPartnershipDeedDetails(fullText, file.extractedTables || []);
        }
        
        console.log('Extracted details:', JSON.stringify(extractedDetails));
      }
      
      // Auto-classify the document to a specific document type
      let autoClassification = '';
      if (fileDetail.category) {
        try {
          autoClassification = await autoClassifyDocument(
            file.originalname, 
            fullText, 
            fileDetail.category, 
            proposal
          );
          if (autoClassification) {
            console.log(`📋 Auto-classified "${file.originalname}" as: ${autoClassification}`);
          }
        } catch (classErr) {
          console.error('Auto-classification error:', classErr.message);
        }
      }
      
      // Find and update the document in the proposal
      const docIndex = proposal.documents.findIndex(d => d.filename === fileDetail.filename);
      if (docIndex !== -1) {
        proposal.documents[docIndex].pages = pageCount;
        // Store full text for financial and turnover documents to extract detailed data
        // For financials: detect all components (ITR, Computation, Balance Sheet, P&L)
        // For turnover: extract GST outward supplies and tax values from GSTR-3B
        // For other documents, store truncated text to save space
        if (fileDetail.category === 'financials' || fileDetail.category === 'turnover') {
          proposal.documents[docIndex].extractedText = fullText; // Full text for financials and turnover
        } else {
          proposal.documents[docIndex].extractedText = extractedText; // Truncated for others
        }
        proposal.documents[docIndex].extractedDetails = extractedDetails;
        proposal.documents[docIndex].classification = autoClassification;
        
        // Save the updated proposal
        updateProposal(proposalId, { documents: proposal.documents });
        console.log(`✓ Updated document: ${file.originalname}`);
      }
    } catch (error) {
      console.error(`Error processing file ${file.originalname}:`, error);
    }
  }
  
  console.log(`✅ Background processing complete for proposal ${proposalId}`);
}

// Routes
app.get('/', (req, res) => {
  res.render('dashboard', { user: 'Associate' });
});

// Stage 1: Customer Proposal Form
app.get('/stage1/new', (req, res) => {
  res.render('stage1-proposal');
});

app.post('/stage1/submit', (req, res) => {
  try {
    const proposal = saveProposal(req.body);
    res.json({ success: true, proposalId: proposal.id });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// View all proposals
app.get('/proposals', (req, res) => {
  const proposals = getProposals();
  res.render('proposals-list', { proposals });
});

// Edit proposal
app.get('/proposals/:proposalId/edit', (req, res) => {
  const proposal = getProposalById(req.params.proposalId);
  if (!proposal) {
    return res.status(404).send('Proposal not found');
  }
  res.render('edit-proposal', { proposal });
});

app.post('/proposals/:proposalId/update', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const updates = req.body;
    const updatedProposal = updateProposal(proposalId, updates);
    
    if (updatedProposal) {
      res.json({ success: true, proposal: updatedProposal });
    } else {
      res.status(404).json({ success: false, error: 'Proposal not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete proposal
app.post('/proposals/:proposalId/delete', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposals = getProposals();
    const index = proposals.findIndex(p => p.id === proposalId);
    
    if (index !== -1) {
      proposals.splice(index, 1);
      fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(proposals, null, 2));
      
      // Delete uploaded files for this proposal
      const proposalDir = path.join(UPLOADS_DIR, proposalId);
      if (fs.existsSync(proposalDir)) {
        fs.rmSync(proposalDir, { recursive: true, force: true });
      }
      
      res.json({ success: true, message: 'Proposal deleted successfully' });
    } else {
      res.status(404).json({ success: false, error: 'Proposal not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 2: Document Upload & Proposal Perfection
app.get('/stage2/:proposalId', async (req, res) => {
  const proposal = getProposalById(req.params.proposalId);
  if (!proposal) {
    return res.status(404).send('Proposal not found');
  }

  // Get uploaded files from proposal data or fallback to file system
  let uploadedFiles = [];

  if (proposal.documents && proposal.documents.length > 0) {
    uploadedFiles = proposal.documents.map(doc => ({
      id: doc.id || doc.filename,
      filename: doc.filename,
      originalName: doc.originalName,
      category: doc.category || '',
      classification: doc.classification || '', // Specific document classification
      size: typeof doc.size === 'number' ? (doc.size / 1024).toFixed(2) + ' KB' : doc.size,
      pages: doc.pages, // Include page count
      uploadedAt: doc.uploadedAt,
      extractedDetails: doc.extractedDetails, // Include extracted details
      extractedText: doc.extractedText // Ensure extractedText is available for GST dashboard
    }));
  } else {
    // Fallback: read from file system
    const proposalDir = path.join(UPLOADS_DIR, req.params.proposalId);
    if (fs.existsSync(proposalDir)) {
      uploadedFiles = fs.readdirSync(proposalDir).map(filename => {
        const filePath = path.join(proposalDir, filename);
        const stats = fs.statSync(filePath);
        return {
          id: filename,
          filename: filename,
          originalName: filename.split('-').slice(2).join('-'),
          category: '',
          size: (stats.size / 1024).toFixed(2) + ' KB',
          uploadedAt: stats.mtime
        };
      });
    }
  }

  // Fetch debt profile data from MongoDB for this proposal
  let debtProfiles = [];
  try {
    debtProfiles = await DebtProfile.find({ proposalId: req.params.proposalId });
  } catch (err) {
    debtProfiles = [];
  }

  res.render('stage2-documents', {
    proposal,
    proposalId: req.params.proposalId,
    requiredDocuments: REQUIRED_DOCUMENTS,
    uploadedFiles,
    debtProfiles
  });
});

app.post('/stage2/:proposalId/upload', (req, res) => {
  upload.array('documents', 10)(req, res, async (err) => {
    if (err) {
      console.error('Multer error:', err);
      return res.status(400).json({ success: false, error: err.message || 'Upload error' });
    }
    try {
    const proposalId = req.params.proposalId;
    const files = req.files;
    
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }
    
    // Get existing proposal documents to check for duplicates
    const proposal = getProposalById(proposalId);
    const existingDocuments = proposal.documents || [];
    
    // Process files - extract zip files if any
    const allFiles = [];
    const proposalDir = path.join(UPLOADS_DIR, proposalId);
    
    for (const file of files) {
      const fileExt = path.extname(file.originalname).toLowerCase();
      
      if (fileExt === '.zip') {
        // Extract zip file
        try {
          const zip = new AdmZip(file.path);
          const zipEntries = zip.getEntries();
          
          zipEntries.forEach(entry => {
            if (!entry.isDirectory && !entry.entryName.startsWith('__MACOSX') && !entry.name.startsWith('.')) {
              // Extract file
              const extractedFileName = `${Date.now()}-${entry.name}`;
              const extractedPath = path.join(proposalDir, extractedFileName);
              
              // Write extracted file
              fs.writeFileSync(extractedPath, entry.getData());
              
              // Get file stats
              const stats = fs.statSync(extractedPath);
              
              allFiles.push({
                filename: extractedFileName,
                originalname: entry.name,
                path: extractedPath,
                size: stats.size,
                mimetype: entry.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
              });
            }
          });
          
          // Delete the zip file after extraction
          fs.unlinkSync(file.path);
        } catch (err) {
          console.error('Zip extraction error:', err);
          // If extraction fails, keep the zip file as is
          allFiles.push(file);
        }
      } else {
        // Regular file
        allFiles.push(file);
      }
    }
    
    // Check for duplicate filenames
    const duplicates = [];
    const uploadedFileNames = allFiles.map(f => f.originalname);
    
    uploadedFileNames.forEach(fileName => {
      const isDuplicate = existingDocuments.some(doc => doc.originalName === fileName);
      if (isDuplicate) {
        duplicates.push(fileName);
      }
    });
    
    if (duplicates.length > 0) {
      // Delete the uploaded files since they're duplicates
      allFiles.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
      
      return res.status(400).json({ 
        success: false, 
        error: `Duplicate files detected: ${duplicates.join(', ')}. These documents have already been uploaded.`,
        duplicates: duplicates
      });
    }
    
    // Create basic file details immediately without processing
    const fileDetails = [];
    for (const file of allFiles) {
      // Auto-categorize based on filename only (quick)
      const autoCategory = autoCategorizeDocument(file.originalname, '');
      
      fileDetails.push({
        id: file.filename,
        filename: file.filename,
        originalName: file.originalname,
        category: autoCategory,
        autoCategorized: !!autoCategory,
        size: file.size,
        pages: null,
        extractedText: '',
        extractedDetails: null,
        uploadedAt: new Date().toISOString()
      });
    }
    
    // Update proposal with document info (reuse the proposal object we already fetched)
    if (!proposal.documents) {
      proposal.documents = [];
    }
    proposal.documents.push(...fileDetails);
    updateProposal(proposalId, { documents: proposal.documents });
    
    // Send immediate response
    res.json({ success: true, files: fileDetails, message: 'Files uploaded successfully. Processing in background...' });
    
    // Process files in background (don't await)
    processFilesInBackground(allFiles, proposalId, fileDetails).catch(err => {
      console.error('Background processing error:', err);
    });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

// Delete multiple documents endpoint
app.post('/stage2/:proposalId/delete-multiple-documents', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileIds } = req.body;
    
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'File IDs array is required' });
    }
    
    // Get proposal
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || !Array.isArray(proposal.documents)) {
      return res.status(400).json({ success: false, error: 'No documents found in proposal' });
    }
    
    let deletedCount = 0;
    const errors = [];
    
    // Process each file ID
    fileIds.forEach(fileId => {
      const docIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);
      
      if (docIndex !== -1) {
        const document = proposal.documents[docIndex];
        
        // Delete physical file
        const filePath = path.join(UPLOADS_DIR, proposalId, document.filename);
        
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (err) {
            errors.push(`Failed to delete file: ${document.originalName}`);
          }
        }
        
        // Remove from proposal documents array
        proposal.documents.splice(docIndex, 1);
      } else {
        errors.push(`Document not found: ${fileId}`);
      }
    });
    
    // Update proposal
    updateProposal(proposalId, { documents: proposal.documents });
    
    if (errors.length > 0) {
      return res.json({ 
        success: true, 
        deletedCount, 
        message: `Deleted ${deletedCount} documents with ${errors.length} errors`,
        errors 
      });
    }
    
    res.json({ success: true, deletedCount, message: `Successfully deleted ${deletedCount} documents` });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete multiple documents endpoint
app.post('/stage2/:proposalId/delete-multiple-documents', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileIds } = req.body;
    
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'File IDs array is required' });
    }
    
    // Get proposal
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || !Array.isArray(proposal.documents)) {
      return res.status(400).json({ success: false, error: 'No documents found in proposal' });
    }
    
    let deletedCount = 0;
    const errors = [];
    
    // Process each file ID
    fileIds.forEach(fileId => {
      const docIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);
      
      if (docIndex !== -1) {
        const document = proposal.documents[docIndex];
        
        // Delete physical file
        const filePath = path.join(UPLOADS_DIR, proposalId, document.filename);
        
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (err) {
            errors.push(`Failed to delete file: ${document.originalName}`);
          }
        }
        
        // Remove from proposal documents array
        proposal.documents.splice(docIndex, 1);
      } else {
        errors.push(`Document not found: ${fileId}`);
      }
    });
    
    // Update proposal
    updateProposal(proposalId, { documents: proposal.documents });
    
    if (errors.length > 0) {
      return res.json({ 
        success: true, 
        deletedCount, 
        message: `Deleted ${deletedCount} documents with ${errors.length} errors`,
        errors 
      });
    }
    
    res.json({ success: true, deletedCount, message: `Successfully deleted ${deletedCount} documents` });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete document endpoint
app.post('/stage2/:proposalId/delete-document', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId } = req.body;
    
    console.log('Delete request - ProposalId:', proposalId, 'FileId:', fileId);
    
    if (!fileId) {
      return res.status(400).json({ success: false, error: 'File ID is required' });
    }
    
    // Get proposal
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    // Check if documents array exists
    if (!proposal.documents || !Array.isArray(proposal.documents)) {
      return res.status(400).json({ success: false, error: 'No documents found in proposal' });
    }
    
    console.log('Current documents:', proposal.documents.length);
    
    // Find document in proposal
    const docIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);
    
    console.log('Document index:', docIndex);
    
    if (docIndex === -1) {
      return res.status(404).json({ success: false, error: 'Document not found in proposal data' });
    }
    
    const document = proposal.documents[docIndex];
    
    // Delete physical file
    const filePath = path.join(UPLOADS_DIR, proposalId, document.filename);
    console.log('Attempting to delete file:', filePath);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('File deleted successfully');
    } else {
      console.log('File not found on disk');
    }
    
    // Remove from proposal documents array
    proposal.documents.splice(docIndex, 1);
    updateProposal(proposalId, { documents: proposal.documents });
    
    console.log('Document removed from proposal. Remaining:', proposal.documents.length);
    
    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve uploaded files
app.get('/uploads/:proposalId/:filename', (req, res) => {
  const { proposalId, filename } = req.params;
  const filepath = path.join(__dirname, 'uploads', proposalId, filename);
  
  // Check if file exists
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }
  
  // Send the file
  res.sendFile(filepath);
});

app.post('/stage2/:proposalId/categorize', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId, category } = req.body;
    
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    // Update the category of the specific file
    const fileIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);
    if (fileIndex !== -1) {
      proposal.documents[fileIndex].category = category;
      // Clear classification if category changes
      proposal.documents[fileIndex].classification = '';
      updateProposal(proposalId, { documents: proposal.documents });
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'File not found' });
    }
  } catch (error) {
    console.error('Categorize error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update document classification (specific document type within a category)
app.post('/stage2/:proposalId/classify', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId, classification } = req.body;
    
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    // Update the classification of the specific file
    const fileIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);
    if (fileIndex !== -1) {
      proposal.documents[fileIndex].classification = classification;
      updateProposal(proposalId, { documents: proposal.documents });
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'File not found' });
    }
  } catch (error) {
    console.error('Classify error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reprocess incorporation documents to extract partnership deed details
app.post('/stage2/:proposalId/reprocess-incorporation', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    let processedCount = 0;
    const proposalDir = path.join(UPLOADS_DIR, proposalId);
    const extractionResults = [];
    
    // Process each incorporation document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];
      
      if (doc.category === 'incorporation') {
        const filePath = path.join(proposalDir, doc.filename);
        
        if (fs.existsSync(filePath) && doc.originalName.toLowerCase().endsWith('.pdf')) {
          try {
            // Use table-aware extraction for reprocessing
            const pdfResult = await extractPDFWithTableDetection(filePath);
            const fullText = pdfResult.text;
            
            console.log('\n========================================');
            console.log('📄 EXTRACTING:', doc.originalName);
            console.log('========================================');
            console.log('Method:', pdfResult.method);
            console.log('Text length:', fullText.length);
            console.log('Tables found:', pdfResult.tables.length);
            console.log('\n--- EXTRACTED TEXT START ---');
            console.log(fullText);
            console.log('--- EXTRACTED TEXT END ---\n');
            
            if (pdfResult.tables && pdfResult.tables.length > 0) {
              console.log('📊 TABLES DETECTED:');
              pdfResult.tables.forEach((table, idx) => {
                console.log(`\nTable ${idx + 1}:`);
                console.log('Headers:', table.headers);
                console.log('Rows:', table.rows.length);
                console.log('Type:', table.type);
              });
              console.log('');
            }
            
            let extractedDetails;
            let rawExtraction = {
              textLength: fullText.length,
              tablesFound: pdfResult.tables.length,
              extractionMethod: pdfResult.method,
              rawText: fullText // Include raw text in response
            };

            // Check applicant type and use appropriate extraction
            if (proposal.applicantType === 'Private Limited' || proposal.applicantType === 'Public Limited') {
              // Extract shareholders and directors for Private Limited companies
              console.log('📊 Extracting Private Limited company details...');
              extractedDetails = extractPrivateLimitedDetails(fullText, pdfResult.tables || []);
              rawExtraction.method = 'Private Limited Extraction';
              rawExtraction.rawResponse = extractedDetails;
              console.log('Private Limited Extracted Data:', JSON.stringify(extractedDetails, null, 2));
            } else {
              // AI extraction DISABLED - using only regex-based extraction
              console.log('🔧 AI extraction disabled, using regex-based extraction for:', doc.originalName);
              extractedDetails = extractPartnershipDeedDetails(fullText, pdfResult.tables || []);
              console.log('Regex Extracted Data:', JSON.stringify(extractedDetails, null, 2));
              rawExtraction.method = 'Regex Pattern Matching (AI Disabled)';
              rawExtraction.rawResponse = extractedDetails;
            }
            
            console.log('\n📋 FINAL EXTRACTED DETAILS:');
            console.log(JSON.stringify(extractedDetails, null, 2));
            console.log('========================================\n');
            
            proposal.documents[i].extractedDetails = extractedDetails;
            proposal.documents[i].pages = pdfResult.numPages; // Save page count
            
            extractionResults.push({
              fileName: doc.originalName,
              ...rawExtraction,
              extractedData: extractedDetails
            });
            
            console.log('Updated extractedDetails for:', doc.originalName);
            processedCount++;
          } catch (err) {
            console.error('Error reprocessing', doc.originalName, err);
            extractionResults.push({
              fileName: doc.originalName,
              error: err.message
            });
          }
        }
      }
    }
    
    if (processedCount > 0) {
      updateProposal(proposalId, { documents: proposal.documents });
    }
    
    res.json({ 
      success: true, 
      processedCount, 
      message: `Reprocessed ${processedCount} incorporation document(s)`,
      extractionResults
    });
  } catch (error) {
    console.error('Reprocess error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reprocess banking documents to extract bank statement details
app.post('/stage2/:proposalId/reprocess-banking', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    
    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    let processedCount = 0;
    const proposalDir = path.join(UPLOADS_DIR, proposalId);
    const extractionResults = [];
    
    // Process each banking document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];
      
      if (doc.category === 'banking') {
        const filePath = path.join(proposalDir, doc.filename);
        
        if (fs.existsSync(filePath) && doc.originalName.toLowerCase().endsWith('.pdf')) {
          try {
            // Use table-aware extraction for bank statements
            const pdfResult = await extractPDFWithTableDetection(filePath);
            const fullText = pdfResult.text;
            
            console.log('\n========================================');
            console.log('🏦 EXTRACTING BANK STATEMENT:', doc.originalName);
            console.log('========================================');
            console.log('Method:', pdfResult.method);
            console.log('Text length:', fullText.length);
            console.log('Tables found:', pdfResult.tables.length);
            console.log('\n--- EXTRACTED TEXT START ---');
            console.log(fullText.substring(0, 2000));
            console.log('--- EXTRACTED TEXT END ---\n');
            
            // Try Document AI for bank statement extraction
            const aiResult = await extractWithDocumentAI(fullText, 'bank-statement', pdfResult.tables || []);
            let bankStatementDetails;
            
            if (aiResult.success && aiResult.data) {
              console.log('✓ Document AI extraction successful for:', doc.originalName);
              console.log('AI Extracted Data:', JSON.stringify(aiResult.data, null, 2));
              
              bankStatementDetails = {
                bankName: aiResult.data.bankName || 'N/A',
                accountHolder: aiResult.data.accountHolder || 'N/A',
                accountNumber: aiResult.data.accountNumber || 'N/A',
                periodFrom: aiResult.data.periodFrom || 'N/A',
                periodTo: aiResult.data.periodTo || 'N/A',
                period: (aiResult.data.periodFrom && aiResult.data.periodTo) 
                  ? `${aiResult.data.periodFrom} to ${aiResult.data.periodTo}` 
                  : 'N/A'
              };
            } else {
              console.log('⚠ Document AI failed, using fallback for:', doc.originalName);
              // Fallback pattern matching for bank statements
              bankStatementDetails = extractBankStatementDetailsFallback(fullText);
            }
            
            console.log('\n📋 FINAL EXTRACTED BANK DETAILS:');
            console.log(JSON.stringify(bankStatementDetails, null, 2));
            console.log('========================================\n');
            
            proposal.documents[i].extractedDetails = bankStatementDetails;
            proposal.documents[i].extractedText = fullText; // Save full text for EMI verification
            proposal.documents[i].pages = pdfResult.numPages;
            proposal.documents[i].extractionMethod = pdfResult.method || 'pymupdf';

            extractionResults.push({
              fileName: doc.originalName,
              textLength: fullText.length,
              method: pdfResult.method || 'pymupdf',
              ...bankStatementDetails
            });
            
            processedCount++;
          } catch (err) {
            console.error('Error processing bank statement', doc.originalName, err);
            extractionResults.push({
              fileName: doc.originalName,
              error: err.message
            });
          }
        }
      }
    }
    
    if (processedCount > 0) {
      updateProposal(proposalId, { documents: proposal.documents });
    }
    
    res.json({ 
      success: true, 
      processedCount, 
      message: `Extracted bank details from ${processedCount} statement(s)`,
      extractionResults
    });
  } catch (error) {
    console.error('Bank statement reprocess error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reprocess financial documents to extract full text for component detection
app.post('/stage2/:proposalId/reprocess-financials', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;

    const proposal = getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }

    let processedCount = 0;
    const proposalDir = path.join(UPLOADS_DIR, proposalId);
    const extractionResults = [];

    // Process each financial document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];

      if (doc.category === 'financials') {
        const filePath = path.join(proposalDir, doc.filename);

        if (fs.existsSync(filePath) && doc.originalName.toLowerCase().endsWith('.pdf')) {
          try {
            // Extract full text from PDF
            const pdfResult = await extractPDFWithTableDetection(filePath);
            const fullText = pdfResult.text;

            console.log('\n========================================');
            console.log('📊 EXTRACTING FINANCIAL DOC:', doc.originalName);
            console.log('========================================');
            console.log('Text length:', fullText.length);
            console.log('Pages:', pdfResult.numPages);

            // Check for each component with flexible keyword matching
            const textLower = fullText.toLowerCase();
            const components = {
              itrAck: textLower.includes('indian income tax return acknowledgement') ||
                      textLower.includes('itr acknowledgement') ||
                      textLower.includes('acknowledgement number'),
              computation: textLower.includes('computation of total income') ||
                          textLower.includes('computation of income') ||
                          (textLower.includes('computation') && textLower.includes('total income')),
              balanceSheet: textLower.includes('balance sheet') ||
                           textLower.includes('balancesheet'),
              profitLoss: textLower.includes('profit and loss account') ||
                         textLower.includes('profit & loss account') ||
                         textLower.includes('profit and loss a/c') ||
                         textLower.includes('trading and profit') ||
                         (textLower.includes('profit') && textLower.includes('loss') && textLower.includes('account'))
            };

            console.log('Components detected:', JSON.stringify(components));
            console.log('========================================\n');

            // Store full text and components
            proposal.documents[i].extractedText = fullText;
            proposal.documents[i].pages = pdfResult.numPages;
            proposal.documents[i].financialComponents = components;

            extractionResults.push({
              fileName: doc.originalName,
              classification: doc.classification,
              textLength: fullText.length,
              components: components
            });

            processedCount++;
          } catch (err) {
            console.error('Error processing financial doc', doc.originalName, err);
            extractionResults.push({
              fileName: doc.originalName,
              error: err.message
            });
          }
        }
      }
    }

    if (processedCount > 0) {
      updateProposal(proposalId, { documents: proposal.documents });
    }

    res.json({
      success: true,
      processedCount,
      message: `Processed ${processedCount} financial document(s)`,
      extractionResults
    });
  } catch (error) {
    console.error('Financial docs reprocess error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fallback pattern matching for bank statement details
function extractBankStatementDetailsFallback(text) {
  const result = {
    bankName: 'N/A',
    accountHolder: 'N/A',
    accountNumber: 'N/A',
    periodFrom: 'N/A',
    periodTo: 'N/A',
    period: 'N/A'
  };
  
  // Bank name patterns
  const bankPatterns = [
    /(?:HDFC|ICICI|SBI|STATE BANK|AXIS|KOTAK|PUNJAB NATIONAL|CANARA|BANK OF BARODA|INDIAN OVERSEAS|FEDERAL|BANDHAN|KARUR VYSYA|SOUTH INDIAN|KARNATAKA|UNION|CENTRAL|INDUSIND|YES|RBL|IDBI|DCB|CITY UNION|TMB|TAMILNAD MERCANTILE)\s*BANK/i,
    /Bank\s+Name[:\s]+([A-Za-z\s]+(?:Bank|BANK))/i
  ];
  
  for (const pattern of bankPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.bankName = match[0].trim();
      break;
    }
  }
  
  // Account number patterns
  const accountPatterns = [
    /(?:Account\s*(?:No|Number|#)[:\s]*|A\/c\s*No[:\s]*|Acct\s*No[:\s]*)(\d{9,18})/i,
    /(\d{9,18})/
  ];
  
  for (const pattern of accountPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.accountNumber = match[1] || match[0];
      break;
    }
  }
  
  // Account holder patterns - limit to avoid capturing address
  const holderPatterns = [
    /(?:Account\s*Holder|Customer\s*Name|Name)[:\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|Branch|A\/c|Account|\d|,|\n))/i,
    /(?:Account\s*Holder|Customer\s*Name|Name)[:\s]+([A-Z][A-Za-z\s&.]{2,50})/i,
    /(?:Mr\.|Mrs\.|Ms\.|M\/S)[.\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|\d|,|\n))/i,
    /(?:Mr\.|Mrs\.|Ms\.|M\/S)[.\s]+([A-Z][A-Za-z\s&.]{2,50})/i
  ];

  for (const pattern of holderPatterns) {
    const match = text.match(pattern);
    if (match) {
      // Clean up the account holder name - remove trailing common words
      let holder = match[1].trim();
      // Remove trailing address-related words if any slipped through
      holder = holder.replace(/\s+(Plot|Door|No|House|Flat|Building|Street|Road|Lane|Address|Branch).*$/i, '').trim();
      result.accountHolder = holder;
      break;
    }
  }
  
  // Date period patterns
  const periodPatterns = [
    /(?:Statement\s*Period|Period)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:From)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:To)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  ];
  
  for (const pattern of periodPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.periodFrom = match[1];
      result.periodTo = match[2];
      result.period = `${match[1]} to ${match[2]}`;
      break;
    }
  }
  
  return result;
}

app.post('/stage2/:proposalId/complete', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const updates = {
      currentStage: 3,
      status: 'Stage 2 - Documents Submitted',
      stage2CompletedAt: new Date().toISOString()
    };
    
    updateProposal(proposalId, updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 3: CAM (Credit Appraisal Memo)
app.get('/stage3/:proposalId', (req, res) => {
  const proposal = getProposalById(req.params.proposalId);
  if (!proposal) {
    return res.status(404).send('Proposal not found');
  }
  res.render('stage3-cam', { proposal });
});

app.post('/stage3/:proposalId/submit', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const profilingData = req.body;

    const updates = {
      currentStage: 4,
      status: 'Stage 3 - Profiling Complete',
      profiling: profilingData,
      stage3CompletedAt: new Date().toISOString()
    };

    updateProposal(proposalId, updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save P&L Sales turnover data
app.post('/stage3/:proposalId/save-turnover-data', (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fy2324, fy2425 } = req.body;

    const proposal = getProposal(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    const turnoverData = {
      fy2324: parseFloat(fy2324) || 0,
      fy2425: parseFloat(fy2425) || 0,
      updatedAt: new Date().toISOString()
    };

    updateProposal(proposalId, { turnoverData });
    res.json({ success: true, message: 'Turnover data saved successfully' });
  } catch (error) {
    console.error('Save turnover data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Customer Profiling & Banker Selection App running on port ${port}`);
});