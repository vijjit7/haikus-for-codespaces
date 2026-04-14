require('dotenv').config();
let express = require('express');
let app = express();

// IMPORTANT: JSON body parser must be before routes
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

const { execFile } = require('child_process');
const mongoose = require('mongoose');
const DebtProfile = require('./models/DebtProfile');
const BankPolicy = require('./models/BankPolicy');
const ChatImport = require('./models/ChatImport');
const BankerMatch = require('./models/BankerMatch');
const ChatMessage = require('./models/ChatMessage');
const Bank = require('./models/Bank');
const SurrogateProgram = require('./models/SurrogateProgram');
const BankerContact = require('./models/BankerContact');
const Proposal = require('./models/Proposal');
const crypto = require('crypto');
let ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const AdmZip = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { createCanvas } = require('canvas');
const axios = require('axios');
const { spawn } = require('child_process');
const FormData = require('form-data');
const xlsx = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { saveToGridFS, readFromGridFS, streamFromGridFS, deleteFromGridFS, deleteAllByProposal, existsInGridFS, withTempFile } = require('./gridfs');

// Claude Agent API Endpoint
app.post('/api/claude', (req, res) => {
  const prompt = req.body.prompt;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }
  const python = spawn('python', ['claude_agent.py'], { env: process.env });
  
  let stdout = '';
  let stderr = '';
  
  python.stdout.on('data', (data) => {
    stdout += data.toString();
  });
  
  python.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  
  python.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ success: false, error: stderr || 'Claude API error' });
    }
    res.json({ success: true, response: stdout.trim() });
  });
  
  // Send the prompt to the Python script via stdin
  python.stdin.write(JSON.stringify({ prompt }));
  python.stdin.end();
});
// Auto-start MongoDB service on Windows if not running
function ensureMongoDBRunning() {
  if (process.platform !== 'win32') return Promise.resolve();
  const { execSync } = require('child_process');
  try {
    const status = execSync('sc query MongoDB', { encoding: 'utf8' });
    if (status.includes('RUNNING')) {
      console.log('MongoDB service is already running');
      return Promise.resolve();
    }
    console.log('MongoDB service is stopped. Starting it...');
    execSync('net start MongoDB', { encoding: 'utf8' });
    console.log('MongoDB service started successfully');
  } catch (err) {
    console.log('Could not auto-start MongoDB service (may need admin rights or service not installed):', err.message);
  }
  return Promise.resolve();
}

// Connect to MongoDB
mongoose.set('bufferTimeoutMS', 30000);
const mongoUrl = process.env.MONGODB_URL || process.env.MONGO_URL || 'mongodb://localhost:27017/haikusdb';
ensureMongoDBRunning().then(() => {
  console.log('Connecting to MongoDB:', (process.env.MONGODB_URL || process.env.MONGO_URL) ? 'Using env var' : 'WARNING: Using localhost fallback - set MONGODB_URL env var for Railway');
  mongoose.connect(mongoUrl, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
  })
    .then(() => console.log('MongoDB connected successfully to:', mongoUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')))
    .catch(err => console.error('MongoDB connection FAILED:', err.message));
});

mongoose.connection.on('disconnected', () => console.log('MongoDB disconnected at', new Date().toISOString()));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected at', new Date().toISOString()));
mongoose.connection.on('error', err => console.error('MongoDB connection error:', err.message));
// Multer storage for Excel uploads (memoryStorage for GridFS)
const debtProfileStorage = multer.memoryStorage();

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
    // Skip if row is essentially empty
    const bank = getRowValue(row, 'Bank Name', 'Bank', 'Lender', 'Financial Institution', 'Financier', 'bank name', 'Name of Bank', 'Name of the Bank', 'Bank/NBFC', 'Bank / NBFC', 'Loans', 'Loan From');
    const loanAmount = getRowValue(row, 'Loan Amount', 'Amount', 'Sanctioned Amount', 'Sanction Amount', 'Disbursed Amount', 'Loan Amt', 'loan amount', 'Outstanding', 'Outstanding Amount', 'Outstanding Balance', 'Principal Outstanding', 'Balance');
    if (!bank && !loanAmount) {
      return null; // Will be filtered out below
    }
    // Get values using flexible matching
    const emiStartDate = getRowValue(row, 'EMI Start Date', 'EMI Start', 'Start Date', 'emi start date', 'First EMI Date', 'Disbursement Date', 'Disbursal Date', 'Date of Disbursement');
    const tenure = getRowValue(row, 'Tenure', 'Loan Tenure', 'Tenure (Months)', 'Tenor', 'Tenor (months)', 'tenure', 'Total Tenure', 'Tenure in Months', 'Tenure(Months)');
    const sanctionDate = getRowValue(row, 'Sanction Date', 'Date of Sanction', 'sanction date', 'Sanction Dt', 'Date of Sanction/Disbursement');

    const { monthsCompleted, percentCompleted } = calculateTenureProgress(emiStartDate, tenure);
    const emiEndDateValue = getRowValue(row, 'EMI End Date', 'EMI End', 'End Date', 'emi end date', 'Last EMI Date', 'Maturity Date', 'Maturity');
    const emiEndDate = emiEndDateValue || calculateEmiEndDate(emiStartDate, tenure);

    return {
      sNo: getRowValue(row, 'S.No', 'SNo', 'Sr.No', 'Sl.No', 's.no', 'sno', 'sl.no', 'Sr No', 'S No') || idx + 1,
      loanApplicant: getRowValue(row, 'Applicant', 'Loan Applicant', 'Borrower', 'Borrower Name', 'Name', 'applicant', 'Customer Name', 'Name of Borrower', 'Account Holder'),
      bank: bank,
      loanType: getRowValue(row, 'Loan Type', 'Type of Loan', 'Product', 'loan type', 'Nature of Loan', 'Facility', 'Facility Type', 'Type', 'Loan Category', 'Nature of Facility'),
      loanAmount: Number(String(loanAmount || 0).replace(/[^0-9.-]/g, '')) || 0,
      emi: Number(String(getRowValue(row, 'EMI', 'Monthly EMI', 'emi', 'EMI Amount', 'EMI Amt', 'Monthly Instalment', 'Instalment', 'EMI (Rs)', 'EMI(Rs.)') || 0).replace(/[^0-9.-]/g, '')) || 0,
      roi: Number(String(getRowValue(row, 'ROI', 'Rate of Interest', 'Interest Rate', 'Rate', 'roi', 'ROI (%)', 'ROI(%)', 'Interest', 'Rate (%)') || 0).replace(/[^0-9.-]/g, '')) || 0,
      sanctionDate: parseExcelDate(sanctionDate),
      tenure: parseInt(tenure) || 0,
      emiStartDate: parseExcelDate(emiStartDate),
      emiEndDate: parseExcelDate(emiEndDate),
      monthsCompleted: monthsCompleted,
      percentTenureCompleted: percentCompleted,
      proposalId: proposalId || ''
    };
  }).filter(item => item !== null);
}

// Route to upload Excel and store debt profile data
app.post('/upload-debt-profile', debtProfileUpload.single('excelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
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
  const headerKeywords = ['s.no', 'sno', 'sr.no', 'sl.no', 'applicant', 'borrower', 'bank', 'lender', 'financier', 'financial institution', 'loan', 'sanction', 'emi', 'tenure', 'tenor', 'roi', 'rate of interest', 'interest rate', 'outstanding', 'balance', 'disburs', 'repayment'];

  // Find ALL header rows (sheet may contain multiple tables)
  const headerRows = [];
  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;

    const rowText = row.map(cell => String(cell || '').toLowerCase().trim()).join(' ');
    const matchCount = headerKeywords.filter(kw => rowText.includes(kw)).length;

    // A header row needs 3+ keyword matches AND most non-empty cells must be text (not numbers)
    // This prevents data rows like [7, "yes bank", "car loan", 7200000, ...] from being detected as headers
    if (matchCount >= 3) {
      const nonEmptyCells = row.filter(cell => cell !== '' && cell !== null && cell !== undefined);
      const textCells = nonEmptyCells.filter(cell => typeof cell === 'string' && isNaN(Number(cell)));
      const textRatio = nonEmptyCells.length > 0 ? textCells.length / nonEmptyCells.length : 0;
      if (textRatio >= 0.5) {
        headerRows.push({ index: i, matchCount });
      }
    }
  }

  if (headerRows.length === 0) {
    // Fallback: use first row as header
    return xlsx.utils.sheet_to_json(sheet, { defval: '' });
  }

  // Process each table section and merge all results
  const allResults = [];
  const dataKeywords = ['loan amount', 'amount', 'sanction', 'disburs', 'outstanding', 'bank', 'financier', 'lender', 'emi', 'financial institution', 'borrower', 'applicant', 'loans'];

  for (let h = 0; h < headerRows.length; h++) {
    const headerRowIndex = headerRows[h].index;
    // Data ends at the next header row or end of file
    const nextHeaderIndex = h + 1 < headerRows.length ? headerRows[h + 1].index : rawData.length;

    // Extract headers from the header row (clean newlines/carriage returns)
    const headers = rawData[headerRowIndex].map(hdr => String(hdr || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim());

    for (let i = headerRowIndex + 1; i < nextHeaderIndex; i++) {
      const row = rawData[i];
      if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

      const obj = {};
      headers.forEach((header, idx) => {
        if (header) {
          obj[header] = row[idx] !== undefined ? row[idx] : '';
        }
      });

      const objKeys = Object.keys(obj).map(k => k.toLowerCase().trim());
      const hasData = dataKeywords.some(kw => objKeys.some(k => k.includes(kw) && obj[Object.keys(obj)[objKeys.indexOf(k)]] !== '' && obj[Object.keys(obj)[objKeys.indexOf(k)]] !== undefined));

      if (hasData) {
        allResults.push(obj);
      }
    }
  }

  return allResults;
}

// Route to extract debt profile from uploaded Excel files in the proposal
app.post('/stage2/:proposalId/extract-debt-profile', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);

    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    // Find only Excel files classified as "All Existing Loan Details" in debtProfile category
    const excelDocs = (proposal.documents || []).filter(doc =>
      doc.category === 'debtProfile' &&
      (doc.filename.endsWith('.xlsx') || doc.filename.endsWith('.xls')) &&
      (doc.classification === 'All Existing Loan Details' || doc.classification === 'Loan Details')
    );

    // Fallback: if no classified Excel files, try any Excel in debtProfile
    if (excelDocs.length === 0) {
      const anyExcel = (proposal.documents || []).filter(doc =>
        doc.category === 'debtProfile' &&
        (doc.filename.endsWith('.xlsx') || doc.filename.endsWith('.xls'))
      );
      if (anyExcel.length > 0) excelDocs.push(...anyExcel);
    }

    const ocrDocs = []; // Only extract from Excel files

    if (excelDocs.length === 0) {
      return res.status(400).json({ success: false, message: 'No "All Existing Loan Details" Excel file found in Debt Profile category. Please upload and classify the loan details Excel file.' });
    }

    let allDebtProfiles = [];

    // Process Excel files — try all sheets to find loan data
    for (const doc of excelDocs) {
      const fileExists = await existsInGridFS(doc.filename);
      if (fileExists) {
        try {
          const fileBuffer = await readFromGridFS(doc.filename);
          const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
          console.log('\n========================================');
          console.log('📊 PROCESSING EXCEL FILE:', doc.originalName || doc.filename);
          console.log('Available sheets:', workbook.SheetNames.join(', '));

          let bestSheetData = [];
          let bestSheetName = '';

          // Try each sheet and pick the one that yields the most debt profiles
          for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            console.log(`\n  Trying sheet: "${sheetName}"`);

            const data = findHeaderRowAndParseExcel(sheet);
            console.log(`  Rows found: ${data.length}`);
            if (data.length > 0) {
              console.log('  Column headers:', Object.keys(data[0]));
            }

            const mappedData = processDebtProfileData(data, proposalId);
            console.log(`  Mapped debt profiles: ${mappedData.length}`);

            if (mappedData.length > bestSheetData.length) {
              bestSheetData = mappedData;
              bestSheetName = sheetName;
            }
          }

          if (bestSheetData.length > 0) {
            console.log(`\n  ✓ Best sheet: "${bestSheetName}" with ${bestSheetData.length} records`);
            allDebtProfiles = allDebtProfiles.concat(bestSheetData);
          } else {
            console.log('  ✗ No debt profile data found in any sheet');
            // Log first sheet raw data for debugging
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = xlsx.utils.sheet_to_json(firstSheet, { defval: '', header: 1 });
            if (rawData.length > 0) {
              console.log('  First 5 raw rows of first sheet:');
              rawData.slice(0, 5).forEach((row, i) => console.log(`  Row ${i}:`, row));
            }
          }
          console.log('========================================\n');
        } catch (excelErr) {
          console.error(`Error reading Excel file ${doc.filename}:`, excelErr);
        }
      }
    }

    // Process OCR'd image/PDF files using AI extraction
    for (const doc of ocrDocs) {
      try {
        console.log('\n========================================');
        console.log('📊 PROCESSING OCR DEBT PROFILE:', doc.originalName || doc.filename);
        console.log('Text length:', doc.extractedText.length);
        console.log('========================================');

        // Clean up extracted text (remove markdown code blocks from Vision OCR)
        let ocrText = doc.extractedText.replace(/```(?:text|json)?\n?/g, '').replace(/```/g, '').trim();

        const aiResult = await extractWithDocumentAI(ocrText, 'debt-profile', []);
        if (aiResult.success && aiResult.data && Array.isArray(aiResult.data.loans)) {
          const loans = aiResult.data.loans;
          console.log('AI extracted', loans.length, 'loan records');

          loans.forEach((loan, idx) => {
            const emiStartDate = loan.emiStartDate || '';
            const tenure = parseInt(loan.tenure) || 0;
            const { monthsCompleted, percentCompleted } = calculateTenureProgress(emiStartDate, tenure);

            allDebtProfiles.push({
              sNo: loan.sNo || idx + 1,
              loanApplicant: loan.applicant || '',
              bank: loan.bank || '',
              loanType: loan.loanType || '',
              loanAmount: Number(String(loan.loanAmount || 0).replace(/[^0-9.-]/g, '')) || 0,
              emi: Number(String(loan.emi || 0).replace(/[^0-9.-]/g, '')) || 0,
              roi: Number(String(loan.roi || 0).replace(/[^0-9.-]/g, '')) || 0,
              sanctionDate: loan.sanctionDate || '',
              tenure: tenure,
              emiStartDate: emiStartDate,
              emiEndDate: loan.emiEndDate || calculateEmiEndDate(emiStartDate, tenure),
              monthsCompleted: monthsCompleted,
              percentTenureCompleted: percentCompleted,
              proposalId: proposalId
            });
          });
        } else {
          console.log('AI extraction failed, attempting manual text parsing...');
          // Fallback: parse tabular text manually
          const lines = ocrText.split('\n').filter(l => l.trim());
          // Skip header line(s), look for numbered rows
          for (const line of lines) {
            const match = line.match(/^\s*(\d+)\s+(.+)/);
            if (match) {
              const parts = match[2].split(/\s{2,}|\t/);
              if (parts.length >= 3) {
                const applicant = parts[0] || '';
                const bank = parts[1] || '';
                const loanType = parts[2] || '';
                const amounts = match[2].match(/[\d,]+(?:\.\d+)?/g) || [];
                const numAmounts = amounts.map(a => parseFloat(a.replace(/,/g, ''))).filter(n => !isNaN(n));

                allDebtProfiles.push({
                  sNo: parseInt(match[1]),
                  loanApplicant: applicant.trim(),
                  bank: bank.trim(),
                  loanType: loanType.trim(),
                  loanAmount: numAmounts[0] || 0,
                  emi: numAmounts.length > 1 ? numAmounts[1] : 0,
                  roi: numAmounts.find(n => n > 0 && n < 30) || 0,
                  tenure: 0,
                  proposalId: proposalId
                });
              }
            }
          }
        }
      } catch (ocrErr) {
        console.error('Error processing OCR debt profile:', doc.originalName, ocrErr.message);
      }
    }

    if (allDebtProfiles.length === 0) {
      return res.status(400).json({ success: false, message: 'No data could be extracted from debt profile files' });
    }

    // Deduplicate by bank+loanAmount+loanType+loanApplicant+emi (same loan appearing in multiple table sections)
    const seen = new Set();
    const uniqueProfiles = allDebtProfiles.filter(p => {
      const key = (p.bank || '').toLowerCase().trim() + '|' + p.loanAmount + '|' + (p.loanType || '').toLowerCase().trim() + '|' + (p.loanApplicant || '').toLowerCase().trim() + '|' + p.emi;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Re-number serial numbers
    uniqueProfiles.forEach((p, i) => { p.sNo = i + 1; });
    console.log(`Debt profiles: ${allDebtProfiles.length} total, ${uniqueProfiles.length} after dedup`);

    // Remove previous debt profiles for this proposal and insert new
    await DebtProfile.deleteMany({ proposalId: proposalId });
    await DebtProfile.insertMany(uniqueProfiles);

    res.json({ success: true, message: `Extracted ${uniqueProfiles.length} loan records`, count: uniqueProfiles.length });
  } catch (err) {
    console.error('Error extracting debt profile:', err);
    res.status(500).json({ success: false, message: 'Error processing debt profile' });
  }
});

// Route to clear all debt profiles for a proposal
app.post('/stage2/:proposalId/clear-debt-profiles', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const result = await DebtProfile.deleteMany({ proposalId: proposalId });
    console.log(`Cleared ${result.deletedCount} debt profiles for proposal ${proposalId}`);
    res.json({ success: true, message: `Cleared ${result.deletedCount} debt profile entries` });
  } catch (err) {
    console.error('Error clearing debt profiles:', err);
    res.status(500).json({ success: false, message: 'Error clearing debt profiles' });
  }
});

// Route to extract other income (rental) details from uploaded files
app.post('/stage2/:proposalId/extract-other-income', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);

    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    // Find all files in otherIncome category
    const otherIncomeDocs = (proposal.documents || []).filter(doc =>
      doc.category === 'otherIncome'
    );

    if (otherIncomeDocs.length === 0) {
      return res.status(400).json({ success: false, message: 'No other income files found. Upload documents and categorize as "Other Income".' });
    }

    let allRentals = [];

    for (const doc of otherIncomeDocs) {
      try {
        const fileExists = await existsInGridFS(doc.filename);
        if (!fileExists) {
          console.log('File not found in GridFS, skipping:', doc.filename);
          continue;
        }

        console.log('\n========================================');
        console.log('💵 PROCESSING OTHER INCOME:', doc.originalName || doc.filename);
        console.log('========================================');

        let fullText = '';
        const ext = path.extname(doc.filename).toLowerCase();
        const fileBuffer = await readFromGridFS(doc.filename);

        // Re-OCR images directly from file (stored text may be truncated)
        if (['.jpg', '.jpeg', '.png'].includes(ext)) {
          console.log('🖼️ Running OCR on image:', doc.originalName);
          let ocrResult;
          await withTempFile(fileBuffer, doc.filename, async (tempPath) => {
            ocrResult = await extractTextFromImage(tempPath);
          });
          if (ocrResult && ocrResult.success && ocrResult.text) {
            fullText = ocrResult.text;
            console.log(`✓ OCR extracted ${ocrResult.charCount} characters`);
            // Update stored text with full version
            const latestProposal = await getProposalById(proposalId);
            const docIdx = latestProposal.documents.findIndex(d => d.filename === doc.filename);
            if (docIdx !== -1) {
              latestProposal.documents[docIdx].extractedText = fullText;
              await updateProposal(proposalId, { documents: latestProposal.documents });
            }
          } else {
            console.log('OCR failed for:', doc.originalName, ocrResult ? ocrResult.error : 'unknown');
            continue;
          }
        }
        // Re-extract PDFs directly from file
        else if (ext === '.pdf') {
          console.log('📄 Extracting text from PDF:', doc.originalName);
          await withTempFile(fileBuffer, doc.filename, async (tempPath) => {
            const pdfResult = await extractPDFWithTableDetection(tempPath, false);
            fullText = pdfResult.text || '';

            // Vision OCR fallback for scanned PDFs
            if (!fullText || fullText.trim().length < 200) {
              console.log('Short/empty text, trying Vision OCR...');
              try {
                const ocrResult = await extractAllPagesWithVisionOCR(tempPath);
                if (ocrResult.success && ocrResult.text) {
                  fullText = fullText ? fullText + '\n\n' + ocrResult.text : ocrResult.text;
                  console.log(`✓ Vision OCR extracted ${ocrResult.text.length} characters`);
                }
              } catch (ocrErr) {
                console.error('Vision OCR error:', ocrErr.message);
              }
            }
          });

          if (!fullText || fullText.trim().length < 50) {
            console.log('Insufficient text from PDF, skipping:', doc.originalName);
            continue;
          }

          // Update stored text with full version
          const latestProposal = await getProposalById(proposalId);
          const docIdx = latestProposal.documents.findIndex(d => d.filename === doc.filename);
          if (docIdx !== -1) {
            latestProposal.documents[docIdx].extractedText = fullText;
            await updateProposal(proposalId, { documents: latestProposal.documents });
          }
        }
        // Use stored text as fallback
        else if (doc.extractedText && doc.extractedText.trim().length > 50) {
          fullText = doc.extractedText;
        } else {
          console.log('No text available for:', doc.originalName);
          continue;
        }

        console.log('Text length:', fullText.length);
        let ocrText = fullText.replace(/```(?:text|json|markdown)?\n?/g, '').replace(/```/g, '').trim();

        const aiResult = await extractWithDocumentAI(ocrText, 'other-income', []);
        if (aiResult.success && aiResult.data && Array.isArray(aiResult.data.rentals)) {
          const rentals = aiResult.data.rentals;
          console.log('AI extracted', rentals.length, 'rental records from', doc.originalName);

          rentals.forEach((rental, idx) => {
            allRentals.push({
              sNo: rental.sNo || idx + 1,
              ownerName: rental.ownerName || '',
              tenant: rental.tenant || '',
              propertyAddress: rental.propertyAddress || '',
              monthlyRent: Number(String(rental.monthlyRent || 0).replace(/[^0-9.-]/g, '')) || 0,
              rentPeriod: rental.rentPeriod || '',
              rentStartDate: rental.rentStartDate || '',
              escalation: rental.escalation || '',
              tdsDeducted: rental.tdsDeducted || '',
              gstApplicable: rental.gstApplicable || '',
              sourceFile: doc.originalName || doc.filename
            });
          });
        } else {
          console.log('AI extraction returned no rental data for:', doc.originalName);
        }
      } catch (docErr) {
        console.error('Error processing other income doc:', doc.originalName, docErr.message);
      }
    }

    if (allRentals.length === 0) {
      return res.status(400).json({ success: false, message: 'No rental/income data could be extracted from the uploaded files' });
    }

    // Save to proposal
    const totalMonthlyRent = allRentals.reduce((sum, r) => sum + (r.monthlyRent || 0), 0);
    await updateProposal(proposalId, {
      otherIncomeDetails: {
        rentals: allRentals,
        totalMonthlyRent: totalMonthlyRent,
        totalAnnualRent: totalMonthlyRent * 12,
        extractedAt: new Date().toISOString()
      }
    });

    res.json({ success: true, message: `Extracted ${allRentals.length} rental record(s)`, count: allRentals.length });
  } catch (err) {
    console.error('Error extracting other income:', err);
    res.status(500).json({ success: false, message: 'Error processing other income documents' });
  }
});

// Route to re-extract turnover (GST) documents with full text for analysis
app.post('/stage2/:proposalId/extract-turnover', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);

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

      const fileExists = await existsInGridFS(doc.filename);
      if (fileExists) {
        try {
          const fileBuffer = await readFromGridFS(doc.filename);
          await withTempFile(fileBuffer, doc.filename, async (filePath) => {
            const pdfResult = await extractPDFWithTableDetection(filePath);
            proposal.documents[i].extractedText = pdfResult.text; // Full text
            proposal.documents[i].pages = pdfResult.numPages;
            extractedCount++;
            console.log(`✓ Re-extracted turnover document: ${doc.originalName} (${pdfResult.text.length} chars)`);
          });
        } catch (pdfErr) {
          console.error(`Error extracting PDF ${doc.filename}:`, pdfErr);
        }
      }
    }

    if (extractedCount > 0) {
      await updateProposal(proposalId, { documents: proposal.documents });
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
const GEMINI_API_KEY = 'AIzaSyARiov95XN7RdyNWoOebWCVeWN6uGB3e6g';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';

// Middleware
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Configure multer for file uploads (memoryStorage for GridFS)
const UPLOADS_DIR = path.join(__dirname, 'uploads'); // kept for migration only
const storage = multer.memoryStorage();

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /pdf|doc|docx|jpg|jpeg|png|xls|xlsx|zip|rar/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

    // Allow if extension matches
    if (extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only documents, images, zip and rar files are allowed!'));
    }
  },
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit
});

// Data storage paths
const DATA_DIR = path.join(__dirname, 'data');
const BANKERS_FILE = path.join(DATA_DIR, 'bankers.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Initialize data files if they don't exist
if (!fs.existsSync(BANKERS_FILE)) {
  fs.writeFileSync(BANKERS_FILE, JSON.stringify([], null, 2));
}

// Helper functions to read/write data (MongoDB-backed)
async function getProposals() {
  return await Proposal.find({}).lean();
}

async function getProposalById(proposalId) {
  return await Proposal.findOne({ id: proposalId }).lean();
}

async function saveProposal(proposal) {
  proposal.id = Date.now().toString();
  proposal.createdAt = new Date().toISOString();
  proposal.status = 'Stage 1 - Proposal Submitted';
  proposal.currentStage = 1;
  console.log('Saving proposal with id:', proposal.id, 'applicant:', proposal.applicantName);
  const doc = new Proposal(proposal);
  await doc.save();
  console.log('Proposal saved to MongoDB successfully');
  return doc.toObject();
}

async function updateProposal(proposalId, updates) {
  const updated = await Proposal.findOneAndUpdate(
    { id: proposalId },
    { $set: updates },
    { new: true }
  ).lean();
  return updated;
}

// ========== STAGE 4: WhatsApp Chat Parser + Banker Matching ==========

// Multer config for policy file uploads (memoryStorage for GridFS)
const policyUploadStorage = multer.memoryStorage();
const ALLOWED_POLICY_EXTS = ['.txt', '.pdf', '.jpg', '.jpeg', '.png'];
const policyUpload = multer({
  storage: policyUploadStorage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_POLICY_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .pdf, .jpg, .jpeg, .png files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// WhatsApp message regex patterns (Android & iOS, multiple date/time formats)
const WA_PATTERNS = [
  // DD/MM/YYYY, HH:MM - Sender: Message (Android 24h)
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*([^:]+):\s*([\s\S]*)$/,
  // DD/MM/YYYY, HH:MM am/pm - Sender: Message (Android 12h)
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[apAP][mM])\s*-\s*([^:]+):\s*([\s\S]*)$/,
  // [DD/MM/YYYY, HH:MM:SS] Sender: Message (iOS)
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[apAP][mM])?)\]\s*([^:]+):\s*([\s\S]*)$/,
  // MM/DD/YYYY format variants
  /^(\d{1,2}-\d{1,2}-\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[apAP][mM])?)\s*-\s*([^:]+):\s*([\s\S]*)$/
];

// Parse a single WhatsApp chat line, returns { date, time, sender, text } or null
function parseWhatsAppLine(line) {
  for (const pattern of WA_PATTERNS) {
    const match = line.match(pattern);
    if (match) {
      return {
        date: match[1].trim(),
        time: match[2].trim(),
        sender: match[3].trim(),
        text: match[4].trim()
      };
    }
  }
  return null;
}

// Detect date format from first 100 lines (DD/MM vs MM/DD)
function detectDateFormat(lines) {
  let ddmmCount = 0;
  let mmddCount = 0;
  const checked = Math.min(lines.length, 100);
  for (let i = 0; i < checked; i++) {
    const parsed = parseWhatsAppLine(lines[i]);
    if (parsed) {
      const parts = parsed.date.split(/[\/\-]/);
      if (parts.length >= 2) {
        const first = parseInt(parts[0]);
        const second = parseInt(parts[1]);
        if (first > 12) ddmmCount++;
        else if (second > 12) mmddCount++;
      }
    }
  }
  return ddmmCount >= mmddCount ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
}

// Parse date string based on detected format
function parseChatDate(dateStr, format) {
  const parts = dateStr.split(/[\/\-]/);
  if (parts.length < 3) return null;
  let day, month, year;
  if (format === 'DD/MM/YYYY') {
    day = parseInt(parts[0]);
    month = parseInt(parts[1]) - 1;
    year = parseInt(parts[2]);
  } else {
    month = parseInt(parts[0]) - 1;
    day = parseInt(parts[1]);
    year = parseInt(parts[2]);
  }
  if (year < 100) year += 2000;
  const d = new Date(year, month, day);
  return isNaN(d.getTime()) ? null : d;
}

// Full chat parser: returns array of { date, time, sender, text, parsedDate }
function parseWhatsAppChat(fileContent) {
  const lines = fileContent.split(/\r?\n/);
  const format = detectDateFormat(lines);
  const messages = [];
  let current = null;

  for (const line of lines) {
    const parsed = parseWhatsAppLine(line);
    if (parsed) {
      if (current) messages.push(current);
      current = {
        ...parsed,
        parsedDate: parseChatDate(parsed.date, format)
      };
    } else if (current) {
      // Multi-line message continuation
      current.text += '\n' + line;
    }
  }
  if (current) messages.push(current);

  return { messages, format, lineCount: lines.length };
}

// Policy-relevance scoring: keyword-based filter to skip casual chat
function scorePolicyRelevance(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const keywords = {
    high: ['roi', 'rate of interest', 'interest rate', 'ltv', 'loan to value', 'cibil', 'credit score',
           'processing fee', 'tenure', 'collateral', 'mortgage', 'home loan', 'business loan',
           'lap', 'bt', 'balance transfer', 'top up', 'loan against property'],
    medium: ['lakh', 'lakhs', 'crore', 'cr', '%', 'percent', 'secured', 'unsecured',
             'prime', 'affordable', 'micro', 'salaried', 'self employed', 'senp', 'sep',
             'sme', 'msme', 'nbfc', 'bank', 'housing finance', 'pf ', 'hfc'],
    low: ['emi', 'sanction', 'disburse', 'eligibility', 'apply', 'scheme', 'offer',
          'product', 'policy', 'norms', 'criteria', 'maximum', 'minimum', 'upto']
  };

  for (const kw of keywords.high) { if (lower.includes(kw)) score += 3; }
  for (const kw of keywords.medium) { if (lower.includes(kw)) score += 2; }
  for (const kw of keywords.low) { if (lower.includes(kw)) score += 1; }

  // Boost if has numbers with L/Cr/% patterns
  if (/\d+\s*(?:l|lakh|lakhs|lac)\b/i.test(text)) score += 3;
  if (/\d+\s*(?:cr|crore|crores)\b/i.test(text)) score += 3;
  if (/\d+\.?\d*\s*%/.test(text)) score += 3;

  return score;
}

// Known banks/NBFCs/HFCs with type classification
const KNOWN_BANKS_MAP = {
  // Public Sector Banks
  'SBI': 'Bank', 'State Bank': 'Bank', 'HDFC Bank': 'Bank', 'HDFC': 'Bank', 'ICICI Bank': 'Bank', 'ICICI': 'Bank', 'Axis Bank': 'Bank', 'Axis Finance': 'NBFC', 'Axis': 'Bank', 'Kotak Mahindra': 'Bank', 'Kotak': 'Bank',
  'Bank of Baroda': 'Bank', 'BOB': 'Bank', 'PNB': 'Bank', 'Punjab National': 'Bank',
  'Canara': 'Bank', 'Union Bank': 'Bank', 'Indian Bank': 'Bank', 'Bank of India': 'Bank', 'BOI': 'Bank',
  'Central Bank': 'Bank', 'UCO Bank': 'Bank', 'Indian Overseas': 'Bank', 'IOB': 'Bank',
  'IDBI': 'Bank', 'Yes Bank': 'Bank', 'IndusInd': 'Bank',
  'Standard Chartered': 'Bank', 'Standard Charterd': 'Bank', 'SCB': 'Bank', 'StanChart': 'Bank',
  'Citibank': 'Bank', 'Citi Bank': 'Bank', 'DBS Bank': 'Bank', 'DBS': 'Bank', 'HSBC': 'Bank',
  'Deutsche Bank': 'Bank', 'Barclays': 'Bank',
  // Private / Small Finance Banks
  'Federal Bank': 'Bank', 'South Indian Bank': 'Bank', 'Karur Vysya': 'Bank', 'KVB': 'Bank',
  'City Union Bank': 'Bank', 'CUB': 'Bank', 'Bandhan Bank': 'Bank', 'RBL Bank': 'Bank',
  'IDFC First': 'Bank', 'AU Small Finance': 'Bank', 'Ujjivan': 'Bank', 'Jana Small Finance': 'Bank', 'Jana SFB': 'Bank',
  'Jio Credit': 'NBFC', 'Jio Finance': 'NBFC',
  // NBFCs
  'Bajaj Finance': 'NBFC', 'Bajaj Finserv': 'NBFC', 'Tata Capital': 'NBFC', 'L&T Finance': 'NBFC',
  'Mahindra Finance': 'NBFC', 'Piramal': 'NBFC', 'Muthoot Fincorp': 'NBFC', 'Muthoot': 'NBFC', 'Manappuram': 'NBFC',
  'Shriram': 'NBFC', 'Cholamandalam': 'NBFC', 'Chola': 'NBFC', 'IIFL': 'NBFC', 'Fullerton': 'NBFC',
  'Hero FinCorp': 'NBFC', 'Aditya Birla': 'NBFC', 'ABFL': 'NBFC', 'Sundaram': 'NBFC',
  'JM Financial': 'NBFC', 'Capri Global Housing Finance': 'HFC', 'Capri Global': 'NBFC',
  // HFCs (Housing Finance Companies)
  'LIC HFL': 'HFC', 'LIC Housing': 'HFC', 'PNB Housing': 'HFC', 'HDFC Home': 'HFC',
  'Godrej Housing': 'HFC', 'Reliance Home': 'HFC', 'GIC Housing': 'HFC',
  'Can Fin Homes': 'HFC', 'Repco Home': 'HFC', 'Aavas': 'HFC',
  'Home First': 'HFC', 'Aptus': 'HFC', 'Star HFC': 'HFC', 'Sammaan Capital': 'HFC',
  'Shubham Housing Finance': 'HFC', 'Shubham Housing': 'HFC', 'Shubham': 'HFC',
  // Additional NBFCs
  'Credit Saison': 'NBFC', 'Fedbank Financial': 'NBFC', 'Fedfina': 'NBFC',
  'Hinduja Housing': 'HFC', 'Hinduja Leyland': 'NBFC',
  'Incred Financial': 'NBFC', 'InCred': 'NBFC',
  'Kogta Financial': 'NBFC', 'Mirae Asset': 'NBFC',
  'DMI Finance': 'NBFC', 'DMI Housing': 'HFC',
  'Northern Arc': 'NBFC', 'Profectus Capital': 'NBFC',
  'Anand Rathi': 'NBFC', 'Ugro Capital': 'NBFC',
  'Vastu Housing': 'HFC', 'Vistaar Finance': 'NBFC',
  'Clix Capital': 'NBFC', 'Clix Housing': 'HFC',
  'Poonawalla Fincorp': 'NBFC', 'Poonawala Fincorp': 'NBFC', 'Poonawalla': 'NBFC',
  'DCB Bank': 'Bank', 'DCB': 'Bank',
  'Vridhi Home Finance': 'HFC', 'Vridhi': 'HFC',
  'Truhome Finance': 'HFC', 'Truhome': 'HFC',
  'Unity Small Finance': 'Bank', 'Unity SFB': 'Bank'
};
// Backward-compatible array (sorted longest-first so "Axis Bank" matches before "Axis")
const KNOWN_BANKS = Object.keys(KNOWN_BANKS_MAP).sort((a, b) => b.length - a.length);

// ========== NEW UTILITY FUNCTIONS ==========

// Normalize text content for hashing (Level 1 dedup)
function normalizeContent(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

// SHA256 hash for message dedup
function computeContentHash(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Extract phone number from WhatsApp sender field
function extractSenderNumber(sender) {
  if (!sender) return '';
  const phoneMatch = sender.match(/\+?\d[\d\s-]{8,}/);
  return phoneMatch ? phoneMatch[0].replace(/[\s-]/g, '') : sender;
}

// Classify message type
function detectMessageType(msg) {
  const text = msg.text || '';
  if (/\<Media omitted\>|image omitted|video omitted|audio omitted|sticker omitted/i.test(text)) return 'image';
  if (/\.pdf|\.doc|\.xlsx|\.xls|document omitted/i.test(text)) return 'file';
  if (/this message was deleted|you deleted this message/i.test(text)) return 'deleted';
  if (/added|removed|left|changed the subject|changed this group/i.test(text) && !msg.sender) return 'group_event';
  return 'text';
}

// Detect group event subtype
function detectGroupEventType(text) {
  if (!text) return '';
  if (/added/i.test(text)) return 'added_member';
  if (/removed|left/i.test(text)) return 'removed_member';
  if (/changed the subject|changed this group|changed the group/i.test(text)) return 'name_change';
  return '';
}

// Jaccard similarity for Level 2 fuzzy message dedup
function computeTextSimilarity(a, b) {
  const wordsA = new Set((a || '').toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set((b || '').toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// Normalize common bank name misspellings/abbreviations
const BANK_NAME_NORMALIZE = {
  'standard charterd': 'Standard Chartered Bank',
  'standard charted': 'Standard Chartered Bank',
  'scb': 'Standard Chartered Bank',
  'stanchart': 'Standard Chartered Bank',
  'bob': 'Bank of Baroda',
  'boi': 'Bank of India',
  'iob': 'Indian Overseas Bank',
  'kvb': 'Karur Vysya Bank',
  'cub': 'City Union Bank',
  'abfl': 'Aditya Birla Finance',
  'chola': 'Cholamandalam',
  'credit saison': 'Credit Saison India',
  'fedfina': 'Fedbank Financial',
  'incred': 'InCred Financial',
  'jana sfb': 'Jana Small Finance Bank',
  'jana small finance': 'Jana Small Finance Bank',
  'jio credit': 'Jio Credit',
  'jio finance': 'Jio Finance',
  'axis finance': 'Axis Finance Ltd',
  'axis finance ltd': 'Axis Finance Ltd',
};

// Find or create Bank entity
async function findOrCreateBank(bankName, sender, date) {
  if (!bankName) return null;
  // Normalize misspellings
  const normalizedName = BANK_NAME_NORMALIZE[bankName.toLowerCase().trim()] || bankName;
  bankName = normalizedName;
  const bankKey = bankName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const bankType = determineBankType(bankName);

  try {
    const bank = await Bank.findOneAndUpdate(
      { bank_key: bankKey },
      {
        $set: {
          bank_name: bankName,
          bank_key: bankKey,
          bank_type: bankType,
          last_seen_date: date || new Date()
        },
        $setOnInsert: {
          first_seen_date: date || new Date(),
          contact_person: sender || ''
        }
      },
      { upsert: true, new: true }
    );
    return bank;
  } catch (err) {
    // Handle duplicate key race condition
    if (err.code === 11000) {
      return await Bank.findOne({ bank_key: bankKey });
    }
    console.error('findOrCreateBank error:', err.message);
    return null;
  }
}

// Determine bank type from KNOWN_BANKS_MAP
function determineBankType(bankName) {
  if (!bankName) return 'Bank';
  for (const [name, type] of Object.entries(KNOWN_BANKS_MAP)) {
    if (bankName.toLowerCase().includes(name.toLowerCase())) return type;
  }
  // Heuristic fallback
  const lower = bankName.toLowerCase();
  if (/\bhfc\b|housing\s*finance|home\s*finance/i.test(lower)) return 'HFC';
  if (/\bnbfc\b|finance\b|finserv|capital\b|fincorp/i.test(lower)) return 'NBFC';
  return 'Bank';
}

// Map free-text loan type to product_type enum
function mapToProductType(loanType) {
  if (!loanType) return '';
  const lower = loanType.toLowerCase();
  if (/home\s*loan|\bhl\b|housing\s*loan/i.test(lower)) return 'HL';
  if (/\blap\b|loan\s*against\s*propert|mortgage\s*loan/i.test(lower)) return 'LAP';
  if (/\blrd\b|lease\s*rental|rent\s*discounting/i.test(lower)) return 'LRD';
  if (/balance\s*transfer|\bbt\b|top\s*up|topup/i.test(lower)) return 'BT_TopUp';
  if (/commercial\s*purchase|commercial\s*property/i.test(lower)) return 'Commercial_Purchase';
  return 'Other';
}

// Generate human-readable policy label
function generatePolicyLabel(policy) {
  const parts = [
    (policy.bank_name || 'Unknown').toLowerCase().replace(/\s+/g, '-'),
    (policy.loan_type || policy.product_type || 'loan').toLowerCase().replace(/\s+/g, '-'),
    (policy.department || '').toLowerCase()
  ].filter(Boolean);

  if (policy.loan_min_lakhs) parts.push(policy.loan_min_lakhs + 'L');
  if (policy.loan_max_lakhs) parts.push(policy.loan_max_lakhs >= 100 ? (policy.loan_max_lakhs / 100) + 'Cr' : policy.loan_max_lakhs + 'L');
  if (policy.roi_min_pct) parts.push(policy.roi_min_pct + '%');
  if (policy.ltv_pct) parts.push(policy.ltv_pct + 'LTV');

  return parts.join('-');
}

// Extract surrogate programs from message text
function extractSurrogatePrograms(text) {
  const programs = [];
  const lower = text.toLowerCase();

  // Banking Surrogate / ABB-based
  const abbMatch = text.match(/(?:banking\s*surrogate|abb\s*(?:based|program|surrogate))[^.]*?(\d+(?:\.\d+)?)\s*(?:x|times|multiplier)/i);
  if (abbMatch || /banking\s*surrogate/i.test(text)) {
    programs.push({
      program_type: 'Banking_Surrogate',
      abb_multiplier: abbMatch ? parseFloat(abbMatch[1]) : null,
      program_details: text.substring(0, 500)
    });
  }

  // GST-based
  if (/\bgst\s*(?:based|surrogate|program|turnover)\b/i.test(text)) {
    const gstLimit = text.match(/gst[^.]*?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|cr|crore)/i);
    programs.push({
      program_type: 'GST',
      program_loan_limit_lakhs: gstLimit ? parseFloat(gstLimit[1]) * (/cr|crore/i.test(gstLimit[0]) ? 100 : 1) : null,
      program_details: text.substring(0, 500)
    });
  }

  // Gross Turnover
  if (/gross\s*turnover|turnover\s*(?:based|program)/i.test(text) && !/gst/i.test(text)) {
    programs.push({
      program_type: 'Gross_Turnover',
      program_details: text.substring(0, 500)
    });
  }

  // LIP (Life Insurance Policy)
  if (/\blip\b|life\s*insurance\s*(?:policy|based|surrogate)/i.test(text)) {
    programs.push({
      program_type: 'LIP',
      program_details: text.substring(0, 500)
    });
  }

  // Low LTV
  if (/low\s*ltv|ltv\s*(?:based|surrogate)|ltv\s*(?:below|under|less)\s*\d+/i.test(text)) {
    const ltvMatch = text.match(/ltv[^.]*?(\d+(?:\.\d+)?)\s*%/i);
    programs.push({
      program_type: 'Low_LTV',
      margin_pct: ltvMatch ? parseFloat(ltvMatch[1]) : null,
      program_details: text.substring(0, 500)
    });
  }

  // Extract common fields
  programs.forEach(p => {
    // DSRA months
    const dsraMatch = text.match(/dsra[^.]*?(\d+)\s*months?/i);
    if (dsraMatch) p.dsra_months = parseInt(dsraMatch[1]);

    // Margin
    const marginMatch = text.match(/margin[^.]*?(\d+(?:\.\d+)?)\s*%/i);
    if (marginMatch && !p.margin_pct) p.margin_pct = parseFloat(marginMatch[1]);

    // Loan limit
    const limitMatch = text.match(/(?:limit|upto|up\s*to|max)[^.]*?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|cr|crore)/i);
    if (limitMatch && !p.program_loan_limit_lakhs) {
      p.program_loan_limit_lakhs = parseFloat(limitMatch[1]) * (/cr|crore/i.test(limitMatch[0]) ? 100 : 1);
    }
  });

  return programs;
}

// Generate dedup signature for surrogate programs
function generateProgramSignature(program, bankName, programType) {
  const normalized = [
    (bankName || '').toLowerCase().trim(),
    (programType || '').toLowerCase().trim(),
    program.program_loan_limit_lakhs || 0,
    program.abb_multiplier || 0,
    program.margin_pct || 0,
    program.dsra_months || 0
  ].join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ========== END NEW UTILITY FUNCTIONS ==========

// Regex-based policy extraction (Phase 1 - fast, no API cost)
// Returns an array of policies (may split multi-product messages into separate policies)
function regexExtractPolicies(text) {
  const result = {};
  const lower = text.toLowerCase();
  // Bank name detection
  for (const bank of KNOWN_BANKS) {
    if (lower.includes(bank.toLowerCase())) {
      result.bank_name = BANK_NAME_NORMALIZE[bank.toLowerCase().trim()] || bank;
      break;
    }
  }

  // Department detection
  if (/\bprime\b/i.test(text)) result.department = 'Prime';
  else if (/\baffordable\b/i.test(text)) result.department = 'Affordable';
  else if (/\bmicro\b/i.test(text)) result.department = 'Micro';
  else if (/\bsme\b/i.test(text)) result.department = 'SME';
  else if (/\bcorporate\b/i.test(text)) result.department = 'Corporate';
  else if (/\bstandard\b/i.test(text)) result.department = 'Standard';

  // Detect all mentioned loan types
  const loanTypeMap = {
    'Home Loan': /\b(?:home\s*loans?|hl|housing\s*loans?)\b/i,
    'LAP': /\b(?:lap|loan\s*against\s*propert(?:y|ies)|mortgage\s*loans?)\b/i,
    'Business Loan': /\b(?:business\s*loans?|bl|term\s*loans?)\b/i,
    'Balance Transfer': /\b(?:balance\s*transfer|bt)\b/i,
    'Top Up': /\b(?:top\s*up|topup)\b/i,
    'Personal Loan': /\b(?:personal\s*loans?|pl)\b/i,
    'Working Capital': /\b(?:working\s*capital|wc|cc|od|cash\s*credit|over\s*draft)\b/i,
    'Construction Loan': /\b(?:construction\s*(?:loans?|finance))\b/i,
    'Plot Loan': /\b(?:plot\s*(?:loans?|purchase))\b/i,
    'Commercial Purchase': /\b(?:commercial\s*purchase)\b/i
  };
  const detectedLoanTypes = [];
  for (const [type, regex] of Object.entries(loanTypeMap)) {
    if (regex.test(text)) detectedLoanTypes.push(type);
  }
  if (detectedLoanTypes.length > 0) result.loan_type = detectedLoanTypes[0];

  // Amount extraction (Indian notation: 10L=10 lakhs, 5Cr=500 lakhs)
  // Handles ₹ symbol, en-dash (–), em-dash (—), and standard hyphen
  // Look for funding/loan amount range first (e.g. "Funding 5L to 1.5Cr", "Loan Amount: ₹10 Lakhs – ₹75 Lakhs")
  const fundingMatch = text.match(/(?:fund(?:ing)?|loan\s*(?:amount)?|amount)\s*(?:[:=-]|\bfrom\b)?\s*(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)\s*(?:to|-|–|—)\s*(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?|cr|crore|crores)?(?:\b|[.,;\s]|$)/i);
  const amountPatterns = [
    /(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)\s*(?:to|-|–|—)\s*(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?|cr|crore|crores)/i,
    /(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)\s*(?:to|-|–|—)\s*(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)/i,
    /(?:upto|up\s*to|max(?:imum)?|limit)\s*[-:.]?\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)/i,
    /(?:upto|up\s*to|max(?:imum)?|limit)\s*[-:.]?\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)/i,
    /(?:min(?:imum)?)\s*[-:.]?\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)/i
  ];
  // Separate min/max patterns for multi-line format: "Minimum - 50 Lakhs" / "Maximum - 25cr"
  const separateMinLakh = text.match(/(?:min(?:imum)?)\s*[-:.]?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)/i);
  const separateMinCr = text.match(/(?:min(?:imum)?)\s*[-:.]?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)/i);
  const separateMaxLakh = text.match(/(?:max(?:imum)?)\s*[-:.]?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)/i);
  const separateMaxCr = text.match(/(?:max(?:imum)?)\s*[-:.]?\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)/i);

  const rangeMatch = fundingMatch || text.match(amountPatterns[0]);
  if (rangeMatch) {
    result.loan_min_lakhs = parseFloat(rangeMatch[1]);
    const unit2 = rangeMatch[0].match(/(?:cr|crore|crores)\s*$/i);
    result.loan_max_lakhs = unit2 ? parseFloat(rangeMatch[2]) * 100 : parseFloat(rangeMatch[2]);
  }
  const rangeCrMatch = text.match(amountPatterns[1]);
  if (rangeCrMatch) {
    result.loan_min_lakhs = parseFloat(rangeCrMatch[1]) * 100;
    result.loan_max_lakhs = parseFloat(rangeCrMatch[2]) * 100;
  }
  // Try separate min/max lines (handles "Minimum - 50 Lakhs\nMaximum - 25cr")
  if (!result.loan_max_lakhs) {
    if (separateMaxCr) {
      result.loan_max_lakhs = parseFloat(separateMaxCr[1]) * 100;
    } else if (separateMaxLakh) {
      result.loan_max_lakhs = parseFloat(separateMaxLakh[1]);
    } else {
      const maxLakhMatch = text.match(amountPatterns[2]);
      if (maxLakhMatch) result.loan_max_lakhs = parseFloat(maxLakhMatch[1]);
      const maxCrMatch = text.match(amountPatterns[3]);
      if (maxCrMatch && !result.loan_max_lakhs) result.loan_max_lakhs = parseFloat(maxCrMatch[1]) * 100;
    }
  }
  if (!result.loan_min_lakhs) {
    if (separateMinCr) {
      result.loan_min_lakhs = parseFloat(separateMinCr[1]) * 100;
    } else if (separateMinLakh) {
      result.loan_min_lakhs = parseFloat(separateMinLakh[1]);
    } else {
      const minLakhMatch = text.match(amountPatterns[4]);
      if (minLakhMatch) result.loan_min_lakhs = parseFloat(minLakhMatch[1]);
    }
  }

  // ROI extraction - product-specific: "ROI HL 10.75% to 13.5%", "ROI LAP 12.50% to 16%"
  const productRoiMap = {};
  // Match "ROI HL 10.75% to 13.5%", "ROI LAP 12.50% to 16%"
  const productRoiMatches = [...text.matchAll(/(?:roi|rate)\s*(?:[-:]?\s*)(?:for\s+)?(\b(?:hl|lap|home\s*loan|business\s*loan|bl|pl|personal\s*loan)\b)\s*[-:.]?\s*(\d+(?:\.\d+)?)\s*%\s*(?:(?:to|-)\s*(\d+(?:\.\d+)?)\s*%|onwards)/gi)];
  for (const m of productRoiMatches) {
    const prodKey = m[1].toUpperCase().replace(/\s+/g, '_');
    if (!productRoiMap[prodKey]) productRoiMap[prodKey] = [];
    productRoiMap[prodKey].push(parseFloat(m[2]));
    if (m[3]) productRoiMap[prodKey].push(parseFloat(m[3]));
  }
  // Also match "LAP - ROI : 14.00% Onwards" or "HL Starting ROI 10.99%" pattern (product before ROI)
  const reverseRoiMatches = [...text.matchAll(/(\b(?:hl|lap|home\s*loan|business\s*loan|bl|pl|personal\s*loan)\b)\s*[-:.]?\s*(?:starting\s+|from\s+)?(?:roi|rate)\s*[-:.]?\s*(\d+(?:\.\d+)?)\s*%\s*(?:(?:to|-)\s*(\d+(?:\.\d+)?)\s*%|onwards)?/gi)];
  for (const m of reverseRoiMatches) {
    const prodKey = m[1].toUpperCase().replace(/\s+/g, '_');
    if (!productRoiMap[prodKey]) productRoiMap[prodKey] = [];
    productRoiMap[prodKey].push(parseFloat(m[2]));
    if (m[3]) productRoiMap[prodKey].push(parseFloat(m[3]));
  }
  // BT+TopUp ROI: "Home loan BT + TOP UP ROI 10.25 TO 11.25%" or "LAP BT + TOP UP 14.50% to 15.90%"
  const btRoiMatches = [...text.matchAll(/(\b(?:hl|lap|home\s*loan)\b)\s*(?:bt|balance\s*transfer)\s*\+?\s*(?:top\s*up|topup)?\s*(?:roi)?\s*[-:.]?\s*(\d+(?:\.\d+)?)\s*%?\s*(?:(?:to|-)\s*(\d+(?:\.\d+)?)\s*%)/gi)];
  for (const m of btRoiMatches) {
    const rawKey = m[1].toUpperCase().replace(/\s+/g, '_');
    const btKey = (rawKey === 'HOME_LOAN' ? 'HL' : rawKey) + '_BT';
    if (!productRoiMap[btKey]) productRoiMap[btKey] = [];
    productRoiMap[btKey].push(parseFloat(m[2]));
    if (m[3]) productRoiMap[btKey].push(parseFloat(m[3]));
  }

  // General ROI extraction (fallback if no product-specific found)
  // Handles: "ROI 10%", "Interest Rate: 11.90%", "Interest Rate: Starting from 11.90%", "Rate of Interest: 10% to 12%"
  const roiPatterns = [
    /(?:roi|rate(?:\s*of\s*interest)?|interest\s*rate)\s*[-:.]*\s*(?:starting\s*)?(?:from)?\s*(\d+(?:\.\d+)?)\s*%?\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*%/i,
    /(\d+(?:\.\d+)?)\s*%\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)\s*%/i,
    /(?:roi|rate(?:\s*of\s*interest)?|interest\s*rate)\s*[-:.]*\s*(?:starting\s*)?(?:from)?\s*(\d+(?:\.\d+)?)\s*%/i
  ];
  if (Object.keys(productRoiMap).length === 0) {
    const roiRange = text.match(roiPatterns[0]) || text.match(roiPatterns[1]);
    if (roiRange) {
      result.roi_min_pct = parseFloat(roiRange[1]);
      result.roi_max_pct = parseFloat(roiRange[2]);
    } else {
      const roiSingle = text.match(roiPatterns[2]);
      if (roiSingle) {
        result.roi_min_pct = parseFloat(roiSingle[1]);
        result.roi_max_pct = parseFloat(roiSingle[1]);
      }
    }
    // Scan all ROI mentions to derive better min-max range
    const allRoiMatches = [...text.matchAll(/(?:roi|rate(?:\s*of\s*interest)?|interest\s*rate)\s*[-:.]*\s*(?:starting\s*)?(?:from)?\s*(\d+(?:\.\d+)?)\s*%/gi)];
    if (allRoiMatches.length > 1) {
      const roiValues = allRoiMatches.map(m => parseFloat(m[1])).filter(v => v > 0 && v < 50);
      if (roiValues.length > 1) {
        result.roi_min_pct = Math.min(...roiValues);
        result.roi_max_pct = Math.max(...roiValues);
      }
    }
  }

  // LTV extraction - product-specific: "LTV max 70% for LAP", "LTV max 87% for HL"
  const productLtvMap = {};
  const productLtvMatches = [...text.matchAll(/(?:ltv|loan\s*to\s*value)\s*(?:[-:.]?\s*)(?:max(?:imum)?\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:for\s+)?(\b(?:hl|lap|home\s*loan|bt|balance\s*transfer)\b)/gi)];
  for (const m of productLtvMatches) {
    const raw = m[2].toUpperCase().replace(/\s+/g, '_');
    const prodKey = raw === 'HOME_LOAN' ? 'HL' : raw;
    productLtvMap[prodKey] = parseFloat(m[1]);
  }
  // Also match "BT+Topup HL cases max LTV 77%"
  const btLtvMatches = [...text.matchAll(/(\b(?:bt|balance\s*transfer)[\s+]*(?:topup|top\s*up)?)\s*(?:hl|lap)?\s*cases?\s*(?:[-:]?\s*)(?:max\s*)?(?:ltv)\s*(\d+(?:\.\d+)?)\s*%/gi)];
  for (const m of btLtvMatches) {
    productLtvMap['BT_TOPUP'] = parseFloat(m[2]);
  }

  // General LTV extraction (fallback)
  if (Object.keys(productLtvMap).length === 0) {
    const ltvMinMaxMatch = text.match(/(?:ltv|loan\s*to\s*value)\s*[-:.]?\s*(?:min(?:imum)?\s*)?(\d+(?:\.\d+)?)\s*%?\s*(?:to|-|–|—|[,\s])\s*(?:max(?:imum)?\s*)?(\d+(?:\.\d+)?)\s*%/i);
    if (ltvMinMaxMatch) {
      result.ltv_min_pct = parseFloat(ltvMinMaxMatch[1]);
      result.ltv_pct = parseFloat(ltvMinMaxMatch[2]);
    } else {
      // Collect all LTV values
      const allLtvMatches = [...text.matchAll(/(?:ltv|loan\s*to\s*value)\s*(?:[-:.]?\s*)(?:max(?:imum)?|upto|up\s*to)?\s*(\d+(?:\.\d+)?)\s*%/gi)];
      if (allLtvMatches.length > 1) {
        const ltvValues = allLtvMatches.map(m => parseFloat(m[1])).filter(v => v > 0 && v <= 100);
        result.ltv_min_pct = Math.min(...ltvValues);
        result.ltv_pct = Math.max(...ltvValues);
      } else if (allLtvMatches.length === 1) {
        result.ltv_pct = parseFloat(allLtvMatches[0][1]);
      }
    }
  } else {
    // Use overall min/max from product-specific LTVs
    const allLtvVals = Object.values(productLtvMap);
    result.ltv_min_pct = Math.min(...allLtvVals);
    result.ltv_pct = Math.max(...allLtvVals);
  }

  // CIBIL extraction (handles "CIBIL - Min 650", "CIBIL: 700", "Min CIBIL 650")
  const cibilMatch = text.match(/(?:cibil|credit\s*score|min(?:imum)?\s*(?:cibil|score))\s*[-:.]?\s*(?:above|min(?:imum)?|>|>=)?\s*(\d{3})/i)
    || text.match(/(?:cibil)[^\n]{0,60}?(?:upto|up\s*to|from|above|>=?)\s*(\d{3})/i);
  if (cibilMatch) result.min_cibil = parseInt(cibilMatch[1]);

  // Tenure extraction (handle multiline: "Tenure\nLap - 15 Years", "Tenure: Up to 240 Months")
  const tenureMatch = text.match(/(?:tenure|max(?:imum)?\s*tenure)\s*(?::)?\s*(?:upto|up\s*to)?\s*(\d+)\s*(?:years?|yrs?|months?)/i);
  if (tenureMatch) {
    const isMonths = /months?/i.test(tenureMatch[0]);
    result.max_tenure_years = isMonths ? Math.round(parseInt(tenureMatch[1]) / 12) : parseInt(tenureMatch[1]);
  } else {
    const tenureIdx = text.search(/tenure/i);
    if (tenureIdx >= 0) {
      const nearbyText = text.substring(tenureIdx, tenureIdx + 100);
      const nearbyMatch = nearbyText.match(/(\d+)\s*(?:years?|yrs?|months?)/i);
      if (nearbyMatch) {
        const isMonths = /months?/i.test(nearbyMatch[0]);
        result.max_tenure_years = isMonths ? Math.round(parseInt(nearbyMatch[1]) / 12) : parseInt(nearbyMatch[1]);
      }
    }
  }

  // Profile detection - standard categories
  const profiles = [];
  if (/\ball\s*(?:type\s*(?:of\s*)?)?profiles?\b|\ball\s*(?:type\s*(?:of\s*)?)?(?:category|segment)/i.test(text)) {
    profiles.push('Salaried', 'Self-Employed', 'Professional', 'NRI');
  } else {
    if (/\bsalaried\b/i.test(text)) profiles.push('Salaried');
    if (/\bself[\s-]*employed\b|\bsenp\b|\bsep\b/i.test(text)) profiles.push('Self-Employed');
    if (/\bprofessional\b|\bdoctor\b|\bca\b|\blawyer\b/i.test(text)) profiles.push('Professional');
    if (/\bnri\b/i.test(text)) profiles.push('NRI');
  }

  // Extract specific profiles from lists (e.g. "Profiles:\n- Jr level Police\n- Gym\n- A/C Saloon")
  // Look for a profile/eligibility section header, then capture listed items after it
  const profileSectionMatch = text.match(/(?:profiles?|eligib(?:le|ility)|category|segment|we\s*(?:can\s*)?(?:do|fund|consider))\s*(?:[:*-]|\s*\n)([\s\S]*?)(?:\n\s*\n|\n\s*(?:roi|ltv|cibil|tenure|amount|loan|note|regard|contact|product|program|collateral|surrogate|special|process)|\*\s*(?:roi|ltv|cibil|tenure|amount|loan|note))/i);
  if (profileSectionMatch) {
    const sectionText = profileSectionMatch[1];
    // Extract items from bullets (*, -, •, numbers) or comma/newline separated
    const items = sectionText.split(/\n|,/).map(line =>
      line.replace(/^\s*[*•\-\d.)👉💥]+\s*/, '').trim()
    ).filter(item => item.length >= 2 && item.length < 60);
    for (const item of items) {
      // Skip generic keywords already handled above
      if (/^\s*(?:salaried|self[\s-]*employed|senp|sep|professional|nri|and|or)\s*$/i.test(item)) continue;
      // Skip if it looks like a policy field rather than a profile
      if (/(?:roi|ltv|cibil|tenure|loan|amount|lakh|crore|%|\d+L|\d+Cr)/i.test(item)) continue;
      const cleaned = item.replace(/[*_~]/g, '').trim();
      if (cleaned && !profiles.includes(cleaned)) {
        profiles.push(cleaned);
      }
    }
  }

  if (profiles.length > 0) result.profiles = profiles;

  // Loan nature
  if (/\bsecured\b/i.test(text) && /\bunsecured\b/i.test(text)) result.loan_nature = 'Both';
  else if (/\bsecured\b/i.test(text)) result.loan_nature = 'Secured';
  else if (/\bunsecured\b/i.test(text)) result.loan_nature = 'Unsecured';

  // Own house required (BL/unsecured specific)
  if (/(?:own\s*(?:house|property|home)\s*(?:is\s*)?(?:not|no)\s*(?:required|mandatory|needed|compulsory))|(?:(?:no|not|without)\s*own\s*(?:house|property|home))|(?:rented\s*(?:house\s*)?(?:also\s*)?(?:ok|accepted|consider))/i.test(text)) {
    result.own_house_required = 'No';
  } else if (/(?:own\s*(?:house|property|home)\s*(?:is\s*)?(?:required|mandatory|needed|compulsory|must))|(?:must\s*(?:have|own)\s*(?:own\s*)?(?:house|property|home))/i.test(text)) {
    result.own_house_required = 'Yes';
  }

  // Max USL (unsecured loans) allowed - count of existing USLs
  const uslMatch = text.match(/(?:max(?:imum)?\s*(?:usl|unsecured\s*loan(?:s)?)\s*(?:allowed|limit|count)?\s*[-:.]*\s*(\d{1,2}))|(?:(?:usl|unsecured\s*loan(?:s)?)\s*(?:max(?:imum)?|limit|not\s*(?:more|exceed(?:ing)?)\s*(?:than)?|<=?|upto|up\s*to)\s*[-:.]*\s*(\d{1,2}))|(?:(\d{1,2})\s*(?:usl|unsecured\s*loan(?:s)?)\s*(?:max(?:imum)?|allowed|only))|(?:(?:usl|unsecured\s*loan(?:s)?)\s*[-:.]*\s*(\d{1,2})\s*(?:allow|permitted|accepted|ok|only))/i);
  if (uslMatch) {
    const uslVal = parseInt(uslMatch[1] || uslMatch[2] || uslMatch[3] || uslMatch[4]);
    if (uslVal > 0 && uslVal <= 20) result.max_usl = uslVal;
  }

  // Processing fee
  const feeMatch = text.match(/(?:processing\s*fee|pf)\s*(?::)?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (feeMatch) result.processing_fee_pct = parseFloat(feeMatch[1]);

  // Collateral types - standard categories
  const collaterals = [];
  if (/\bresidential\b/i.test(text)) collaterals.push('Residential');
  if (/\bcommercial\b(?!\s*purchase)/i.test(text)) collaterals.push('Commercial');
  if (/\bindustrial\b/i.test(text)) collaterals.push('Industrial');
  if (/\brental\b/i.test(text)) collaterals.push('Rental');
  if (/\bvacant\b/i.test(text)) collaterals.push('Vacant');
  if (/\bplot\b|\bland\b/i.test(text)) collaterals.push('Plot/Land');
  if (/\bwarehouse\b|\bwarehouses?\b/i.test(text)) collaterals.push('Warehouse');
  if (/\bself\s*occupied\b/i.test(text)) collaterals.push('Self Occupied');
  if (/\blet\s*out\b/i.test(text)) collaterals.push('Let Out');
  if (/\blrd\b/i.test(text)) collaterals.push('LRD');

  // Extract specific collateral items from lists (e.g. "Municipal Open Plots", "Gramakantam", "Nursing Homes")
  // Look for collateral/property/funded section header, then capture listed items
  // Handles "Property types", "Properties funded", "Collateral:" etc.
  // Section ends at "Regards", "Note:", or other non-property keywords (not at blank lines between emoji bullet groups)
  const collateralSectionMatch = text.match(/(?:collateral|propert(?:y|ies)(?:\s*types?)?|funded|we\s*fund(?:ed)?(?:\s+\w+)?[,.]?|accept(?:ed)?(?:\s*propert(?:y|ies))?)\s*(?:[:*\-=》\u{1F535}\u{1F538}\u{2611}\u{2705}\u{1F4CD}]|\s*\n)([\s\S]*?)(?:\n\s*(?:roi|ltv|cibil|tenure|amount|loan\s*amount|note\b|regard|contact|program|surrogate|special|process|profile|eligib)|\*\s*(?:roi|ltv|cibil|tenure|login|regard|banker)|$)/iu);
  if (collateralSectionMatch) {
    const sectionText = collateralSectionMatch[1];
    const items = sectionText.split(/\n/).map(line =>
      line.replace(/^\s*(?:[*•\-\d.)👉💥\u{1F535}\u{1F538}\u{2611}\u{FE0F}?\u{2705}\u{1F4CD}\u{25AA}\u{25AB}\u{26AA}\u{26AB}☑️✅📍🔵🔸]|=?》)+\s*/u, '').trim()
    ).filter(item => item.length >= 3 && item.length < 120);
    for (const item of items) {
      if (/(?:roi|ltv|cibil|tenure|loan\s*amount|lakh|crore|%|\d+L|\d+Cr|regard|contact|banker|home\s*loans?\s*[\/&]|mortgage\s*loans?\b|banking\s*program|banking\s*surrogate)/i.test(item)) continue;
      const cleaned = item.replace(/[*_~\u{1F535}\u{1F538}\u{2611}\u{FE0F}?\u{2705}\u{1F4CD}☑️✅📍🔵🔸]/gu, '').trim();
      if (cleaned && !collaterals.some(c => c.toLowerCase() === cleaned.toLowerCase())) {
        collaterals.push(cleaned);
      }
    }
  }
  // Also capture standalone specific property mentions from bullet points anywhere in text
  // Handles emoji bullets (🔵🔸☑️) and standard bullet chars
  const propertyItems = [...text.matchAll(/(?:^|\n)\s*(?:[*•\-🔵🔸☑️✅📍\u{1F535}\u{1F538}\u{2611}\u{2705}\u{1F4CD}]|=?》)\s*((?:no\s+)?(?:plan|permission|semi\s*pukka|gramakantam|grampanchayat|municipality|municipal|nursing\s*home|guest\s*house|hotel|hostel|pg\b|open\s*plot|unauthorized|multi(?:ple)?\s*tenant|acc\s+propert|passage\s*road|kutcha|single\s*document|commercial\s*purchase|hospital|bar\s*(?:&|and)\s*restaurant|function\s*hall|lodge|shopping\s*mall|cinema\s*hall|self\s*occupied|let\s*out|lrd|warehouse)[^\n]{0,80})/gimu)];
  for (const m of propertyItems) {
    const cleaned = m[1].replace(/[*_~🔵🔸☑️✅📍]/gu, '').trim();
    if (cleaned && !collaterals.some(c => c.toLowerCase() === cleaned.toLowerCase())) {
      collaterals.push(cleaned);
    }
  }
  // Capture all =》 bullet items after "we fund" header (for WhatsApp policy messages)
  if (/we\s*fund/i.test(text)) {
    const arrowItems = [...text.matchAll(/(?:^|\n)\s*=?》\s*([^\n]{3,120})/gm)];
    for (const m of arrowItems) {
      const cleaned = m[1].replace(/[*_~]/g, '').trim();
      if (/(?:roi|starting\s*roi|ltv|cibil|tenure|loan\s*amount|lakh|crore|\d+(?:\.\d+)?\s*%|regard|contact|banker|call\s*me|bt\s*\+?\s*top|balance\s*transfer|home\s*loans?\s*[\/&]|mortgage\s*loans?|banking\s*program|banking\s*surrogate)/i.test(cleaned)) continue;
      if (cleaned && !collaterals.some(c => c.toLowerCase() === cleaned.toLowerCase())) {
        collaterals.push(cleaned);
      }
    }
  }

  if (collaterals.length > 0) result.collateral_types = collaterals;

  // LTV min extraction (fallback if not already captured)
  if (!result.ltv_min_pct) {
    const ltvMinMatch = text.match(/(?:ltv|loan\s*to\s*value)\s*[-:.]?\s*(?:from|min(?:imum)?)\s*(\d+(?:\.\d+)?)\s*%/i);
    if (ltvMinMatch) result.ltv_min_pct = parseFloat(ltvMinMatch[1]);
  }

  // Geo limits extraction (km radius) - handles "within 100km", "Geo limits 100 kms", "Municipality & HMDA limits upto 100KM", "Upto 60Kms from the branch", "Geo Limit Extended to 60 Km"
  const geoMatch = text.match(/(?:within|radius|geo(?:graphic)?(?:\s*(?:location|lim(?:it|its)?))?|city\s*limit|distance|(?:municipality|hmda|ghmc|municipal|corporation)\s*(?:&|\band\b)?\s*(?:hmda|municipality|ghmc|limits?)?(?:\s*limits?)?)\s*(?::)?\s*(?:upto|up\s*to|extended\s*to)?\s*(\d+)\s*(?:km|kms|kilometer)/i)
    || text.match(/(?:upto|up\s*to)\s*(\d+)\s*(?:km|kms|kilometer)\s*(?:from\s+(?:the\s+)?(?:branch|city|location|office|municipal))/i);
  if (geoMatch) {
    result.geo_limits_km = parseInt(geoMatch[1]);
  } else if (/operative\s*location|service\s*area|coverage\s*area/i.test(text)) {
    // Extract max km from location listings like "HYDERABAD > Upto 100 kms"
    const allKm = [...text.matchAll(/(?:upto|up\s*to)\s*(\d+)\s*(?:km|kms|kilometer)/gi)];
    if (allKm.length > 0) {
      result.geo_limits_km = Math.max(...allKm.map(m => parseInt(m[1])));
    }
  }

  // Product type mapping from loan_type
  if (result.loan_type) {
    result.product_type = mapToProductType(result.loan_type);
  }

  // Programs / Surrogate programs extraction
  const programs = [];
  const programPatterns = [
    { regex: /\bNIP\b|\bNo\s*Income\s*Program\b/i, label: 'NIP (No Income Program)' },
    { regex: /\bLIP\b|\bLiquid\s*Income\s*(?:Program|Method)\b|\bLife\s*Insurance\s*(?:Policy|Program)\b/i, label: 'LIP' },
    { regex: /\bBanking\s*(?:[Ss]urrogate|[Pp]rogram)\b|\bAverage\s*Banking\s*Program\b/i, label: 'Banking Surrogate' },
    { regex: /\bKutcha\s*bills?\b/i, label: 'Kutcha Bills (No ITR)' },
    { regex: /\bNo\s*ITRS?\s*(?:Required|needed)?\b/i, label: 'No ITR Program' },
    { regex: /\bITR\s*Program\b|\bITR\s*based\b|\bRegular\s*income\s*method\b|\bCPM\b/i, label: 'ITR Program' },
    { regex: /\bGST\s*(?:based|program|surrogate)?\b(?=.*(?:program|turnover|linked|method|upto|up\s*to|cr\b))/i, label: 'GST Program' },
    { regex: /\bTurnover\s*linked\b|\bGross\s*Turnover\b/i, label: 'Turnover Linked' },
    { regex: /\bGross\s*(?:professional\s*)?Receipts?\b/i, label: 'Gross Receipts' },
    { regex: /\bLow\s*LTV\b/i, label: 'Low LTV' },
    { regex: /\bPD\s*Assessment\b/i, label: 'PD Assessment' },
    { regex: /\bDSCR\b|\bDebt\s*Service\b/i, label: 'DSCR' },
    { regex: /\bABB\b|\bAverage\s*Bank(?:ing)?\s*(?:Balance|Program)\b/i, label: 'ABB Based' },
    { regex: /\bOD\s*(?:based|program|surrogate)\b|\bCC\s*(?:based|program|surrogate)\b/i, label: 'OD/CC Based' },
    { regex: /\bsingle\s*doc(?:ument)?\b/i, label: 'Single Document' },
    { regex: /\bEBITDA\s*(?:Margin\s*)?(?:Program)?\b/i, label: 'EBITDA Margin Program' },
    { regex: /\bPure\s*Rental\s*(?:Program)?\b/i, label: 'Pure Rental Program' },
    { regex: /\bRepayment\s*Track\s*Record\b|\bRTR\s*(?:method|program)?\b/i, label: 'Repayment Track Record' },
    { regex: /\bIncome\s*Multip(?:lier|ler)\s*(?:Program)?\b/i, label: 'Income Multiplier Program' },
    { regex: /\bHybrid\s*(?:Mortgage\s*)?(?:Product|Program)?\b/i, label: 'Hybrid Mortgage' },
    { regex: /\bSubjective\s*Cash\s*Flow\b/i, label: 'Subjective Cash Flow' },
    { regex: /\bLRD\b/i, label: 'LRD' },
  ];
  // Helper: extract max loan amount from a text line (e.g. "up to 25cr", "- 5cr", "upto 10L")
  function extractLineAmount(line) {
    const crMatch = line.match(/(?:upto|up[\s-]*to|[-–—])\s*(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)\b/i)
      || line.match(/(\d+(?:\.\d+)?)\s*(?:cr|crore|crores)\b/i);
    if (crMatch) {
      const val = parseFloat(crMatch[1]);
      return val >= 1 ? `${val}Cr` : `${val}Cr`;
    }
    const lMatch = line.match(/(?:upto|up[\s-]*to|[-–—])\s*(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)\b/i)
      || line.match(/(\d+(?:\.\d+)?)\s*(?:l|lakh|lakhs|lacs?)\b/i);
    if (lMatch) return `${parseFloat(lMatch[1])}L`;
    return null;
  }

  for (const { regex, label } of programPatterns) {
    const match = text.match(regex);
    if (match) {
      // Find the line containing this match to extract the amount
      const matchIdx = text.indexOf(match[0]);
      const lineStart = text.lastIndexOf('\n', matchIdx) + 1;
      const lineEndIdx = text.indexOf('\n', matchIdx);
      const line = text.substring(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx);
      const amt = extractLineAmount(line);
      programs.push(amt ? `${label} (upto ${amt})` : label);
    }
  }
  // Also extract numbered/bulleted/emoji-checkmark program lists (☑️, ✅)
  const numberedList = text.match(/(?:^|\n)\s*(?:\d+[.)]|[☑️✅🔹🔸])\s*(.+)/gm);
  if (numberedList) {
    for (const item of numberedList) {
      const cleaned = item.replace(/^\s*(?:\d+[.)]|[☑️✅🔹🔸])\s*/u, '').trim();
      if (cleaned.length > 2 && cleaned.length < 120) {
        if (/surrogate|program|based|nip|lip|itr|gst|turnover|ltv|dscr|abb|income|ebitda|rental|rtr|repayment|hybrid|lrd|multiplier|method|cash\s*flow|liquid/i.test(cleaned)) {
          const cleanedLower = cleaned.toLowerCase();
          const isDuplicate = programs.some(p => {
            const pLower = p.toLowerCase();
            const keywords = ['nip', 'lip', 'banking', 'itr', 'gst', 'turnover', 'ltv', 'dscr', 'abb', 'income', 'ebitda', 'rental', 'rtr', 'hybrid', 'lrd', 'multiplier', 'cash flow', 'liquid'];
            return keywords.some(kw => pLower.includes(kw) && cleanedLower.includes(kw));
          });
          if (!isDuplicate) programs.push(cleaned);
        }
      }
    }
  }
  if (programs.length > 0) result.programs = programs;

  // Other remarks extraction
  const remarks = [];
  if (/cash\s*salary/i.test(text)) remarks.push('Cash Salary considered');
  if (/without\s*itr|no\s*itr/i.test(text)) remarks.push('Without ITR');
  if (/without\s*gst|no\s*gst/i.test(text)) remarks.push('Without GST');
  if (/fresh\s*(?:cases?|doc)/i.test(text)) remarks.push('Fresh cases/doc accepted');
  if (/top[\s-]*up/i.test(text) && result.loan_type !== 'Top Up') remarks.push('Top-up available');
  if (/balance\s*transfer/i.test(text) && result.loan_type !== 'Balance Transfer') remarks.push('BT available');
  if (/pre[\s-]*approved|pre[\s-]*sanction/i.test(text)) remarks.push('Pre-approved available');
  if (/case\s*to\s*case|case\s*basis/i.test(text)) remarks.push('Case to case basis');
  if (/rural|semi[\s-]*urban/i.test(text)) remarks.push('Rural/Semi-urban eligible');
  if (/only\s*metro|metro\s*only/i.test(text)) remarks.push('Metro only');
  if (/cibil\s*issue|low\s*cibil|cibil\s*(?:problem|relaxation)/i.test(text)) remarks.push('CIBIL issue cases considered');
  if (/low\s*ltv/i.test(text) && !/programs/.test(remarks.join(''))) remarks.push('Low LTV available');
  if (/single\s*doc(?:ument)?/i.test(text)) remarks.push('Single document accepted');
  if (/rental/i.test(text)) remarks.push('Rental property accepted');
  if (/\bnri\s*(?:lap|hl|home\s*loan|loan)/i.test(text)) {
    const nriMatch = text.match(/nri\s*(?:lap|hl|home\s*loan|loan)[^\n]{0,60}/i);
    if (nriMatch) remarks.push(nriMatch[0].replace(/[*👇👉💥🏠]/g, '').trim());
  }
  if (/\bno\s*(?:min(?:imum)?)\s*sq\s*yard/i.test(text)) remarks.push('No minimum sq yards norms');
  if (/\bno\s*(?:lrs|plan|permission)\b/i.test(text)) {
    const noMatch = text.match(/no\s*(?:lrs|plan\/permission|plan|permission)[^\n]{0,40}/i);
    if (noMatch) remarks.push(noMatch[0].replace(/[*👇👉💥🏠]/g, '').trim());
  }
  if (/\bgrama?(?:kantam|panchayat)\b/i.test(text)) remarks.push('Gramakantam/Grampanchayat accepted');
  if (/\bsemi[\s-]*pukka\b/i.test(text)) remarks.push('Semi Pukka accepted');

  // Capture bullet-point remarks that mention special conditions/offerings
  const bulletRemarks = [...text.matchAll(/(?:^|\n)\s*[*•\-]\s*([^\n]{10,100})/gm)];
  for (const bm of bulletRemarks) {
    const line = bm[1].replace(/[*👇👉💥🏠]/g, '').trim();
    // Only capture lines that look like policy remarks (not generic sentences)
    if (/\bnri\b.*\b(?:lap|hl|plot|open|loan)\b|\bopen\s*plot|\bno\s*(?:min|lrs|plan)|grampanchayat|gramakantam|semi\s*pukka/i.test(line)) {
      const isDuplicate = remarks.some(r => {
        const rLower = r.toLowerCase();
        const lineLower = line.toLowerCase();
        const rWords = rLower.split(/\s+/).filter(w => w.length > 3);
        return rWords.filter(w => lineLower.includes(w)).length >= 2;
      });
      if (!isDuplicate) remarks.push(line);
    }
  }

  // Capture any "Note:" section
  const noteMatch = text.match(/note\s*:\s*(.+?)(?:\n|$)/i);
  if (noteMatch) {
    const note = noteMatch[1].replace(/[*👇👉💥🏠]/g, '').trim();
    if (note.length > 5) {
      const noteLower = note.toLowerCase();
      const isDuplicate = remarks.some(r => {
        const rLower = r.toLowerCase();
        const rWords = rLower.split(/\s+/).filter(w => w.length > 3);
        return rWords.filter(w => noteLower.includes(w)).length >= 2;
      });
      if (!isDuplicate) remarks.push(note);
    }
  }
  // Capture KEY HIGHLIGHTS / USP / FEATURES section items into special_conditions
  const specialConditions = [];
  const highlightSectionMatch = text.match(/(?:key\s*highlight|usp|key\s*feature|highlight|salient\s*feature|special\s*feature)\s*[s:]?\s*[:\n]([\s\S]*?)(?:\n\s*(?:contact|📞|regard|call\s*(?:for|us)|for\s*(?:more|any)\s*(?:detail|query|assist)|━|───|$))/i);
  if (highlightSectionMatch) {
    const lines = highlightSectionMatch[1].split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^\s*[✅☑️✔️🔹🔸•\-*\d.)]+\s*/u, '').trim();
      if (cleaned.length < 5 || cleaned.length > 150) continue;
      // Skip lines already captured in other fields
      if (/^(?:geo\s*location|loan\s*amount|base\s*rate|roi\b|ltv\b)/i.test(cleaned)) continue;
      specialConditions.push(cleaned);
    }
  }
  if (specialConditions.length > 0) result.special_conditions = specialConditions.join('\n');

  if (remarks.length > 0) result.other_remarks = remarks.join('; ');

  // Banker contact number extraction (Indian mobile: 10 digits starting with 6-9)
  const contactMatch = text.match(/(?:contact|call|reach|mob(?:ile)?|ph(?:one)?|no\.?|number|📞|☎️?|📱)\s*[-:.]?\s*((?:\+91[-\s]?)?[6-9]\d{4}[-\s]?\d{5})/i)
    || text.match(/((?:\+91[-\s]?)?[6-9]\d{4}[-\s]?\d{5})/);
  if (contactMatch) result.banker_contact = contactMatch[1].replace(/[-\s]/g, '');

  // Banker name extraction
  // Note: [A-Z][A-Za-z.]* allows single initials like "M Sekhar", "S Kumar"
  // Designation keywords to reject as names
  const DESIGNATION_RE = /^(?:area\s*head|area\s*sales\s*manager|sales\s*(?:head|manager)|branch\s*(?:head|manager)|zonal\s*(?:head|manager)|regional\s*(?:head|manager)|business\s*(?:head|manager)|senior\s*manager|asst\.?\s*manager|team\s*lead|cluster\s*head|deputy\s*manager|general\s*manager|chief\s*manager|assistant\s*(?:manager|vice)|avp|vp|agm|dgm|gm|asm|dsm|rsm|bm|manager)$/i;

  // Name pattern: allows lowercase in subsequent words (e.g. "T. Sai kumar", "Sanem.Sainath")
  const NAME_PAT = '[A-Z][A-Za-z.]*(?:[ \\t]+[A-Za-z][A-Za-z.]+){0,3}';
  const NAME_RE = new RegExp('^' + NAME_PAT + '$');

  const bankerNameMatch = text.match(new RegExp('(?:\\bbanker\\b|\\brm\\b|\\brelationship\\s*manager\\b|\\bcontact\\s*person\\b|\\bspoc\\b|\\bcoordinator\\b|\\bbranch\\s*manager\\b)\\s*[-:.]?\\s*(' + NAME_PAT + ')', 'm'))
    || text.match(new RegExp('(?:\\bsr\\.?\\s*)?(?:\\bsales\\s*manager\\b|\\barea\\s*manager\\b|\\brelationship\\s*officer\\b)\\s*[-:.]?\\s*\\n\\s*(' + NAME_PAT + ')', 'm'))
    || text.match(/(?:^|\n)\s*(?:I'?\s*m|I\s+am|This\s+is|myself)\s+([A-Z][A-Za-z.]*(?:[ \t]+[A-Za-z][A-Za-z.]+){0,3})\s+(?:from|at|with)\s/m);
  if (bankerNameMatch && !DESIGNATION_RE.test(bankerNameMatch[1].trim())) {
    result.banker_name = bankerNameMatch[1].trim();
  }
  if (!result.banker_name) {
    // Fallback: "Regards\nTitle?\nName" - skip designation lines after regards
    const regardsBlock = text.match(/(?:best\s*)?(?:regards|rgds|thanks|thank\s*you)\s*[-:.]*\s*[\r\n]+([\s\S]{0,200})/im);
    if (regardsBlock) {
      const lines = regardsBlock[1].split(/\r?\n/).map(l => l.trim()).filter(l => l.length >= 2);
      for (const line of lines) {
        if (DESIGNATION_RE.test(line)) continue;
        if (/^\+?\d[\d\s-]{7,}$/.test(line)) continue;
        if (result.bank_name && line.toLowerCase().includes(result.bank_name.toLowerCase().split(' ')[0])) continue;
        if (NAME_RE.test(line) && line.length <= 40) {
          result.banker_name = line;
          break;
        }
      }
    }
  }
  // Fallback: "More Details:-\nName" (must be at start of line to avoid "for more details" mid-sentence)
  if (!result.banker_name) {
    const moreDetailsMatch = text.match(/(?:^|\n)\s*more\s*details\s*[-:.]*\s*\n\s*([A-Z][A-Za-z.]*(?:[ \t]+[A-Z][A-Za-z.]+){1,3})/im);
    if (moreDetailsMatch) result.banker_name = moreDetailsMatch[1].trim();
  }
  // Fallback: "Name Title-Manager(Bank)" on same line
  if (!result.banker_name) {
    const nameManagerMatch = text.match(/\n([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z]+){0,2})\s+(?:BL|HL|LAP|RM|Sales|Loan|Area|Zonal|Regional|Branch|Business|Senior|Asst\.?)?[-\s]*(?:Manager|Head|Executive|Officer|AVP|VP|AGM|DGM|GM|ASM|DSM|RSM|BM)\b[^\n]*/im);
    if (nameManagerMatch) result.banker_name = nameManagerMatch[1].trim();
  }
  // Fallback: Name on one line, Title on next line (e.g. "M Sekhar\nSales Manager")
  if (!result.banker_name) {
    const nameAboveTitleMatch = text.match(new RegExp('\\n\\s*(' + NAME_PAT + ')\\s*\\n\\s*(?:BL|HL|LAP|RM|Sales|Loan|Area|Zonal|Regional|Branch|Business|Senior|Asst\\.?)?[-\\s]*(?:Manager|Head|Executive|Officer|AVP|VP|AGM|DGM|GM|ASM|DSM|RSM|BM)\\b', 'm'));
    if (nameAboveTitleMatch) {
      const candidate = nameAboveTitleMatch[1].trim();
      if (!/^(?:docs|roi|ltv|cibil|tenure|note|nob|abb|dscr|cmr|kindly|please|property|collateral)/i.test(candidate) && candidate.length <= 40) {
        result.banker_name = candidate;
      }
    }
  }
  // Fallback: Name on line just before phone number (allows single compound names like "Sanem.Sainath")
  if (!result.banker_name) {
    const nameBeforePhone = text.match(new RegExp('\\n\\s*(' + NAME_PAT + ')\\s*\\n\\s*(?:\\+?91[-\\s]?)?[6-9]\\d{4}[-\\s]?\\d{5}', 'm'));
    if (nameBeforePhone) {
      const candidate = nameBeforePhone[1].trim();
      if (!DESIGNATION_RE.test(candidate) && !/^(?:docs|roi|ltv|cibil|tenure|note|nob|abb|dscr|cmr|kindly|please|property|collateral)/i.test(candidate) && candidate.length <= 40) {
        result.banker_name = candidate;
      }
    }
  }
  // Fallback: Name 2 lines before phone (Name\nTitle\nPhone)
  if (!result.banker_name) {
    const nameTitlePhone = text.match(new RegExp('\\n\\s*(' + NAME_PAT + ')\\s*\\n[^\\n]{3,40}\\n\\s*(?:\\+?91[-\\s]?)?[6-9]\\d{4}[-\\s]?\\d{5}', 'm'));
    if (nameTitlePhone) {
      const candidate = nameTitlePhone[1].trim();
      if (!DESIGNATION_RE.test(candidate) && !/^(?:docs|roi|ltv|cibil|tenure|note|nob|abb|dscr|cmr|kindly|please|property|collateral|more\s*detail)/i.test(candidate) && candidate.length <= 40) {
        result.banker_name = candidate;
      }
    }
  }
  // Fallback: Name on line before "Title/Phone" or "Title-Phone" (e.g. "Surendra Thommandru\nASM/9966865008")
  if (!result.banker_name) {
    const nameAboveTitlePhone = text.match(new RegExp('\\n\\s*(' + NAME_PAT + ')\\s*\\n\\s*(?:ASM|DSM|RSM|BM|RM|AVP|VP|AGM|DGM|GM|Manager|Head|Executive|Officer)\\s*[/\\-]\\s*(?:\\+?91[-\\s]?)?[6-9]\\d{4}[-\\s]?\\d{5}', 'im'));
    if (nameAboveTitlePhone) {
      const candidate = nameAboveTitlePhone[1].trim();
      if (!DESIGNATION_RE.test(candidate) && candidate.length <= 40) {
        result.banker_name = candidate;
      }
    }
  }

  // --- Multi-product merge ---
  // If message mentions multiple products (HL, LAP, BT), merge into one consolidated policy
  const hasProductSpecificData = Object.keys(productRoiMap).length > 0 || Object.keys(productLtvMap).length > 0;

  if (detectedLoanTypes.length > 1 && hasProductSpecificData) {
    // Combine loan types into single label
    result.loan_type = detectedLoanTypes.join(' + ');
    result.product_type = detectedLoanTypes.length > 1 ? 'Other' : mapToProductType(detectedLoanTypes[0]);

    // Merge all product-specific ROI values into overall min/max
    const allRoiVals = Object.values(productRoiMap).flat().filter(v => v > 0 && v < 50);
    if (allRoiVals.length > 0) {
      result.roi_min_pct = Math.min(...allRoiVals);
      result.roi_max_pct = Math.max(...allRoiVals);
    }

    // Merge all product-specific LTV values into overall min/max
    const allLtvVals = Object.values(productLtvMap).filter(v => v > 0 && v <= 100);
    if (allLtvVals.length > 0) {
      result.ltv_min_pct = Math.min(...allLtvVals);
      result.ltv_pct = Math.max(...allLtvVals);
    }

    // Build product-wise breakdown for remarks
    const productDetails = [];
    for (const loanType of detectedLoanTypes) {
      const key = loanType === 'Home Loan' ? 'HL' : loanType === 'LAP' ? 'LAP' : loanType === 'Balance Transfer' ? 'BT' : loanType.replace(/\s+/g, '_').toUpperCase();
      const parts = [];
      const roiVals = productRoiMap[key] || productRoiMap[key + '_BT'];
      if (roiVals && roiVals.length > 0) {
        parts.push(`ROI ${Math.min(...roiVals)}%-${Math.max(...roiVals)}%`);
      }
      if (productLtvMap[key] !== undefined) {
        parts.push(`LTV ${productLtvMap[key]}%`);
      }
      if (parts.length > 0) productDetails.push(`${key}: ${parts.join(', ')}`);
    }
    // Add BT details if present
    const btRoiKeys = Object.keys(productRoiMap).filter(k => k.endsWith('_BT'));
    for (const btKey of btRoiKeys) {
      const vals = productRoiMap[btKey];
      if (vals && vals.length > 0) {
        productDetails.push(`${btKey}: ROI ${Math.min(...vals)}%-${Math.max(...vals)}%`);
      }
    }
    if (productLtvMap['BT_TOPUP'] || productLtvMap['BT']) {
      productDetails.push(`BT LTV: ${productLtvMap['BT_TOPUP'] || productLtvMap['BT']}%`);
    }
    if (productDetails.length > 0) {
      const breakdown = productDetails.join('; ');
      result.other_remarks = result.other_remarks ? result.other_remarks + '; ' + breakdown : breakdown;
    }
  }

  return [result];
}

// Backward-compatible wrapper (returns single policy for AI fallback path)
function regexExtractPolicy(text) {
  return regexExtractPolicies(text)[0];
}

// AI-based policy extraction (Phase 2 - for complex messages)
async function aiExtractPolicy(text) {
  try {
    const prompt = `Extract bank loan policy details from this WhatsApp message. Return ONLY valid JSON with these fields (use null for missing):
{
  "bank_name": "string",
  "department": "Prime/Affordable/Micro/SME/Corporate/Standard/Other",
  "loan_type": "Home Loan/LAP/Business Loan/Balance Transfer/Personal Loan/Working Capital/Other",
  "product_type": "HL/LAP/LRD/BT_TopUp/Commercial_Purchase/Other",
  "loan_min_lakhs": number,
  "loan_max_lakhs": number,
  "roi_min_pct": number,
  "roi_max_pct": number,
  "ltv_pct": number,
  "ltv_min_pct": number,
  "geo_limits_km": number,
  "min_cibil": number,
  "max_tenure_years": number,
  "profiles": ["Salaried", "Self-Employed", "Professional", "NRI"],
  "loan_nature": "Secured/Unsecured/Both",
  "own_house_required": "Yes/No (for business loans - whether borrower must own a house)",
  "max_usl": number (max number of existing unsecured loans allowed, typically 3-5 for BL),
  "processing_fee_pct": number,
  "collateral_types": ["Residential", "Commercial", "Industrial", "Plot/Land", "Warehouse", "Self Occupied", "Let Out", "LRD", "Open Plot", "Hospital", "Hostel/PG", "Hotel", "Lodge", "Bar/Restaurant", "Function Hall", "Shopping Mall", "Cinema Hall", "Multiple Tenant"],
  "special_conditions": "string",
  "banker_name": "string (name of the banker/relationship manager mentioned)",
  "banker_contact": "string (phone number of the banker if mentioned)",
  "has_surrogate_program": true/false,
  "surrogate_types": ["Banking_Surrogate", "GST", "Gross_Turnover", "LIP", "Low_LTV", "ITR/CPM", "EBITDA_Margin", "Pure_Rental", "RTR", "Income_Multiplier", "Hybrid_Mortgage", "Subjective_Cash_Flow", "Gross_Professional_Receipts", "LRD", "Turnover_Linked"]
}

IMPORTANT: Extract loan_min_lakhs even when shown as "Minimum - 50 Lakhs" (separate line from maximum). Capture ALL property types mentioned including specialized ones (hospital, hostel, hotel, lodge, cinema, mall, etc.).

Message:
${text.substring(0, 2000)}`;

    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: 'google/gemini-2.0-flash-001',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 800
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Customer Profiling App'
        },
        timeout: 20000
      }
    );

    const content = response.data.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Clean nulls
      const cleaned = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) {
          cleaned[k] = v;
        }
      }
      return cleaned;
    }
    return {};
  } catch (err) {
    console.error('AI policy extraction error:', err.message);
    return {};
  }
}

// SHA256 hash of file content
function computeFileHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// SHA256 signature of normalized policy fields (for dedup)
function generatePolicySignature(policy) {
  const normalized = [
    (policy.bank_name || '').toLowerCase().trim(),
    (policy.department || '').toLowerCase().trim(),
    (policy.loan_type || '').toLowerCase().trim(),
    (policy.product_type || '').toLowerCase().trim(),
    policy.loan_min_lakhs || 0,
    policy.loan_max_lakhs || 0,
    policy.roi_min_pct || 0,
    policy.roi_max_pct || 0,
    policy.ltv_min_pct || 0,
    policy.geo_limits_km || 0,
    (policy.profiles || []).sort().join(',').toLowerCase()
  ].join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Fuzzy similarity check (95% field match)
function isPolicySimilar(a, b) {
  let matchFields = 0;
  let totalFields = 0;
  const stringFields = ['bank_name', 'department', 'loan_type', 'product_type'];
  const numericFields = ['loan_min_lakhs', 'loan_max_lakhs', 'roi_min_pct', 'roi_max_pct', 'ltv_pct', 'ltv_min_pct', 'min_cibil', 'geo_limits_km'];
  for (const f of stringFields) {
    if (a[f] || b[f]) {
      totalFields++;
      if ((a[f] || '').toLowerCase() === (b[f] || '').toLowerCase()) matchFields++;
    }
  }
  for (const f of numericFields) {
    if (a[f] || b[f]) {
      totalFields++;
      const va = parseFloat(a[f]) || 0;
      const vb = parseFloat(b[f]) || 0;
      if (va === vb || (va > 0 && Math.abs(va - vb) / va < 0.05)) matchFields++;
    }
  }
  return totalFields > 0 && (matchFields / totalFields) >= 0.95;
}

// Main orchestrator: 6-phase pipeline
// Parse → Store Messages → Message Dedup → Filter → Extract+Bank+Surrogates → Policy Dedup & Save
async function processLargeChat(importId, fileContent) {
  const importDoc = await ChatImport.findById(importId);
  if (!importDoc) return;

  try {
    // ===== Phase 1: Parse =====
    importDoc.status = 'parsing';
    importDoc.processing_log.push('Phase 1: Parsing WhatsApp chat...');
    await importDoc.save();

    let { messages, format } = parseWhatsAppChat(fileContent);

    // Fallback: if WhatsApp parser found 0 messages, treat as raw pasted text
    if (messages.length === 0) {
      format = 'Raw Text';
      // Treat entire pasted text as one message to preserve context (bank name, amounts, ROI etc.)
      messages = [{
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        sender: 'Pasted',
        text: fileContent.trim(),
        parsedDate: new Date()
      }];
    }

    importDoc.total_messages = messages.length;
    importDoc.detected_format = format;
    importDoc.processing_log.push(`Found ${messages.length} messages (format: ${format})`);

    if (messages.length > 0 && messages[0].parsedDate) {
      importDoc.chat_date_range = {
        start: messages[0].parsedDate,
        end: messages[messages.length - 1].parsedDate || messages[0].parsedDate
      };
    }
    await importDoc.save();

    // ===== Phase 2: Store Messages =====
    importDoc.status = 'storing_messages';
    importDoc.processing_log.push('Phase 2: Storing individual messages...');
    await importDoc.save();

    let storedCount = 0;
    let msgDupCount = 0;
    const senderSet = new Set();
    const storedMessageIds = new Map(); // index → messageId

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgType = detectMessageType(msg);
      const senderNum = extractSenderNumber(msg.sender);
      const normalized = normalizeContent(msg.text);
      const contentHash = computeContentHash(normalized);
      const relevanceScore = msgType === 'text' ? scorePolicyRelevance(msg.text) : 0;

      if (senderNum) senderSet.add(senderNum);

      try {
        const chatMsg = await ChatMessage.create({
          chat_import_id: importId,
          content_hash: contentHash,
          message_content: msg.text.substring(0, 5000),
          sender_number: senderNum,
          sender_name: msg.sender,
          timestamp: msg.parsedDate,
          message_date_str: msg.date,
          message_type: msgType,
          group_event_type: msgType === 'group_event' ? detectGroupEventType(msg.text) : '',
          policy_relevance_score: relevanceScore
        });
        storedMessageIds.set(i, chatMsg._id);
        storedCount++;
      } catch (err) {
        if (err.code === 11000) {
          // Level 1 dedup: exact hash+sender+date duplicate
          msgDupCount++;
        } else {
          console.error('Message store error:', err.message);
        }
      }

      if (i % 200 === 0 && i > 0) {
        importDoc.processing_log.push(`Stored ${storedCount}/${i + 1} messages (${msgDupCount} L1 dups)`);
        await importDoc.save();
      }
    }

    importDoc.messages_stored = storedCount;
    importDoc.messages_deduplicated = msgDupCount;
    importDoc.unique_senders = senderSet.size;
    importDoc.processing_log.push(`Phase 2 done: ${storedCount} stored, ${msgDupCount} L1 duplicates, ${senderSet.size} unique senders`);
    await importDoc.save();

    // ===== Phase 3: Level 2 Fuzzy Message Dedup =====
    importDoc.processing_log.push('Phase 3: Fuzzy message dedup (Level 2)...');
    await importDoc.save();

    const textMessages = await ChatMessage.find({
      chat_import_id: importId,
      message_type: 'text',
      is_duplicate: false
    }).sort({ timestamp: 1 }).lean();

    let fuzzyDupCount = 0;
    for (let i = 0; i < textMessages.length; i++) {
      if (textMessages[i].is_duplicate) continue;
      for (let j = i + 1; j < textMessages.length; j++) {
        if (textMessages[j].is_duplicate) continue;
        // Same sender + within 24h window
        if (textMessages[i].sender_number !== textMessages[j].sender_number) continue;
        const timeDiff = Math.abs((textMessages[j].timestamp || 0) - (textMessages[i].timestamp || 0));
        if (timeDiff > 24 * 60 * 60 * 1000) break; // Beyond 24h window

        const similarity = computeTextSimilarity(textMessages[i].message_content, textMessages[j].message_content);
        if (similarity >= 0.95) {
          await ChatMessage.findByIdAndUpdate(textMessages[j]._id, {
            is_duplicate: true,
            duplicate_of_message_id: textMessages[i]._id
          });
          textMessages[j].is_duplicate = true;
          fuzzyDupCount++;
        }
      }
    }

    importDoc.messages_deduplicated = msgDupCount + fuzzyDupCount;
    importDoc.processing_log.push(`Phase 3 done: ${fuzzyDupCount} fuzzy duplicates marked`);
    await importDoc.save();

    // ===== Phase 4: Filter relevant messages =====
    importDoc.status = 'extracting';
    importDoc.processing_log.push('Phase 4: Filtering policy-relevant messages...');
    await importDoc.save();

    const isRawText = format === 'Raw Text';
    const relevantMessages = await ChatMessage.find({
      chat_import_id: importId,
      message_type: 'text',
      is_duplicate: false,
      ...(isRawText ? {} : { policy_relevance_score: { $gte: 5 } })
    }).lean();

    importDoc.processing_log.push(`${relevantMessages.length} messages pass relevance filter${isRawText ? ' (raw text mode - no threshold)' : ''}`);
    await importDoc.save();

    // ===== Phase 5: Extract Policies + Banks + Surrogates =====
    importDoc.processing_log.push('Phase 5: Extracting policies, banks & surrogates...');
    await importDoc.save();

    const extractedPolicies = [];
    let aiCallCount = 0;
    const AI_LIMIT = 50;
    const banksIdentified = new Set();
    let surrogateCount = 0;

    for (let i = 0; i < relevantMessages.length; i++) {
      const msg = relevantMessages[i];
      const msgText = msg.message_content || '';

      // Regex extraction (may return multiple policies for multi-product messages)
      let policies = regexExtractPolicies(msgText);

      // For raw pasted text: accept policies without bank_name if they have useful fields
      policies = policies.map(policy => {
        const hasUsefulFields = policy.loan_type || policy.roi_min_pct || policy.loan_min_lakhs || policy.loan_max_lakhs || policy.ltv_pct || policy.min_cibil;
        if (!policy.bank_name && isRawText && hasUsefulFields) {
          policy.bank_name = 'Unknown Bank';
        }
        return policy;
      });

      const hasBank = policies.some(p => p.bank_name);
      if (hasBank) {
        // Extract surrogate programs once per message
        const surrogates = extractSurrogatePrograms(msgText);

        for (const policy of policies) {
          if (!policy.bank_name) continue;
          const bank = await findOrCreateBank(policy.bank_name, msg.sender_name, msg.timestamp);
          if (bank) {
            banksIdentified.add(bank._id.toString());
            policy.bank_id = bank._id;
          }
          policy.message_id = msg._id;
          policy.policy_label = generatePolicyLabel(policy);

          // Use sender as banker if not extracted from text
          if (!policy.banker_name && msg.sender_name && msg.sender_name !== 'Pasted') {
            const cleanSender = msg.sender_name.replace(/\+?\d[\d\s-]{8,}/g, '').trim();
            if (cleanSender) policy.banker_name = cleanSender;
          }
          if (!policy.banker_contact && msg.sender_number) {
            policy.banker_contact = msg.sender_number;
          }

          extractedPolicies.push({
            ...policy,
            message_date: msg.timestamp,
            sender_name: msg.sender_name,
            raw_message_text: msgText.substring(0, 2000)
          });

          for (const prog of surrogates) {
            const sig = generateProgramSignature(prog, policy.bank_name, prog.program_type);
            try {
              await SurrogateProgram.create({
                bank_id: bank ? bank._id : null,
                message_id: msg._id,
                program_signature: sig,
                program_type: prog.program_type,
                program_loan_limit_lakhs: prog.program_loan_limit_lakhs,
                abb_multiplier: prog.abb_multiplier,
                margin_pct: prog.margin_pct,
                dsra_months: prog.dsra_months,
                program_details: prog.program_details,
                bank_name: policy.bank_name,
                loan_type: policy.loan_type
              });
              surrogateCount++;
            } catch (err) {
              if (err.code !== 11000) console.error('Surrogate save error:', err.message);
            }
          }
        }
      } else if (msg.policy_relevance_score >= 10 && aiCallCount < AI_LIMIT) {
        aiCallCount++;
        const aiPolicy = await aiExtractPolicy(msgText);
        if (aiPolicy.bank_name) {
          const bank = await findOrCreateBank(aiPolicy.bank_name, msg.sender_name, msg.timestamp);
          if (bank) {
            banksIdentified.add(bank._id.toString());
            aiPolicy.bank_id = bank._id;
          }
          aiPolicy.message_id = msg._id;
          if (!aiPolicy.product_type && aiPolicy.loan_type) {
            aiPolicy.product_type = mapToProductType(aiPolicy.loan_type);
          }
          aiPolicy.policy_label = generatePolicyLabel(aiPolicy);

          // Use sender as banker if not extracted by AI
          if (!aiPolicy.banker_name && msg.sender_name && msg.sender_name !== 'Pasted') {
            const cleanSender = msg.sender_name.replace(/\+?\d[\d\s-]{8,}/g, '').trim();
            if (cleanSender) aiPolicy.banker_name = cleanSender;
          }
          if (!aiPolicy.banker_contact && msg.sender_number) {
            aiPolicy.banker_contact = msg.sender_number;
          }

          extractedPolicies.push({
            ...aiPolicy,
            message_date: msg.timestamp,
            sender_name: msg.sender_name,
            raw_message_text: msgText.substring(0, 2000)
          });

          // Check AI-detected surrogates
          if (aiPolicy.has_surrogate_program) {
            const surrogates = extractSurrogatePrograms(msgText);
            for (const prog of surrogates) {
              const sig = generateProgramSignature(prog, aiPolicy.bank_name, prog.program_type);
              try {
                await SurrogateProgram.create({
                  bank_id: bank ? bank._id : null,
                  message_id: msg._id,
                  program_signature: sig,
                  program_type: prog.program_type,
                  program_loan_limit_lakhs: prog.program_loan_limit_lakhs,
                  abb_multiplier: prog.abb_multiplier,
                  margin_pct: prog.margin_pct,
                  dsra_months: prog.dsra_months,
                  program_details: prog.program_details,
                  bank_name: aiPolicy.bank_name,
                  loan_type: aiPolicy.loan_type
                });
                surrogateCount++;
              } catch (err) {
                if (err.code !== 11000) console.error('Surrogate save error:', err.message);
              }
            }
          }
        }
      }

      if (i % 50 === 0 && i > 0) {
        importDoc.processing_log.push(`Processed ${i}/${relevantMessages.length} messages (${extractedPolicies.length} policies, ${aiCallCount} AI calls, ${surrogateCount} surrogates)`);
        await importDoc.save();
      }
    }

    importDoc.policies_extracted = extractedPolicies.length;
    importDoc.banks_identified = banksIdentified.size;
    importDoc.surrogates_extracted = surrogateCount;
    importDoc.processing_log.push(`Phase 5 done: ${extractedPolicies.length} policies, ${banksIdentified.size} banks, ${surrogateCount} surrogates (${aiCallCount} AI calls)`);
    await importDoc.save();

    // ===== Phase 6: Policy Dedup & Save =====
    importDoc.status = 'saving';
    importDoc.processing_log.push('Phase 6: Deduplicating and saving policies...');
    await importDoc.save();

    let dupCount = 0;
    const existingPolicies = await BankPolicy.find({ is_deleted: false }).lean();

    for (let batchStart = 0; batchStart < extractedPolicies.length; batchStart += 50) {
      const batch = extractedPolicies.slice(batchStart, batchStart + 50);
      const toInsert = [];

      for (const policy of batch) {
        const signature = generatePolicySignature(policy);

        // Level 3a: Exact signature dedup
        const existingExact = await BankPolicy.findOne({ policy_signature: signature });
        if (existingExact) {
          if (existingExact.is_deleted) {
            // Restore deleted policy with fresh data
            await BankPolicy.findByIdAndUpdate(existingExact._id, {
              ...policy,
              policy_signature: signature,
              chat_import_id: importId,
              is_deleted: false,
              deleted_at: null
            });
            existingPolicies.push(policy);
          } else {
            // Link surrogate programs to existing active policy
            if (policy.bank_id) {
              await SurrogateProgram.updateMany(
                { message_id: policy.message_id, product_id: null },
                { $set: { product_id: existingExact._id } }
              );
            }
            dupCount++;
          }
          continue;
        }

        // Level 3b: Fuzzy dedup
        const isFuzzyDup = existingPolicies.some(ep => isPolicySimilar(ep, policy));
        if (isFuzzyDup) { dupCount++; continue; }

        toInsert.push({
          ...policy,
          policy_signature: signature,
          chat_import_id: importId
        });
        existingPolicies.push(policy);
      }

      if (toInsert.length > 0) {
        try {
          const inserted = await BankPolicy.insertMany(toInsert, { ordered: false });
          // Link surrogate programs to newly created policies
          for (const doc of inserted) {
            if (doc.message_id) {
              await SurrogateProgram.updateMany(
                { message_id: doc.message_id, product_id: null },
                { $set: { product_id: doc._id } }
              );
            }
          }
        } catch (bulkErr) {
          if (bulkErr.code === 11000) {
            dupCount += (bulkErr.writeErrors || []).length;
          } else {
            console.error('Bulk insert error:', bulkErr.message);
          }
        }
      }
    }

    importDoc.policies_deduplicated = dupCount;
    importDoc.status = 'completed';
    importDoc.processing_log.push(`Done! ${extractedPolicies.length - dupCount} new policies saved, ${dupCount} duplicates skipped, ${banksIdentified.size} banks, ${surrogateCount} surrogates`);
    await importDoc.save();

  } catch (err) {
    console.error('Chat processing error:', err);
    importDoc.status = 'failed';
    importDoc.error_message = err.message;
    importDoc.processing_log.push('ERROR: ' + err.message);
    await importDoc.save();
  }
}

// Split OCR text into manageable chunks for policy extraction
function splitDocumentIntoChunks(text) {
  const MAX_CHUNK = 2500;
  if (text.length <= MAX_CHUNK) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_CHUNK && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += (current ? '\n\n' : '') + para;
  }
  if (current.trim()) chunks.push(current.trim());

  // Prepend full text context (truncated) as first chunk if multiple chunks
  if (chunks.length > 1) {
    const contextChunk = text.substring(0, 3000);
    chunks.unshift(contextChunk);
  }

  return chunks;
}

// Process image/PDF document import: OCR → Store → Extract → Dedup
async function processDocumentImport(importId, filePath, fileType) {
  const importDoc = await ChatImport.findById(importId);
  if (!importDoc) return;

  try {
    // ===== Phase 1: OCR =====
    importDoc.status = 'ocr_extracting';
    importDoc.processing_log.push('Phase 1: Running OCR on ' + fileType + ' file...');
    await importDoc.save();

    let ocrResult;
    if (fileType === 'pdf') {
      ocrResult = await extractAllPagesWithVisionOCR(filePath);
    } else {
      ocrResult = await extractTextFromImage(filePath);
    }

    if (!ocrResult.success || !ocrResult.text || ocrResult.text.trim().length < 10) {
      importDoc.status = 'failed';
      importDoc.error_message = 'OCR failed to extract text from document';
      importDoc.processing_log.push('ERROR: OCR returned no usable text' + (ocrResult.error ? ' - ' + ocrResult.error : ''));
      await importDoc.save();
      return;
    }

    const extractedText = ocrResult.text.trim();
    importDoc.processing_log.push('Phase 1 done: ' + extractedText.length + ' characters extracted via ' + ocrResult.method);
    await importDoc.save();

    // ===== Phase 2: Store as ChatMessage =====
    importDoc.status = 'storing_messages';
    importDoc.processing_log.push('Phase 2: Storing extracted text as message...');
    await importDoc.save();

    const contentHash = crypto.createHash('sha256').update(extractedText).digest('hex');
    let storedMsg;
    try {
      storedMsg = await ChatMessage.create({
        chat_import_id: importId,
        content_hash: contentHash,
        message_content: extractedText,
        sender_number: 'OCR',
        sender_name: 'Document OCR',
        timestamp: new Date(),
        message_date_str: new Date().toISOString().split('T')[0],
        message_type: 'text',
        is_duplicate: false,
        policy_relevance_score: 100
      });
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        importDoc.processing_log.push('Message already exists (content hash match), using existing');
        storedMsg = await ChatMessage.findOne({ chat_import_id: importId, content_hash: contentHash });
      } else {
        throw dupErr;
      }
    }

    importDoc.total_messages = 1;
    importDoc.messages_stored = 1;
    importDoc.processing_log.push('Phase 2 done: Message stored');
    await importDoc.save();

    // ===== Phase 3: Extract Policies + Banks + Surrogates =====
    importDoc.status = 'extracting';
    importDoc.processing_log.push('Phase 3: Extracting policies from OCR text...');
    await importDoc.save();

    const chunks = splitDocumentIntoChunks(extractedText);
    importDoc.processing_log.push('Split into ' + chunks.length + ' chunk(s) for extraction');
    await importDoc.save();

    const extractedPolicies = [];
    let aiCallCount = 0;
    const AI_LIMIT = 10;
    const banksIdentified = new Set();
    let surrogateCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];

      // Regex extraction first
      let policies = regexExtractPolicies(chunkText);

      // Accept policies without bank_name if they have useful fields (OCR text mode)
      policies = policies.map(policy => {
        const hasUsefulFields = policy.loan_type || policy.roi_min_pct || policy.loan_min_lakhs || policy.loan_max_lakhs || policy.ltv_pct || policy.min_cibil;
        if (!policy.bank_name && hasUsefulFields) {
          policy.bank_name = 'Unknown Bank';
        }
        return policy;
      });

      const hasBank = policies.some(p => p.bank_name);
      if (hasBank) {
        const surrogates = extractSurrogatePrograms(chunkText);

        for (const policy of policies) {
          if (!policy.bank_name) continue;
          const bank = await findOrCreateBank(policy.bank_name, 'Document OCR', new Date());
          if (bank) {
            banksIdentified.add(bank._id.toString());
            policy.bank_id = bank._id;
          }
          policy.message_id = storedMsg._id;
          if (!policy.product_type && policy.loan_type) {
            policy.product_type = mapToProductType(policy.loan_type);
          }
          policy.policy_label = generatePolicyLabel(policy);

          extractedPolicies.push({
            ...policy,
            message_date: new Date(),
            sender_name: 'Document OCR',
            raw_message_text: chunkText.substring(0, 2000)
          });

          for (const prog of surrogates) {
            const sig = generateProgramSignature(prog, policy.bank_name, prog.program_type);
            try {
              await SurrogateProgram.create({
                bank_id: bank ? bank._id : null,
                message_id: storedMsg._id,
                program_signature: sig,
                program_type: prog.program_type,
                program_loan_limit_lakhs: prog.program_loan_limit_lakhs,
                abb_multiplier: prog.abb_multiplier,
                margin_pct: prog.margin_pct,
                dsra_months: prog.dsra_months,
                program_details: prog.program_details,
                bank_name: policy.bank_name,
                loan_type: policy.loan_type
              });
              surrogateCount++;
            } catch (err) {
              if (err.code !== 11000) console.error('Surrogate save error:', err.message);
            }
          }
        }
      } else if (aiCallCount < AI_LIMIT) {
        // AI fallback extraction
        aiCallCount++;
        const aiPolicy = await aiExtractPolicy(chunkText);
        if (aiPolicy.bank_name) {
          const bank = await findOrCreateBank(aiPolicy.bank_name, 'Document OCR', new Date());
          if (bank) {
            banksIdentified.add(bank._id.toString());
            aiPolicy.bank_id = bank._id;
          }
          aiPolicy.message_id = storedMsg._id;
          if (!aiPolicy.product_type && aiPolicy.loan_type) {
            aiPolicy.product_type = mapToProductType(aiPolicy.loan_type);
          }
          aiPolicy.policy_label = generatePolicyLabel(aiPolicy);

          extractedPolicies.push({
            ...aiPolicy,
            message_date: new Date(),
            sender_name: 'Document OCR',
            raw_message_text: chunkText.substring(0, 2000)
          });

          if (aiPolicy.has_surrogate_program) {
            const surrogates = extractSurrogatePrograms(chunkText);
            for (const prog of surrogates) {
              const sig = generateProgramSignature(prog, aiPolicy.bank_name, prog.program_type);
              try {
                await SurrogateProgram.create({
                  bank_id: bank ? bank._id : null,
                  message_id: storedMsg._id,
                  program_signature: sig,
                  program_type: prog.program_type,
                  program_loan_limit_lakhs: prog.program_loan_limit_lakhs,
                  abb_multiplier: prog.abb_multiplier,
                  margin_pct: prog.margin_pct,
                  dsra_months: prog.dsra_months,
                  program_details: prog.program_details,
                  bank_name: aiPolicy.bank_name,
                  loan_type: aiPolicy.loan_type
                });
                surrogateCount++;
              } catch (err) {
                if (err.code !== 11000) console.error('Surrogate save error:', err.message);
              }
            }
          }
        }
      }

      if (chunks.length > 1) {
        importDoc.processing_log.push('Chunk ' + (i + 1) + '/' + chunks.length + ': ' + extractedPolicies.length + ' policies so far (' + aiCallCount + ' AI calls)');
        await importDoc.save();
      }
    }

    importDoc.policies_extracted = extractedPolicies.length;
    importDoc.banks_identified = banksIdentified.size;
    importDoc.surrogates_extracted = surrogateCount;
    importDoc.processing_log.push('Phase 3 done: ' + extractedPolicies.length + ' policies, ' + banksIdentified.size + ' banks, ' + surrogateCount + ' surrogates (' + aiCallCount + ' AI calls)');
    await importDoc.save();

    // ===== Phase 4: Policy Dedup & Save (same as Phase 6 of processLargeChat) =====
    importDoc.status = 'saving';
    importDoc.processing_log.push('Phase 4: Deduplicating and saving policies...');
    await importDoc.save();

    let dupCount = 0;
    const existingPolicies = await BankPolicy.find({ is_deleted: false }).lean();

    for (let batchStart = 0; batchStart < extractedPolicies.length; batchStart += 50) {
      const batch = extractedPolicies.slice(batchStart, batchStart + 50);
      const toInsert = [];

      for (const policy of batch) {
        const signature = generatePolicySignature(policy);

        const existingExact = await BankPolicy.findOne({ policy_signature: signature });
        if (existingExact) {
          if (existingExact.is_deleted) {
            await BankPolicy.findByIdAndUpdate(existingExact._id, {
              ...policy,
              policy_signature: signature,
              chat_import_id: importId,
              is_deleted: false,
              deleted_at: null
            });
            existingPolicies.push(policy);
          } else {
            if (policy.bank_id) {
              await SurrogateProgram.updateMany(
                { message_id: policy.message_id, product_id: null },
                { $set: { product_id: existingExact._id } }
              );
            }
            dupCount++;
          }
          continue;
        }

        const isFuzzyDup = existingPolicies.some(ep => isPolicySimilar(ep, policy));
        if (isFuzzyDup) { dupCount++; continue; }

        toInsert.push({
          ...policy,
          policy_signature: signature,
          chat_import_id: importId
        });
        existingPolicies.push(policy);
      }

      if (toInsert.length > 0) {
        try {
          const inserted = await BankPolicy.insertMany(toInsert, { ordered: false });
          for (const doc of inserted) {
            if (doc.message_id) {
              await SurrogateProgram.updateMany(
                { message_id: doc.message_id, product_id: null },
                { $set: { product_id: doc._id } }
              );
            }
          }
        } catch (bulkErr) {
          if (bulkErr.code === 11000) {
            dupCount += (bulkErr.writeErrors || []).length;
          } else {
            console.error('Bulk insert error:', bulkErr.message);
          }
        }
      }
    }

    importDoc.policies_deduplicated = dupCount;
    importDoc.status = 'completed';
    importDoc.processing_log.push('Done! ' + (extractedPolicies.length - dupCount) + ' new policies saved, ' + dupCount + ' duplicates skipped, ' + banksIdentified.size + ' banks, ' + surrogateCount + ' surrogates');
    await importDoc.save();

  } catch (err) {
    console.error('Document import processing error:', err);
    importDoc.status = 'failed';
    importDoc.error_message = err.message;
    importDoc.processing_log.push('ERROR: ' + err.message);
    await importDoc.save();
  }
}

// Banker matching algorithm: score policies against a proposal
function findMatchingPolicies(proposal, policies) {
  const loanAmountLakhs = (parseFloat(proposal.loanAmount) || 0) / 100000;
  const proposalLoanType = (proposal.typeOfLoan || '').toLowerCase();
  const proposalNature = (proposal.natureOfLoan || '').toLowerCase();
  const proposalType = (proposal.applicantType || '').toLowerCase();

  // Determine applicant profile from type
  let applicantProfile = 'Self-Employed';
  if (proposalType.includes('individual') || proposalType.includes('salaried')) {
    applicantProfile = 'Salaried';
  }
  if (proposalType.includes('professional')) {
    applicantProfile = 'Professional';
  }

  // Get CIBIL score from documents
  let cibilScore = null;
  if (proposal.documents) {
    for (const doc of proposal.documents) {
      if (doc.extractedDetails && doc.extractedDetails.cibilScore) {
        cibilScore = parseInt(doc.extractedDetails.cibilScore);
        break;
      }
    }
  }

  const results = [];

  for (const policy of policies) {
    let score = 0;
    const matchReasons = [];
    const disqualifyReasons = [];

    // 1. Loan Amount (30 points)
    if (policy.loan_min_lakhs && policy.loan_max_lakhs) {
      if (loanAmountLakhs >= policy.loan_min_lakhs && loanAmountLakhs <= policy.loan_max_lakhs) {
        score += 30;
        matchReasons.push('Loan amount in range');
      } else if (loanAmountLakhs < policy.loan_min_lakhs) {
        disqualifyReasons.push(`Min amount: ${policy.loan_min_lakhs}L (need ${Math.round(loanAmountLakhs)}L)`);
      } else {
        disqualifyReasons.push(`Max amount: ${policy.loan_max_lakhs}L (need ${Math.round(loanAmountLakhs)}L)`);
      }
    } else if (policy.loan_max_lakhs) {
      if (loanAmountLakhs <= policy.loan_max_lakhs) {
        score += 20;
        matchReasons.push('Within max loan limit');
      } else {
        disqualifyReasons.push(`Max: ${policy.loan_max_lakhs}L`);
      }
    } else {
      score += 10; // No amount constraint = partial match
    }

    // 2. Profile Match (25 points)
    if (policy.profiles && policy.profiles.length > 0) {
      const policyProfiles = policy.profiles.map(p => p.toLowerCase());
      if (policyProfiles.some(p => applicantProfile.toLowerCase().includes(p) || p.includes(applicantProfile.toLowerCase()))) {
        score += 25;
        matchReasons.push('Profile matches');
      } else {
        disqualifyReasons.push(`Profiles: ${policy.profiles.join(', ')}`);
      }
    } else {
      score += 15; // No profile constraint
    }

    // 3. Loan Type (20 points)
    if (policy.loan_type) {
      const policyType = policy.loan_type.toLowerCase();
      if (proposalLoanType.includes(policyType) || policyType.includes(proposalLoanType) ||
          (proposalLoanType.includes('business') && policyType.includes('business')) ||
          (proposalLoanType.includes('home') && policyType.includes('home')) ||
          (proposalLoanType.includes('property') && policyType.includes('lap'))) {
        score += 20;
        matchReasons.push('Loan type matches');
      } else {
        score += 5; // Different type but might still work
        disqualifyReasons.push(`Type: ${policy.loan_type}`);
      }
    } else {
      score += 10;
    }

    // 4. CIBIL (15 points)
    if (cibilScore && policy.min_cibil) {
      if (cibilScore >= policy.min_cibil) {
        score += 15;
        matchReasons.push(`CIBIL ${cibilScore} >= ${policy.min_cibil}`);
      } else {
        disqualifyReasons.push(`Min CIBIL: ${policy.min_cibil} (have ${cibilScore})`);
      }
    } else if (!policy.min_cibil) {
      score += 10;
    }

    // 5. ROI competitiveness (10 points)
    if (policy.roi_min_pct) {
      if (policy.roi_min_pct <= 12) {
        score += 10;
        matchReasons.push(`ROI from ${policy.roi_min_pct}%`);
      } else if (policy.roi_min_pct <= 16) {
        score += 5;
        matchReasons.push(`ROI from ${policy.roi_min_pct}%`);
      } else {
        score += 2;
        disqualifyReasons.push(`High ROI: ${policy.roi_min_pct}%`);
      }
    } else {
      score += 5;
    }

    // Loan nature bonus
    if (proposalNature && policy.loan_nature) {
      const pn = policy.loan_nature.toLowerCase();
      if (pn === 'both' || pn === proposalNature) {
        score += 5;
        matchReasons.push('Loan nature matches');
      }
    }

    results.push({
      bank_name: policy.bank_name,
      bank_id: policy.bank_id || null,
      department: policy.department,
      loan_type: policy.loan_type,
      product_type: policy.product_type || '',
      policy_id: policy._id,
      loan_min_lakhs: policy.loan_min_lakhs,
      loan_max_lakhs: policy.loan_max_lakhs,
      roi_min_pct: policy.roi_min_pct,
      roi_max_pct: policy.roi_max_pct,
      ltv_pct: policy.ltv_pct,
      ltv_min_pct: policy.ltv_min_pct,
      geo_limits_km: policy.geo_limits_km,
      min_cibil: policy.min_cibil,
      max_tenure_years: policy.max_tenure_years,
      policy_label: policy.policy_label,
      programs: policy.programs || [],
      other_remarks: policy.other_remarks || '',
      banker_name: policy.banker_name || '',
      banker_contact: policy.banker_contact || '',
      surrogate_matches: policy._surrogateIds || [],
      match_score: Math.min(score, 100),
      match_reasons: matchReasons,
      disqualify_reasons: disqualifyReasons,
      status: 'matched'
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.match_score - a.match_score);
  return results;
}

// ========== END STAGE 4 UTILITIES ==========

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
  'Encumberance Certificate',
  'Property Photos'
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
  
  // Salary Documents keywords
  if (lowerName.includes('payslip') || lowerName.includes('pay slip') || lowerName.includes('salary slip')) {
    return 'salaryDocuments';
  }
  if (lowerName.includes('form 16') || lowerName.includes('form16')) {
    return 'salaryDocuments';
  }
  if (lowerName.includes('offer letter') || lowerName.includes('offerletter') || lowerName.includes('appointment letter')) {
    return 'salaryDocuments';
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
  if (lowerName.includes('property') && lowerName.includes('photo')) {
    return 'collateral';
  }
  
  // ---- Text-based categorization (when filename doesn't match) ----
  if (lowerText) {
    // GST Returns (GSTR-3B / GSTR-1)
    if (lowerText.includes('gstr-3b') || lowerText.includes('gstr 3b') || lowerText.includes('form gstr-3b') || lowerText.includes('gstr3b')) {
      return 'turnover';
    }
    if (lowerText.includes('gstr-1') || lowerText.includes('gstr 1') || lowerText.includes('form gstr-1') || lowerText.includes('gstr1')) {
      return 'turnover';
    }
    if (lowerText.includes('goods and services tax') && (lowerText.includes('return') || lowerText.includes('turnover'))) {
      return 'turnover';
    }

    // GST Certificate
    if (lowerText.includes('goods and services tax') && lowerText.includes('certificate') && !lowerText.includes('return')) {
      return 'businessId';
    }
    if (lowerText.includes('gstin') && lowerText.includes('registration') && !lowerText.includes('return')) {
      return 'businessId';
    }

    // ITR / Financial documents
    if (lowerText.includes('income tax return') || lowerText.includes('acknowledgement number') && lowerText.includes('itr')) {
      return 'financials';
    }
    if (lowerText.includes('form 26as') || lowerText.includes('tax credit statement')) {
      return 'financials';
    }
    if (lowerText.includes('computation of income') || lowerText.includes('profit and loss') || lowerText.includes('balance sheet')) {
      return 'financials';
    }

    // Bank Statements
    if (lowerText.includes('account statement') || lowerText.includes('bank statement') || lowerText.includes('statement of account')) {
      return 'banking';
    }

    // PAN Card
    if (lowerText.includes('permanent account number') || lowerText.includes('income tax department') && lowerText.includes('pan')) {
      return 'personalId';
    }

    // Aadhaar
    if (lowerText.includes('unique identification authority') || lowerText.includes('aadhaar') || lowerText.includes('aadhar')) {
      return 'personalId';
    }

    // Credit Report
    if (lowerText.includes('cibil') || lowerText.includes('credit score') || lowerText.includes('credit information report') || lowerText.includes('equifax') || lowerText.includes('experian') || lowerText.includes('crif')) {
      return 'creditReports';
    }

    // UDYAM / MSME
    if (lowerText.includes('udyam registration') || lowerText.includes('udyam certificate') || lowerText.includes('msme certificate')) {
      return 'businessId';
    }
  }

  // Default: uncategorized
  return '';
}

// AI-based document categorization using OpenRouter GPT-4o-mini
async function aiCategorizeDocument(extractedText, filename) {
  if (!process.env.OPENROUTER_API_KEY || !extractedText) {
    return '';
  }

  const prompt = `You are a document categorizer for a loan application system in India.

Based on the document content below, determine which ONE category this document belongs to:

1. personalId — PAN Card, Aadhar Card, Passport, Voter ID, Driving License, Passport-size Photo
2. businessId — GST Registration Certificate, Labour License, UDYAM/MSME Certificate, Firm Registration, Non-individual PAN, Shop & Establishment, FSSAI License
3. incorporation — Partnership Deed, MOA, AOA, Certificate of Incorporation, Shareholder List, Director List, Board Resolution
4. creditReports — CIBIL report, Experian report, Equifax report, CRIF report, Credit Information Report
5. salaryDocuments — Payslips, Salary Slips, Form 16, Offer Letters, Appointment Letters
6. financials — Income Tax Return (ITR), Form 26AS, Tax Audit Report, Profit & Loss Statement, Balance Sheet, Computation of Income
7. banking — Bank Statements, Account Statements, Passbook
8. turnover — GST 3B Returns, GSTR-3B, GST R1 Returns, GSTR-1, GST Annual Return
9. debtProfile — Loan Sanction Letters, EMI Schedules, Loan Account Statements, Outstanding Loan Details
10. otherIncome — Rental Agreement, Lease Deed, Rent Receipts, Dividend Statements
11. collateral — Title Documents, Property Tax Receipts, Encumbrance Certificate, 7/12 Extract, 8A Extract, Sale Deed, Property Documents

Document filename: ${filename}
Document content (first 2000 characters):
${extractedText.substring(0, 2000)}

Respond with ONLY the category key (e.g., "financials", "banking", "turnover") from the list above. If you cannot determine the category, respond with "UNKNOWN".`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/copilot',
        'X-Title': 'Document Categorizer'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const result = data.choices[0]?.message?.content?.trim().toLowerCase() || '';

    const validCategories = [
      'personalId', 'businessId', 'incorporation', 'creditReports',
      'salaryDocuments', 'financials', 'banking', 'turnover',
      'debtProfile', 'otherIncome', 'collateral'
    ];

    // Exact match (case-insensitive)
    const match = validCategories.find(c => c.toLowerCase() === result.replace(/[^a-z]/g, ''));
    if (match) {
      return match;
    }

    // Partial match — check if AI response contains a valid category
    for (const cat of validCategories) {
      if (result.includes(cat.toLowerCase())) {
        return cat;
      }
    }

    return '';
  } catch (error) {
    console.error('AI categorization API error:', error.message);
    return '';
  }
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
  // Normalize co-applicant types: default empty/missing type to 'Individual'
  if (proposal.coApplicants) {
    proposal.coApplicants.forEach(co => { if (!co.type) co.type = 'Individual'; });
  }
  
  switch (category) {
    case 'personalId':
      if (proposal.applicantType === 'Individual' || proposal.applicantType === 'Individual Salaried') {
        docTypes.push(`PAN Card of ${applicantName}`);
        docTypes.push(`Aadhar Card of ${applicantName}`);
        docTypes.push(`Passport Photo of ${applicantName}`);
      }
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if ((co.type === 'Individual' || co.type === 'Individual Salaried' || co.type === 'Proprietorship') && co.name) {
            docTypes.push(`PAN Card of ${co.name}`);
            docTypes.push(`Aadhar Card of ${co.name}`);
            docTypes.push(`Passport Photo of ${co.name}`);
          }
        });
      }
      break;

    case 'salaryDocuments':
      if (proposal.applicantType === 'Individual Salaried') {
        docTypes.push(`3 Months Payslips of ${applicantName}`);
        docTypes.push(`2 Years Form 16 of ${applicantName}`);
        docTypes.push(`Offer Letter of ${applicantName}`);
      }
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type === 'Individual Salaried' && co.name) {
            docTypes.push(`3 Months Payslips of ${co.name}`);
            docTypes.push(`2 Years Form 16 of ${co.name}`);
            docTypes.push(`Offer Letter of ${co.name}`);
          }
        });
      }
      break;

    case 'businessId':
      if (proposal.applicantType !== 'Individual' && proposal.applicantType !== 'Individual Salaried') {
        docTypes.push(`PAN Card of ${applicantName} (Non Individual)`);
        docTypes.push(`GST Certificate of ${applicantName}`);
        docTypes.push(`Labour License of ${applicantName}`);
        docTypes.push(`UDYAM Certificate of ${applicantName}`);
        if (proposal.applicantType === 'Partnership' || proposal.applicantType === 'LLP') {
          docTypes.push(`Firm Registration Certificate of ${applicantName}`);
        }
      }
      // Business documents for non-individual co-applicants
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.type !== 'Individual' && co.type !== 'Individual Salaried' && co.name) {
            if (co.type !== 'Proprietorship') {
              docTypes.push(`PAN Card of ${co.name} (Non Individual)`);
            }
            docTypes.push(`GST Certificate of ${co.name}`);
            docTypes.push(`UDYAM Certificate of ${co.name}`);
            if (co.type === 'Partnership' || co.type === 'LLP') {
              docTypes.push(`Firm Registration Certificate of ${co.name}`);
            }
          }
        });
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
        docTypes.push(`List of Shareholders of ${applicantName}`);
        docTypes.push(`List of Directors of ${applicantName}`);
      }
      // Incorporation documents for co-applicants based on their own type
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach((co, idx) => {
          if (co.type === 'Partnership') {
            docTypes.push(`Partnership deed of ${co.name || 'CoApplicant ' + (idx + 1)}`);
          } else if (co.type === 'LLP') {
            docTypes.push(`LLP Agreement of ${co.name || 'CoApplicant ' + (idx + 1)}`);
          } else if (co.type === 'Private Limited' || co.type === 'Public Limited') {
            docTypes.push(`Certificate of Incorporation of ${co.name || 'CoApplicant ' + (idx + 1)}`);
            docTypes.push(`List of Shareholders of ${co.name || 'CoApplicant ' + (idx + 1)}`);
            docTypes.push(`List of Directors of ${co.name || 'CoApplicant ' + (idx + 1)}`);
          }
        });
      }
      break;
      
    case 'creditReports':
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if ((co.type === 'Individual' || co.type === 'Individual Salaried' || co.type === 'Proprietorship') && co.name) {
            docTypes.push(`Personal Credit Report of ${co.name}`);
          } else if (co.name) {
            docTypes.push(`Business Credit Report of ${co.name}`);
          }
        });
      }
      if (proposal.applicantType !== 'Individual' && proposal.applicantType !== 'Individual Salaried') {
        docTypes.push(`Business Credit Report of ${applicantName}`);
      }
      break;
      
    case 'financials':
      docTypes.push(`ITR of Current Year of ${applicantName}`);
      docTypes.push(`ITR of Previous Year of ${applicantName}`);
      docTypes.push(`ITR of Preceding previous year of ${applicantName}`);
      if (proposal.coApplicants && proposal.coApplicants.length > 0) {
        proposal.coApplicants.forEach(co => {
          if (co.name) {
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
          if (co.name) {
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
      
    case 'otherIncome':
      docTypes.push('Rental Agreement / Lease Deed');
      docTypes.push('Rent Receipts / Bank Credit Proof');
      docTypes.push('List of Properties with Rental Income');
      break;

    case 'collateral':
      docTypes.push('Title Documents');
      docTypes.push('Tax paid Receipts');
      docTypes.push('Approved Sanction Plan');
      docTypes.push('Encumberance Certificate');
      docTypes.push('Title Documents - Unregistered');
      break;

    case 'otherDocuments':
      docTypes.push('Group Company Financials');
      docTypes.push('Group Company ITR');
      docTypes.push('Other Supporting Documents');
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
      
    case 'salaryDocuments':
      if (lowerName.includes('payslip') || lowerName.includes('pay slip') || lowerName.includes('salary slip')) {
        return docTypes.find(d => d.includes('Payslips')) || '';
      }
      if (lowerName.includes('form 16') || lowerName.includes('form16')) {
        return docTypes.find(d => d.includes('Form 16')) || '';
      }
      if (lowerName.includes('offer letter') || lowerName.includes('offerletter') || lowerName.includes('appointment')) {
        return docTypes.find(d => d.includes('Offer Letter')) || '';
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
      
    case 'otherIncome':
      if (lowerName.includes('lease') || lowerName.includes('rental agreement') ||
          lowerText.includes('lease deed') || lowerText.includes('rental agreement') ||
          lowerText.includes('lease agreement')) {
        return 'Rental Agreement / Lease Deed';
      }
      if (lowerName.includes('rent receipt') || lowerName.includes('bank credit') ||
          lowerText.includes('rent receipt') || lowerText.includes('rental receipt')) {
        return 'Rent Receipts / Bank Credit Proof';
      }
      if (lowerName.includes('propert') || lowerName.includes('rental income') ||
          lowerText.includes('rental income') || lowerText.includes('list of properties') ||
          lowerText.includes('property income')) {
        return 'List of Properties with Rental Income';
      }
      // Default: classify as first matching doc type based on any rental/income keywords
      if (lowerText.includes('rent') || lowerText.includes('lease') || lowerText.includes('tenant')) {
        return 'Rental Agreement / Lease Deed';
      }
      break;

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

    case 'otherDocuments':
      if (lowerName.includes('group') && (lowerName.includes('financial') || lowerName.includes('itr'))) {
        if (lowerName.includes('itr') || lowerText.includes('income tax return') || lowerText.includes('assessment year')) {
          return 'Group Company ITR';
        }
        return 'Group Company Financials';
      }
      if (lowerText.includes('income tax return') || lowerText.includes('assessment year') || lowerText.includes('computation of income')) {
        return 'Group Company ITR';
      }
      if (lowerText.includes('profit and loss') || lowerText.includes('balance sheet') || lowerText.includes('revenue from operations')) {
        return 'Group Company Financials';
      }
      return 'Other Supporting Documents';
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
async function extractWithPdfplumber(pdfPath, extractTables = false) {
  console.log('🔹 Tier 2: Attempting pdfplumber extraction...');
  if (extractTables) {
    console.log('📊 Table extraction ENABLED');
  }

  return new Promise((resolve, reject) => {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const args = ['extract_pdf.py', pdfPath];
    if (extractTables) {
      args.push('--tables');
    }
    const pythonProcess = spawn(pythonCmd, args);

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
          const tablesInfo = result.tables ? `, ${result.tables.length} tables` : '';
          console.log(`✓ pdfplumber extraction complete: ${result.text.length} chars, ${result.numPages} pages${tablesInfo}`);
          resolve(result);
        } catch (parseError) {
          // Fallback: treat as plain text (backward compatibility)
          console.log(`✓ pdfplumber extraction complete: ${resultText.length} chars (plain text)`);
          resolve({ text: resultText, numPages: 1, tables: [] });
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
 * @param {string} pdfPath - Path to PDF file
 * @param {boolean} extractTables - Whether to extract tables (only works with pdfplumber)
 */
async function extractPDFWithFallback(pdfPath, extractTables = false) {
  console.log('\n========================================');
  console.log('📄 STARTING 3-TIER PDF EXTRACTION');
  console.log(`File: ${path.basename(pdfPath)}`);
  if (extractTables) console.log('📊 Table extraction: ENABLED');
  console.log('========================================\n');

  // Tier 1: Try PyMuPDF (fastest and best quality) - skip if tables needed
  if (!extractTables) {
    try {
      const result = await extractWithPyMuPDF(pdfPath);
      if (result.text && result.text.trim().length > 0) {
        console.log('\n✓ SUCCESS: PyMuPDF extraction completed\n');
        return result;
      }
    } catch (tier1Error) {
      console.log('⚠ Tier 1 (PyMuPDF) failed, falling back to Tier 2...\n');
    }
  } else {
    console.log('⚠ Skipping PyMuPDF (table extraction requires pdfplumber)...\n');
  }

  // Tier 2: Try pdfplumber (supports table extraction)
  try {
    const result = await extractWithPdfplumber(pdfPath, extractTables);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: pdfplumber extraction completed\n');
      return {
        text: result.text,
        numPages: result.numPages || 1,
        tables: result.tables || [],
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

// PDF extraction with table detection support
async function extractPDFWithTableDetection(pdfPath, extractTables = false) {
  const result = await extractPDFWithFallback(pdfPath, extractTables);
  const tables = result.tables || [];

  return {
    text: result.text,
    tables: tables,
    structuredContent: [{
      pageNum: 1,
      text: result.text,
      hasTable: tables.length > 0,
      tables: tables
    }],
    numPages: result.numPages,
    success: result.success,
    method: result.method
  };
}

// Extract financial data from tables (ITR, Balance Sheet, P&L)
function extractFinancialDataFromTables(tables, textLower) {
  const financialData = {
    grossTotalIncome: null,
    totalIncome: null,
    taxPayable: null,
    taxPaid: null,
    turnover: null,
    grossProfit: null,
    netProfit: null,
    totalAssets: null,
    totalLiabilities: null,
    currentAssets: null,
    currentLiabilities: null,
    sundryDebtors: null,
    sundryCreditors: null,
    cashInHand: null,
    bankBalance: null,
    depreciation: null,
    openingStock: null,
    closingStock: null,
    purchases: null,
    sales: null
  };

  if (!tables || tables.length === 0) {
    return financialData;
  }

  // Helper to parse currency values
  const parseCurrency = (val) => {
    if (!val) return null;
    const cleaned = String(val).replace(/[₹,\s]/g, '').replace(/\(([^)]+)\)/, '-$1');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  // Process each table
  tables.forEach(table => {
    if (!table.rows) return;

    table.rows.forEach(row => {
      if (!row || row.length < 2) return;

      const label = (row[0] || '').toLowerCase().trim();
      const value = row[row.length - 1]; // Usually last column has the value

      // Income related
      if (label.includes('gross total income')) {
        financialData.grossTotalIncome = parseCurrency(value);
      } else if (label.includes('total income') && !label.includes('gross')) {
        financialData.totalIncome = parseCurrency(value);
      } else if (label.includes('tax payable') || label.includes('tax liability')) {
        financialData.taxPayable = parseCurrency(value);
      } else if (label.includes('tax paid') || label.includes('advance tax') || label.includes('tds')) {
        const existing = financialData.taxPaid || 0;
        financialData.taxPaid = existing + (parseCurrency(value) || 0);
      }

      // P&L related
      else if (label.includes('turnover') || label.includes('total revenue') || label.includes('gross receipts')) {
        financialData.turnover = parseCurrency(value);
      } else if (label.includes('sales') && !label.includes('purchase')) {
        financialData.sales = parseCurrency(value);
      } else if (label.includes('purchase') && !label.includes('sales')) {
        financialData.purchases = parseCurrency(value);
      } else if (label.includes('gross profit')) {
        financialData.grossProfit = parseCurrency(value);
      } else if (label.includes('net profit') || label.includes('profit before tax')) {
        financialData.netProfit = parseCurrency(value);
      } else if (label.includes('depreciation')) {
        financialData.depreciation = parseCurrency(value);
      } else if (label.includes('opening stock')) {
        financialData.openingStock = parseCurrency(value);
      } else if (label.includes('closing stock')) {
        financialData.closingStock = parseCurrency(value);
      }

      // Balance Sheet related
      else if (label.includes('total assets') || label === 'total') {
        if (!financialData.totalAssets) financialData.totalAssets = parseCurrency(value);
      } else if (label.includes('total liabilities')) {
        financialData.totalLiabilities = parseCurrency(value);
      } else if (label.includes('current assets')) {
        financialData.currentAssets = parseCurrency(value);
      } else if (label.includes('current liabilities')) {
        financialData.currentLiabilities = parseCurrency(value);
      } else if (label.includes('sundry debtor') || label.includes('trade receivable')) {
        financialData.sundryDebtors = parseCurrency(value);
      } else if (label.includes('sundry creditor') || label.includes('trade payable')) {
        financialData.sundryCreditors = parseCurrency(value);
      } else if (label.includes('cash in hand') || label.includes('cash balance')) {
        financialData.cashInHand = parseCurrency(value);
      } else if (label.includes('bank balance') || label.includes('balance with bank')) {
        financialData.bankBalance = parseCurrency(value);
      }
    });
  });

  // Clean up - remove null values
  Object.keys(financialData).forEach(key => {
    if (financialData[key] === null) {
      delete financialData[key];
    }
  });

  return financialData;
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
    } else if (documentType === 'debt-profile') {
      prompt = `You are a financial document extraction AI. Extract all loan/debt records from this debt profile document.

Document Text:
${text.substring(0, 8000)}

Extract each loan as an object with these fields:
- sNo: serial number
- applicant: borrower/applicant name
- bank: bank or financial institution name
- loanType: type of loan (e.g., Cash Credit, Term Loan, Unsecured, Home Loan)
- loanAmount: loan/sanctioned amount as a plain number (remove commas). For Indian format like 10,00,00,000 = 100000000
- emi: monthly EMI as a plain number
- roi: rate of interest as a decimal number (e.g., 8.33)
- tenure: tenure in months as a number
- emiStartDate: EMI start date in DD-MM-YYYY format
- sanctionDate: sanction date in DD-MM-YYYY format if available

IMPORTANT:
- Parse Indian number format: 10,00,00,000 = 100000000, 3,49,99,999 = 34999999, 14,60,000 = 1460000
- Return null for fields not found in a row
- Include ALL loan records, even if some fields are missing

Respond ONLY with valid JSON:
{
  "loans": [
    {
      "sNo": 1,
      "applicant": "Name",
      "bank": "Bank Name",
      "loanType": "Loan Type",
      "loanAmount": 100000000,
      "emi": null,
      "roi": 8.33,
      "tenure": null,
      "emiStartDate": null,
      "sanctionDate": null
    }
  ]
}`;
    } else if (documentType === 'financial-itr') {
      // Smart text selection: find P&L / Revenue sections instead of just first 10K chars
      let financialText = '';
      const textLower = text.toLowerCase();

      // Detect unit (Lakhs/Crores) from document
      let docUnit = '';
      if (/amount\s+in\s+rs\.?\s*['']?\s*(?:lacs?|lakhs?)/i.test(text) || /all\s+amounts.*rounded\s+off\s+to\s+['']?lacs?/i.test(text)) {
        docUnit = 'Lakhs';
      } else if (/amount\s+in\s+(?:rs\.?\s*)?crores?/i.test(text)) {
        docUnit = 'Crores';
      }

      // Try to find P&L section
      const plIdx = text.search(/Statement\s+of\s+Profit\s+and\s+Loss|PROFIT\s*&?\s*LOSS\s+(?:FOR|ACCOUNT)|Revenue\s+from\s+[Oo]perations/i);
      const compIdx = text.search(/Computation\s+of\s+(?:Total\s+)?Income/i);

      if (plIdx >= 0) {
        // Include P&L section (up to 6K chars) plus start of doc for context (up to 4K)
        financialText = text.substring(0, 4000) + '\n...\n' + text.substring(plIdx, plIdx + 6000);
      } else if (compIdx >= 0) {
        financialText = text.substring(0, 4000) + '\n...\n' + text.substring(compIdx, compIdx + 6000);
      } else {
        financialText = text.substring(0, 10000);
      }

      prompt = `You are a financial document extraction AI. Extract the following financial data from this ITR / Profit & Loss / Computation of Income document.

Extract these fields (values should be plain numbers WITHOUT any currency symbols, commas, or text like "Cr" or "L"):
1. Turnover / Sales / Revenue from Operations
2. Gross Profit
3. Depreciation
4. Interest on Loans / Finance Cost
5. Net Profit (before tax)
6. Assessment Year (e.g., "2024-25")

${docUnit ? `NOTE: This document states amounts are in ${docUnit}. You MUST convert all values to absolute rupees (multiply by ${docUnit === 'Lakhs' ? '100000' : '10000000'}).` : ''}

Document Text:
${financialText}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables.slice(0, 5), null, 2)}` : ''}

IMPORTANT:
- Convert all amounts to absolute rupees (e.g., "40.34 L" = 4034000, "2.40 Cr" = 24000000, "60,208" = 60208)
- If the document says "Amount in Rs Lacs" or "Amount in Lakhs", multiply ALL values by 100000
- If the document says "Amount in Crores", multiply ALL values by 10000000
- Return null for fields not found
- For Assessment Year, extract from "Assessment Year" or "A.Y." field

Respond ONLY with valid JSON:
{
  "assessmentYear": "2024-25" or null,
  "turnover": number or null,
  "grossProfit": number or null,
  "depreciation": number or null,
  "interestOnLoans": number or null,
  "netProfit": number or null
}`;
    } else if (documentType === 'private-limited') {
      prompt = `You are a document extraction AI. Extract the following from this Private Limited company incorporation document (MOA/AOA/Certificate of Incorporation):

1. Company Name: The full registered name of the company
2. CIN (Corporate Identification Number): 21-character alphanumeric code starting with L/U
3. Date of Incorporation: When the company was registered
4. Shareholders/Members: List of all shareholders with their shareholding details
5. Directors: List of all directors with their DIN (Director Identification Number - 8 digits)

Document Text:
${text.substring(0, 12000)}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables, null, 2)}` : ''}

IMPORTANT INSTRUCTIONS:
- Extract ONLY actual person names as shareholders and directors (not clauses or legal text)
- A valid person name typically has 2-4 words, starts with capital letter, contains only alphabets and spaces
- DIN is always exactly 8 digits
- Shareholders may have share counts or percentages mentioned
- Ignore text that looks like legal clauses, article numbers, or document headings
- Directors are actual people who serve on the board, NOT random text

Respond ONLY with valid JSON in this exact format:
{
  "companyName": "Company Name Private Limited" or null,
  "cin": "U12345MH2020PTC123456" or null,
  "dateOfIncorporation": "DD/MM/YYYY" or null,
  "shareholders": [
    {
      "name": "Full Name",
      "shares": "1000" or null,
      "percentage": "50" or null
    }
  ],
  "directors": [
    {
      "name": "Full Name",
      "din": "12345678" or null,
      "designation": "Director" or "Managing Director" etc.
    }
  ]
}`;
    } else if (documentType === 'bank-statement') {
      prompt = `You are a document extraction AI. Extract the following from this bank statement:

1. Bank Name - The issuing bank (from letterhead, IFSC code prefix, or header). Common IFSC prefixes: UTIB=Axis Bank, HDFC=HDFC Bank, ICIC=ICICI Bank, SBIN=SBI, KKBK=Kotak, PUNB=PNB, CNRB=Canara Bank, BARB=Bank of Baroda, IOBA=IOB, FDRL=Federal Bank, BDBL=Bandhan Bank, INDB=IndusInd Bank, YESB=Yes Bank.
2. Account Holder Name - Found ONLY in the HEADER section (top of statement), typically the very first name shown, or after labels like "Account Holder", "Customer Name", "Name", "Welcome". NEVER extract names from transaction descriptions (UPI/NEFT/IMPS/RTGS entries).
3. Account Number - The statement account number
4. Statement Period (from date to date)

CRITICAL: The account holder is the person/entity whose statement this is. Their name appears at the TOP of the document in the header/letterhead area, NOT in the transaction list below.

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
    } else if (documentType === 'title-document') {
      prompt = `You are a legal document extraction AI specializing in Indian property title documents (Sale Deeds, Gift Deeds, Partition Deeds, Release Deeds, etc.).

Extract ALL title documents/deeds mentioned in this text. For EACH document found, extract:

1. Document No. - The registration number, document number, or deed number
2. Date - The date of execution or registration
3. Buyer - The purchaser/buyer/donee/transferee name(s)
4. Seller - The vendor/seller/donor/transferor name(s)
5. Schedule of the Property - Property description including survey numbers, plot numbers, area, boundaries, village, mandal/taluk, district etc.

Document Text:
${text.substring(0, 12000)}

${tables.length > 0 ? '\n\nDetected Tables:\n' + JSON.stringify(tables.slice(0, 5), null, 2) : ''}

IMPORTANT INSTRUCTIONS:
- Extract ALL separate deeds/documents found in the text (there may be multiple title documents)
- For dates, use DD/MM/YYYY format where possible
- For property schedule, include survey numbers, plot numbers, area (in sq yards/sq meters/acres), boundaries, village/locality name
- If a field is not found, return empty string ""
- Look for keywords like: "Sale Deed", "Gift Deed", "Registered Document", "Document No", "Regd. No", "Book No", "executed on", "vendor", "vendee", "purchaser", "seller", "schedule of property", "property more fully described", "survey no", "plot no"

Respond ONLY with valid JSON in this exact format:
{
  "titleDocuments": [
    {
      "documentNo": "Document/Registration number",
      "date": "DD/MM/YYYY",
      "buyer": "Buyer/Purchaser name(s)",
      "seller": "Seller/Vendor name(s)",
      "propertySchedule": "Property description with survey no, area, location"
    }
  ]
}`;
    } else if (documentType === 'other-income') {
      prompt = `You are a financial document extraction AI. Extract all rental/other income details from this document.

Document Text:
${text.substring(0, 12000)}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables.slice(0, 5), null, 2)}` : ''}

Extract each rental/other income entry as an object with these fields:
- sNo: serial number
- ownerName: name of the property owner (the person who owns the property and receives rent)
- tenant: tenant/lessee name (the person or company paying rent)
- propertyAddress: full address of the let-out property
- monthlyRent: monthly rent amount as a plain number (remove commas, convert Indian format)
- rentPeriod: rent period (e.g., "12 months", "Apr 2024 - Mar 2025")
- rentStartDate: rent start date in DD-MM-YYYY format if available
- escalation: rent escalation clause (e.g., "5% annual", "10% every 2 years")
- tdsDeducted: "Yes" or "No" or null
- gstApplicable: "Yes" or "No" or null

CRITICAL RULES:
- DO NOT extract column headers or labels as data. Only extract actual data rows with real names, addresses, and amounts.
- If the document is a markdown table, skip the header row and separator row - only extract data rows.
- Parse Indian number format: 10,00,000 = 1000000, 50,000 = 50000
- Return null for fields not found
- Include ALL rental/income entries even if some fields are missing
- If the document is a Rental Agreement / Lease Deed, extract the owner, tenant, property, and rent details from the agreement text.
- If the document contains multiple properties or tenants, create a separate entry for each.
- If monthly rent is not stated but annual rent is given, divide by 12 to get monthly rent.
- Return empty array if no actual rental data can be found (do NOT return header labels as data).

Respond ONLY with valid JSON:
{
  "rentals": [
    {
      "sNo": 1,
      "ownerName": "Actual Owner Name",
      "tenant": "Actual Tenant Name",
      "propertyAddress": "Actual Property Address",
      "monthlyRent": 50000,
      "rentPeriod": "12 months",
      "rentStartDate": "01-04-2024",
      "escalation": "5% annual",
      "tdsDeducted": "Yes",
      "gstApplicable": "No"
    }
  ]
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
            model: 'google/gemini-2.0-flash-001',
            messages: [
              {
                role: 'user',
                content: prompt
              }
            ],
            temperature: 0.1, // Low temperature for consistent extraction
            max_tokens: (documentType === 'title-document' || documentType === 'other-income') ? 4000 : 1000
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'http://localhost:3000',
              'X-Title': 'Customer Profiling App'
            },
            timeout: documentType === 'title-document' ? 60000 : 30000
          }
        );
        
        const content = response.data.choices[0].message.content;
        console.log('📄 Document AI Response:', content);
        
        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const extracted = JSON.parse(jsonMatch[0]);
            return {
              success: true,
              data: extracted,
              method: 'openrouter-document-ai'
            };
          } catch (parseErr) {
            // Attempt to recover truncated JSON for title documents (array of objects)
            if (documentType === 'title-document') {
              console.log('⚠ JSON truncated, attempting to recover partial title documents...');
              const arrayMatch = content.match(/\"titleDocuments\"\s*:\s*\[([\s\S]*)/);
              if (arrayMatch) {
                const partialArray = arrayMatch[1];
                // Extract all complete objects from the truncated array
                const recovered = [];
                const objRegex = /\{[^{}]*\}/g;
                let m;
                while ((m = objRegex.exec(partialArray)) !== null) {
                  try {
                    const obj = JSON.parse(m[0]);
                    if (obj.documentNo || obj.buyer || obj.seller) {
                      recovered.push(obj);
                    }
                  } catch (e) { /* skip malformed objects */ }
                }
                if (recovered.length > 0) {
                  console.log(`✓ Recovered ${recovered.length} title document(s) from truncated response`);
                  return {
                    success: true,
                    data: { titleDocuments: recovered },
                    method: 'openrouter-document-ai-recovered'
                  };
                }
              }
            }
            throw parseErr;
          }
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
// IMAGE OCR SERVICE (OpenRouter Vision API)
// ============================================

/**
 * Call OpenRouter Vision API with image(s) and a prompt. Shared helper for all OCR functions.
 * Uses google/gemini-2.0-flash-001 via OpenRouter (supports vision/multimodal).
 */
async function callGeminiVision(imagePartsArray, promptText, timeoutMs = 60000) {
  // Convert Gemini-format image parts to OpenRouter/OpenAI-compatible content parts
  const contentParts = [{ type: 'text', text: promptText }];
  for (const part of imagePartsArray) {
    if (part.inline_data) {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`
        }
      });
    }
  }

  const response = await axios.post(
    OPENROUTER_API_URL,
    {
      model: 'google/gemini-2.0-flash-001',
      messages: [{ role: 'user', content: contentParts }],
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
      timeout: timeoutMs
    }
  );
  const text = response.data.choices?.[0]?.message?.content || '';
  return text;
}

/**
 * Extract text from images (JPG/PNG) using Google Gemini Vision API
 * Used for banker policy documents and other image-based documents
 */
async function extractTextFromImage(imagePath) {
  try {
    console.log('🖼️ Starting image OCR extraction:', path.basename(imagePath));

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');

    const ext = path.extname(imagePath).toLowerCase();
    let mimeType = 'image/jpeg';
    if (ext === '.png') mimeType = 'image/png';

    console.log(`Image size: ${(imageBuffer.length / 1024).toFixed(2)} KB, Type: ${mimeType}`);

    let retries = 3;
    let delay = 5000;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`🤖 Gemini Vision attempt ${attempt}/${retries}...`);

        const extractedText = await callGeminiVision(
          [{ inline_data: { mime_type: mimeType, data: base64Image } }],
          `Extract all text from this image. This is a document (possibly a banker policy, financial document, or business document).
Please:
1. Extract ALL text visible in the image
2. Maintain the document structure and formatting as much as possible
3. Preserve tables, lists, and hierarchical information
4. Include headers, footers, and any metadata
5. If this is a banker policy or financial document, pay special attention to:
   - Policy details, Names and addresses, Account numbers
   - Dates, Amounts and percentages, Terms and conditions
Return the extracted text in a clear, structured format.`,
          60000
        );

        console.log(`✓ Vision OCR successful: ${extractedText.length} characters extracted`);
        return { success: true, text: extractedText, method: 'gemini-vision-ocr', charCount: extractedText.length };

      } catch (error) {
        const status = error.response?.status;
        const errDetail = error.response?.data?.error?.message || error.message;
        console.error(`✗ Vision OCR error (attempt ${attempt}):`, status, errDetail);

        if ((status === 429 || status === 503) && attempt < retries) {
          console.log(`⚠️ Rate limit/overload (${status}), waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }

        if (attempt === retries) {
          return { success: false, text: '', method: 'gemini-vision-ocr', error: error.message };
        }
      }
    }

    return { success: false, text: '', method: 'gemini-vision-ocr', error: 'Max retries reached' };

  } catch (error) {
    console.error('✗ Image OCR extraction failed:', error.message);
    return { success: false, text: '', method: 'gemini-vision-ocr', error: error.message };
  }
}

// Extract text from scanned PDF using Gemini Vision OCR (renders first page to image)
async function extractTextFromScannedPDF(pdfPath) {
  try {
    console.log('🔍 Attempting Vision OCR for scanned PDF:', path.basename(pdfPath));

    const dataBuffer = fs.readFileSync(pdfPath);
    const uint8Array = new Uint8Array(dataBuffer);
    const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;

    const numPages = pdfDoc.numPages;
    console.log(`PDF has ${numPages} pages, rendering first page for OCR...`);

    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({ canvasContext: context, viewport }).promise;

    const imageBuffer = canvas.toBuffer('image/png');
    const base64Image = imageBuffer.toString('base64');

    console.log(`Rendered page to image: ${(imageBuffer.length / 1024).toFixed(2)} KB`);

    let retries = 2;
    let delay = 5000;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`🤖 Gemini Vision OCR attempt ${attempt}/${retries} for scanned PDF...`);

        const extractedText = await callGeminiVision(
          [{ inline_data: { mime_type: 'image/png', data: base64Image } }],
          `Extract ALL text from this document image. Pay special attention to:
- Names, dates of birth, PAN numbers, Aadhaar numbers
- Credit/CIBIL scores and bureau names
- Any personal identification details
- All numbers, dates, and reference numbers
Return the extracted text exactly as it appears in the document.`,
          60000
        );

        console.log(`✓ Scanned PDF OCR successful: ${extractedText.length} characters extracted`);
        return { success: true, text: extractedText, numPages, method: 'gemini-vision-ocr-pdf', charCount: extractedText.length };

      } catch (error) {
        const status = error.response?.status;
        if ((status === 429 || status === 503) && attempt < retries) {
          console.log(`⚠️ Rate limit/overload, waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        } else if (attempt === retries) {
          throw error;
        }
      }
    }

    return { success: false, text: '', method: 'gemini-vision-ocr-pdf', error: 'Max retries reached' };

  } catch (error) {
    console.error('✗ Scanned PDF OCR failed:', error.message);
    return { success: false, text: '', method: 'gemini-vision-ocr-pdf', error: error.message };
  }
}

// Extract text from ALL pages of a scanned PDF using Gemini Vision OCR (batches pages for efficiency)
async function extractAllPagesWithVisionOCR(pdfPath) {
  try {
    console.log('🔍 Starting multi-page Vision OCR:', path.basename(pdfPath));

    const dataBuffer = fs.readFileSync(pdfPath);
    const uint8Array = new Uint8Array(dataBuffer);
    const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array }).promise;
    const numPages = pdfDoc.numPages;

    console.log(`📄 Processing ${numPages} pages in batches...`);

    let allText = '';
    const BATCH_SIZE = 4;
    const MAX_PAGES = 30;
    const pagesToProcess = Math.min(numPages, MAX_PAGES);

    for (let startPage = 1; startPage <= pagesToProcess; startPage += BATCH_SIZE) {
      const endPage = Math.min(startPage + BATCH_SIZE - 1, pagesToProcess);
      const imageParts = [];

      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');

        await page.render({ canvasContext: context, viewport }).promise;

        const imageBuffer = canvas.toBuffer('image/png');
        const base64Image = imageBuffer.toString('base64');

        imageParts.push({ inline_data: { mime_type: 'image/png', data: base64Image } });
      }

      let retries = 2;
      let delay = 5000;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`🤖 OCR pages ${startPage}-${endPage} (attempt ${attempt})...`);

          const batchText = await callGeminiVision(
            imageParts,
            `Extract ALL text from these ${endPage - startPage + 1} document page(s). These are financial/ITR documents. Preserve all text including headings like "Computation of Total Income", "Balance Sheet", "Profit and Loss Account", "Indian Income Tax Return Acknowledgement", assessment year, financial year, etc. Extract all numbers, dates, and financial data. Return the text exactly as it appears.`,
            90000
          );

          allText += '\n' + batchText;
          console.log(`✓ Pages ${startPage}-${endPage}: ${batchText.length} chars extracted`);
          break;

        } catch (error) {
          const status = error.response?.status;
          if ((status === 429 || status === 503) && attempt < retries) {
            console.log(`⚠️ Rate limit/overload, waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
          } else if (attempt === retries) {
            console.error(`✗ OCR failed for pages ${startPage}-${endPage}:`, error.message);
          }
        }
      }
    }

    console.log(`✓ Multi-page OCR complete: ${allText.length} total chars from ${pagesToProcess} pages`);

    return {
      success: allText.length > 0,
      text: allText,
      numPages: numPages,
      method: 'gemini-vision-ocr-multipage',
      charCount: allText.length
    };

  } catch (error) {
    console.error('✗ Multi-page Vision OCR failed:', error.message);
    return { success: false, text: '', method: 'gemini-vision-ocr-multipage', error: error.message };
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

  // SPECIAL HANDLING: Line-by-line format (common in List of Directors & Shareholders PDFs)
  // Format: Each field on separate line - S.No, Name, DIN/Shares, etc.
  const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Check if this is a directors/shareholders list document
  const hasDirectorsList = fullText.includes('LIST OF DIRECTORS') || fullText.includes('Name of the Director');
  const hasShareholdersList = fullText.includes('SHAREHOLDING PATTERN') || fullText.includes('Name of the Shareholder') || /LIST OF SHAREHOLDERS/i.test(fullText);

  if (hasDirectorsList || hasShareholdersList) {
    console.log('Detected structured Directors/Shareholders list format');

    // Helper function to check if a string looks like a person/entity name
    function looksLikeName(str) {
      if (!str || str.length < 5 || str.length > 80) return false;
      // Must contain at least one letter
      if (!/[a-zA-Z]/.test(str)) return false;
      // Should not be just numbers with commas/dots
      if (/^[\d,.\s]+$/.test(str)) return false;
      // Should not be common headers or labels
      if (/^(S\.?No\.?|DIN|Designation|Name|Shares|Held|Value|Percentage|%|Rs\.?|\(Rs\.?\)|TOTAL)$/i.test(str)) return false;
      return true;
    }

    // Helper function to check if a string is a valid FULL person name (for directors)
    function isValidDirectorName(str) {
      if (!str || str.length < 5 || str.length > 80) return false;
      // Must have at least 2 words (first name + last name)
      const words = str.trim().split(/\s+/);
      if (words.length < 2) return false;
      // Each word should be at least 2 characters and start with a letter
      for (const word of words) {
        if (word.length < 2 || !/^[A-Za-z]/.test(word)) return false;
      }
      // Should not contain common headers
      if (/DIN|Designation|Director|Chairman|Managing|S\.?No/i.test(str)) return false;
      return true;
    }

    // DIRECTORS EXTRACTION: Find entries using DIN (8 digits) pattern
    // Table format: S.No | Name | DIN | Designation
    // First pass: collect all potential directors
    const potentialDirectors = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line contains a DIN (8-digit number, standalone or prefixed with "DIN:")
      const dinMatch = line.match(/^(\d{8})$/) || line.match(/^DIN[\s:]+(\d{8})$/i);
      if (dinMatch) {
        const din = dinMatch[1];
        let name = null;
        let designation = 'Director';

        // Look backwards for the name - must be a valid full name
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (isValidDirectorName(lines[j])) {
            name = lines[j];
            break;
          }
          // Also check for designation between name and DIN (e.g., "Director" line before DIN)
          if (/^(chairman|managing\s*director|director|whole\s*time|executive|non-executive|independent|additional|nominee)/i.test(lines[j])) {
            designation = lines[j].trim();
          }
        }

        // Look forward for designation
        let designationParts = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
          const nextLine = lines[j];
          // Stop if we hit another DIN, serial number starting a new row, or shareholder section
          if (/^\d{8}$/.test(nextLine) || /^DIN[\s:]+\d{8}$/i.test(nextLine) || /SHAREHOLDING|Name of the Shareholder|LIST OF SHAREHOLDERS/i.test(nextLine)) break;
          if (/^\d{1,2}$/.test(nextLine) && j > i + 1) break; // New row serial number

          if (/chairman|managing|director|whole\s*time|executive|non-executive|independent|additional|nominee/i.test(nextLine)) {
            designationParts.push(nextLine);
          }
        }
        if (designationParts.length > 0) {
          designation = designationParts.join(' ');
        }

        if (name) {
          potentialDirectors.push({
            name: name,
            din: din,
            designation: designation.trim()
          });
          console.log(`Found potential director: ${name} (DIN: ${din}, ${designation.trim()})`);
        }
      }
    }

    // Deduplicate by DIN - keep the entry with the longest/best name
    const dinMap = new Map();
    for (const director of potentialDirectors) {
      const existing = dinMap.get(director.din);
      if (!existing || director.name.length > existing.name.length) {
        dinMap.set(director.din, director);
      }
    }
    details.directors = Array.from(dinMap.values());
    console.log(`After deduplication: ${details.directors.length} directors`);

    // SHAREHOLDERS EXTRACTION: Row-based parsing
    // Table format: S.No | Name | Shares | Value | Percentage
    let inShareholderSection = false;
    let currentRowStart = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/SHAREHOLDING PATTERN|Name of the Shareholder|LIST OF SHAREHOLDERS/i.test(line)) {
        inShareholderSection = true;
        continue;
      }

      // Stop at TOTAL row or end of section
      if (inShareholderSection && /^TOTAL/i.test(line)) {
        break;
      }

      if (inShareholderSection) {
        // Detect row start: a single or double digit serial number (standalone or starting a line)
        if (/^[1-9]\d?$/.test(line)) {
          // Process previous row if we have one started
          if (currentRowStart >= 0) {
            // Extract data from lines[currentRowStart+1] to lines[i-1]
            const rowLines = lines.slice(currentRowStart + 1, i);
            parseShareholderRow(rowLines, details);
          }
          currentRowStart = i;
        }
      }
    }

    // Don't forget the last row
    if (currentRowStart >= 0) {
      // Find end - either TOTAL or end of relevant section
      let endIdx = lines.length;
      for (let i = currentRowStart + 1; i < lines.length; i++) {
        if (/^TOTAL$/i.test(lines[i])) {
          endIdx = i;
          break;
        }
      }
      const rowLines = lines.slice(currentRowStart + 1, endIdx);
      parseShareholderRow(rowLines, details);
    }

    function parseShareholderRow(rowLines, details) {
      if (rowLines.length < 2) return;

      let name = null;
      let shares = null;
      let percentage = null;

      // First non-numeric line is typically the name
      for (let i = 0; i < rowLines.length; i++) {
        const line = rowLines[i];
        if (looksLikeName(line)) {
          name = line;
          break;
        }
      }

      // Look for shares (number with commas, typically first number after name)
      // And percentage (number with decimal, typically 0-100)
      let foundShares = false;
      for (let i = 0; i < rowLines.length; i++) {
        const line = rowLines[i];
        // Skip if it's the name we found
        if (line === name) continue;

        // Check if it's a number (with optional commas)
        if (/^[\d,]+$/.test(line)) {
          if (!foundShares) {
            shares = line.replace(/,/g, '');
            foundShares = true;
          }
          // Skip value column (second number)
        }
        // Check for percentage (decimal number, typically ends in .00 or similar)
        else if (/^\d+\.\d+$/.test(line)) {
          const val = parseFloat(line);
          if (val <= 100) {
            percentage = line;
          }
        }
      }

      if (name && shares) {
        const exists = details.shareholders.some(s => s.name.toLowerCase() === name.toLowerCase());
        if (!exists) {
          details.shareholders.push({
            name: name,
            shares: shares,
            percentage: percentage
          });
          console.log(`Found shareholder: ${name} (${shares} shares, ${percentage}%)`);
        }
      }
    }

    // FLEXIBLE LINE-BASED EXTRACTION: Handle garbled OCR where data is on mixed lines
    // Look for lines containing percentage patterns (e.g., "50%", "50.00%") near names
    if (details.shareholders.length === 0) {
      console.log('Row-based parsing found no shareholders, trying flexible line-based extraction...');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match lines with percentage like "2 Rekha Dannapaneni ... 5,000 50%"
        const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
        if (!pctMatch) continue;

        const pct = parseFloat(pctMatch[1]);
        if (pct <= 0 || pct > 100) continue;
        // Skip total/header lines
        if (/^total/i.test(line.trim())) continue;

        // Extract shares: look for number with commas before the percentage
        let shares = null;
        const sharesMatch = line.match(/(\d{1,3}(?:,\d{3})+|\d+)\s+(?:\d+(?:\.\d+)?\s*%)/);
        if (sharesMatch) {
          shares = sharesMatch[1].replace(/,/g, '');
        }

        // Try to find name on this line or nearby lines
        let name = null;

        // Pattern: "S.No Name Address... shares percentage" on one line
        // Look for 2+ consecutive capitalized words (person name), stop before city/address words
        const cityWords = /^(Hyderabad|Mumbai|Delhi|Chennai|Bangalore|Kolkata|Pune|Ahmedabad|Telangana|Maharashtra|Karnataka|India|Road|Colony|Nagar|Township|Village|Town|District|Phase|Sector)/i;
        const nameOnLine = line.match(/(?:^\d+\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})/);
        if (nameOnLine && looksLikeName(nameOnLine[1])) {
          // Trim city/address words from end of matched name
          let nameWords = nameOnLine[1].trim().split(/\s+/);
          while (nameWords.length > 2 && cityWords.test(nameWords[nameWords.length - 1])) {
            nameWords.pop();
          }
          name = nameWords.join(' ');
        }

        // If no name found on this line, look backwards for name
        if (!name) {
          for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
            // Skip address-like lines, numbers, and header lines
            if (/^\d+$/.test(lines[j]) || /Hyderabad|Telangana|India|Road|Colony|Phase|Villa|Fortune|Township/i.test(lines[j])) continue;
            if (/SHAREHOLDING|Name of|shares of|value Rs/i.test(lines[j])) continue;

            // Look for a person name pattern within the line
            const backMatch = lines[j].match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})/);
            if (backMatch && looksLikeName(backMatch[1])) {
              name = backMatch[1].trim();
              break;
            }
          }
        }

        if (name) {
          const exists = details.shareholders.some(s => s.name.toLowerCase() === name.toLowerCase());
          if (!exists) {
            details.shareholders.push({
              name: name,
              shares: shares || null,
              percentage: String(pct)
            });
            console.log(`Found shareholder (flexible): ${name} (${shares || '?'} shares, ${pct}%)`);
          }
        }
      }

      // If we found some shareholders but not all, try to infer remaining from total
      // e.g., if total is 100% and we have one at 50%, look for other names
      if (details.shareholders.length > 0) {
        const totalPct = details.shareholders.reduce((sum, s) => sum + (parseFloat(s.percentage) || 0), 0);
        const totalSharesLine = lines.find(l => /^total/i.test(l.trim()));

        if (totalPct < 100 && totalSharesLine) {
          const totalSharesMatch = totalSharesLine.match(/(\d{1,3}(?:,\d{3})+|\d+)/);
          const totalShares = totalSharesMatch ? parseInt(totalSharesMatch[1].replace(/,/g, '')) : null;
          const knownShares = details.shareholders.reduce((sum, s) => sum + (parseInt(s.shares) || 0), 0);
          const remainingPct = 100 - totalPct;
          const remainingShares = totalShares ? totalShares - knownShares : null;

          // Look for director names that aren't already shareholders (they're often also shareholders)
          if (details.directors.length > 0) {
            for (const director of details.directors) {
              const exists = details.shareholders.some(s =>
                s.name.toLowerCase().includes(director.name.toLowerCase().split(' ')[0]) ||
                director.name.toLowerCase().includes(s.name.toLowerCase().split(' ')[0])
              );
              if (!exists) {
                details.shareholders.push({
                  name: director.name,
                  shares: remainingShares ? String(remainingShares) : null,
                  percentage: String(remainingPct)
                });
                console.log(`Inferred shareholder from director: ${director.name} (${remainingShares || '?'} shares, ${remainingPct}%)`);
                break;
              }
            }
          }
        }
      }
    }

    // If we found data in structured format, return early
    if (details.directors.length > 0 || details.shareholders.length > 0) {
      console.log('Extraction from structured format complete. Directors:', details.directors.length, 'Shareholders:', details.shareholders.length);
      return details;
    }
  }

  // Helper function to validate if a string looks like a real person name
  function isValidPersonName(name) {
    if (!name || name.length < 3 || name.length > 50) return false;

    // Must have at least 2 words for a full name (first + last)
    const words = name.trim().split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;

    // Each word should be a proper name (starts with capital, mostly letters)
    for (const word of words) {
      if (!/^[A-Z][a-zA-Z]*$/.test(word)) return false;
    }

    // Reject common legal terms and clauses
    const invalidTerms = [
      'share', 'capital', 'rights', 'provided', 'company', 'director', 'board',
      'meeting', 'shall', 'may', 'article', 'clause', 'section', 'memorandum',
      'association', 'resolution', 'business', 'object', 'liability', 'limited',
      'private', 'registered', 'office', 'subscriber', 'witness', 'authorized',
      'issued', 'paid', 'ordinary', 'preference', 'equity', 'transfer', 'transmission',
      'general', 'extraordinary', 'annual', 'statutory', 'dividend', 'bonus',
      'appointment', 'removal', 'resignation', 'vacation', 'qualification',
      'remuneration', 'power', 'duty', 'indemnity', 'seal', 'notice', 'winding',
      'dissolution', 'guarantee', 'subscription', 'stamp', 'execution', 'schedule'
    ];

    const lowerName = name.toLowerCase();
    for (const term of invalidTerms) {
      if (lowerName.includes(term)) return false;
    }

    // Reject if it's all uppercase (likely a heading)
    if (name === name.toUpperCase() && name.length > 10) return false;

    // Reject if it contains numbers (except in DIN context)
    if (/\d/.test(name)) return false;

    return true;
  }

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

  // Extract shareholders from text - more specific patterns
  const shareholderPatterns = [
    // Pattern: "Name holding X shares" or "Name - X shares"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:\s*[-–]\s*|\s+holding\s+|\s+holds\s+)(\d+(?:,\d+)?)\s*(?:equity\s+)?shares/gi,
    // Pattern: "X shares held by Name"
    /(\d+(?:,\d+)?)\s*(?:equity\s+)?shares?\s+(?:held\s+by|of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi
  ];

  const foundShareholders = new Map();

  for (const pattern of shareholderPatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      let name, shares;
      if (match[1] && !isNaN(parseInt(match[1].replace(/,/g, '')))) {
        shares = match[1].replace(/,/g, '');
        name = match[2];
      } else {
        name = match[1];
        shares = match[2] ? match[2].replace(/,/g, '') : null;
      }

      const cleanName = name ? name.trim().replace(/\s+/g, ' ') : '';
      if (isValidPersonName(cleanName) && !foundShareholders.has(cleanName.toLowerCase())) {
        foundShareholders.set(cleanName.toLowerCase(), {
          name: cleanName,
          shares: shares || '-',
          percentage: match[3] || null
        });
      }
    }
  }

  // For messy OCR text: Find share counts and look for names nearby
  // Look for patterns like "9,999" or "10,000" shares
  const sharePatterns = [
    /(\d{1,3}(?:,\d{3})*)\s*(?:Equity\s*)?Shares?/gi,
    /(\d+)\s*\(\s*[A-Za-z\s]+\)\s*(?:Equity\s*)?Shares?/gi
  ];

  for (const sharePattern of sharePatterns) {
    const shareMatches = fullText.matchAll(sharePattern);
    for (const shareMatch of shareMatches) {
      const shares = shareMatch[1].replace(/,/g, '');
      const shareIndex = shareMatch.index;

      // Look for names within 300 chars before the share count
      const contextBefore = fullText.substring(Math.max(0, shareIndex - 300), shareIndex);

      // Look for capitalized names (2-4 words, each starting with capital)
      const namePatternStrict = /\b([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+){1,3})\b/g;

      const namesBefore = [...contextBefore.matchAll(namePatternStrict)];
      for (const nm of namesBefore.reverse()) {
        const candidateName = nm[1].split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
        if (isValidPersonName(candidateName) && !foundShareholders.has(candidateName.toLowerCase())) {
          foundShareholders.set(candidateName.toLowerCase(), {
            name: candidateName,
            shares: shares,
            percentage: null
          });
          console.log(`Found shareholder from shares context: ${candidateName} (${shares} shares)`);
          break;
        }
      }
    }
  }

  details.shareholders = Array.from(foundShareholders.values());
  console.log('Found shareholders:', details.shareholders.length);

  // Extract directors from text - focus on DIN pattern which is most reliable
  const directorPatterns = [
    // Pattern: "Name (DIN: XXXXXXXX)" or "Name DIN XXXXXXXX"
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\(?DIN[\s:]*(\d{8})\)?/gi,
    // Pattern: "DIN: XXXXXXXX Name"
    /DIN[\s:]*(\d{8})[\s,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/gi,
    // Pattern from table: Name | DIN | Designation
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(\d{8})\s+(?:Director|Managing Director|Whole Time Director)/gi
  ];

  const foundDirectors = new Map();

  for (const pattern of directorPatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      let name, din;

      // Check if first group is DIN (8 digits)
      if (match[1] && /^\d{8}$/.test(match[1])) {
        din = match[1];
        name = match[2];
      } else {
        name = match[1];
        din = match[2] && /^\d{8}$/.test(match[2]) ? match[2] : null;
      }

      const cleanName = name ? name.trim().replace(/\s+/g, ' ') : '';
      if (isValidPersonName(cleanName) && !foundDirectors.has(cleanName.toLowerCase())) {
        foundDirectors.set(cleanName.toLowerCase(), {
          name: cleanName,
          din: din || '-',
          designation: 'Director'
        });
      }
    }
  }

  // For messy OCR text: Find all 8-digit DIN numbers and look for names nearby
  const dinMatches = fullText.matchAll(/(\d{8})/g);
  for (const dinMatch of dinMatches) {
    const din = dinMatch[1];
    // Skip if this DIN is already found
    const existingDirector = Array.from(foundDirectors.values()).find(d => d.din === din);
    if (existingDirector) continue;

    // Look for names within 200 chars before/after the DIN
    const dinIndex = dinMatch.index;
    const contextBefore = fullText.substring(Math.max(0, dinIndex - 200), dinIndex);
    const contextAfter = fullText.substring(dinIndex + 8, Math.min(fullText.length, dinIndex + 208));

    // Look for capitalized names (2-4 words, each starting with capital)
    const namePatternStrict = /\b([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+){1,3})\b/g;

    let foundName = null;

    // Check context before DIN
    const namesBefore = [...contextBefore.matchAll(namePatternStrict)];
    for (const nm of namesBefore.reverse()) {
      const candidateName = nm[1].split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
      if (isValidPersonName(candidateName)) {
        foundName = candidateName;
        break;
      }
    }

    // Check context after DIN if not found
    if (!foundName) {
      const namesAfter = [...contextAfter.matchAll(namePatternStrict)];
      for (const nm of namesAfter) {
        const candidateName = nm[1].split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
        if (isValidPersonName(candidateName)) {
          foundName = candidateName;
          break;
        }
      }
    }

    if (foundName && !foundDirectors.has(foundName.toLowerCase())) {
      foundDirectors.set(foundName.toLowerCase(), {
        name: foundName,
        din: din,
        designation: 'Director'
      });
      console.log(`Found director from DIN context: ${foundName} (DIN: ${din})`);
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

// ===== File Compression Functions =====
const COMPRESS_THRESHOLD = 50 * 1024 * 1024; // 50MB

async function compressImage(filePath, originalSize) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const metadata = await sharp(filePath).metadata();

    let pipeline = sharp(filePath);

    // Resize if width or height > 4000px (maintain aspect ratio)
    if (metadata.width > 4000 || metadata.height > 4000) {
      pipeline = pipeline.resize(4000, 4000, { fit: 'inside', withoutEnlargement: true });
    }

    const tempPath = filePath + '.compressed.tmp';

    if (ext === '.jpg' || ext === '.jpeg') {
      await pipeline.jpeg({ quality: 70 }).toFile(tempPath);
    } else if (ext === '.png') {
      await pipeline.png({ quality: 70, compressionLevel: 9 }).toFile(tempPath);
    } else {
      // Unsupported image type for compression
      return { compressed: false, originalSize, newSize: originalSize };
    }

    const newSize = fs.statSync(tempPath).size;
    const reductionPct = ((originalSize - newSize) / originalSize) * 100;

    if (reductionPct >= 10) {
      fs.renameSync(tempPath, filePath);
      console.log(`📦 Image compressed: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(newSize / 1024 / 1024).toFixed(1)}MB (${reductionPct.toFixed(1)}% reduction)`);
      return { compressed: true, originalSize, newSize };
    } else {
      fs.unlinkSync(tempPath);
      console.log(`📦 Image compression skipped (only ${reductionPct.toFixed(1)}% reduction)`);
      return { compressed: false, originalSize, newSize: originalSize };
    }
  } catch (err) {
    console.error('Image compression error:', err.message);
    // Clean up temp file if exists
    const tempPath = filePath + '.compressed.tmp';
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return { compressed: false, originalSize, newSize: originalSize };
  }
}

async function compressPDF(filePath, originalSize) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, 'compress_pdf.py');
    const pythonProcess = spawn('python', [pythonScript, filePath], { shell: true });
    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    pythonProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    pythonProcess.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim());
        if (result.compressed) {
          console.log(`📦 PDF compressed: ${(result.originalSize / 1024 / 1024).toFixed(1)}MB → ${(result.newSize / 1024 / 1024).toFixed(1)}MB (${result.reductionPct}% reduction)`);
        } else {
          console.log(`📦 PDF compression skipped (${result.reductionPct || 0}% reduction)`);
        }
        resolve({ compressed: result.compressed, originalSize: result.originalSize, newSize: result.newSize });
      } catch (e) {
        console.error('PDF compression parse error:', e.message, 'stdout:', stdout, 'stderr:', stderr);
        resolve({ compressed: false, originalSize, newSize: originalSize });
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('PDF compression spawn error:', err.message);
      resolve({ compressed: false, originalSize, newSize: originalSize });
    });
  });
}

async function compressFileIfNeeded(filePath, fileSize, mimetype) {
  if (fileSize <= COMPRESS_THRESHOLD) {
    return { compressed: false, newSize: fileSize };
  }

  const ext = path.extname(filePath).toLowerCase();
  console.log(`📦 File exceeds 50MB (${(fileSize / 1024 / 1024).toFixed(1)}MB), attempting compression: ${path.basename(filePath)}`);

  if (mimetype === 'application/pdf' || ext === '.pdf') {
    const result = await compressPDF(filePath, fileSize);
    return { compressed: result.compressed, newSize: result.newSize };
  } else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    const result = await compressImage(filePath, fileSize);
    return { compressed: result.compressed, newSize: result.newSize };
  } else {
    console.log(`📦 No compression available for file type: ${ext}`);
    return { compressed: false, newSize: fileSize };
  }
}

// Background file processing function
async function processFilesInBackground(files, proposalId, fileDetails) {
  console.log(`🔄 Starting background processing for ${files.length} files...`);
  
  const proposal = await getProposalById(proposalId);
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
      
      // Process PDFs (use withTempFile since extraction scripts need file paths)
      if (file.mimetype === 'application/pdf') {
        try {
          console.log(`📄 Processing PDF: ${file.originalname}`);
          await withTempFile(file.buffer, file.filename, async (tempPath) => {
            // Use 3-tier fallback extraction
            const pdfResult = await extractPDFWithTableDetection(tempPath);
            fullText = pdfResult.text;
            extractedText = pdfResult.text.substring(0, 500);
            pageCount = pdfResult.numPages;

            // Store extracted tables for later use
            file.extractedTables = pdfResult.tables;
            file.structuredContent = pdfResult.structuredContent;

            console.log(`✓ Extracted ${pdfResult.tables.length} tables from ${file.originalname}`);

            // Tier 4: Vision OCR fallback for scanned PDFs
            const isEmptyText = !fullText || fullText.trim().length === 0;
            const isShortFinancialText = fileDetail.category === 'financials' && fullText && fullText.trim().length > 0 && fullText.trim().length < 2000 && pageCount > 1;
            if (isEmptyText || isShortFinancialText) {
              const ocrCategories = ['personalId', 'creditReports', 'financials', 'incorporation'];
              if (ocrCategories.includes(fileDetail.category)) {
                console.log(`⚠ ${isShortFinancialText ? 'Short text (' + fullText.trim().length + ' chars) for multi-page' : 'Empty text for'} ${fileDetail.category} PDF, trying Vision OCR fallback...`);
                try {
                  let ocrResult;
                  if (fileDetail.category === 'financials' || fileDetail.category === 'incorporation') {
                    ocrResult = await extractAllPagesWithVisionOCR(tempPath);
                  } else {
                    ocrResult = await extractTextFromScannedPDF(tempPath);
                  }
                  if (ocrResult.success && ocrResult.text) {
                    if (isShortFinancialText) {
                      fullText = fullText.trim() + '\n\n' + ocrResult.text;
                    } else {
                      fullText = ocrResult.text;
                    }
                    extractedText = fullText.substring(0, 500);
                    if (ocrResult.numPages) pageCount = ocrResult.numPages;
                    console.log(`✓ Vision OCR extracted ${ocrResult.charCount || ocrResult.text.length} characters from scanned PDF`);
                  }
                } catch (ocrErr) {
                  console.error('Vision OCR fallback error:', ocrErr.message);
                }
              }
            }
          });
        } catch (err) {
          console.error('PDF parsing error:', err);
        }
      }
      // Process images (JPG/PNG) with Vision OCR
      else if ((file.mimetype && (file.mimetype.startsWith('image/jpeg') ||
                                   file.mimetype.startsWith('image/png') ||
                                   file.mimetype === 'image/jpg')) ||
               /\.(jpe?g|png)$/i.test(file.originalname || file.filename || '')) {
        try {
          console.log(`🖼️ Processing image: ${file.originalname}`);
          await withTempFile(file.buffer, file.filename, async (tempPath) => {
            const ocrResult = await extractTextFromImage(tempPath);

            if (ocrResult.success && ocrResult.text) {
              fullText = ocrResult.text;
              extractedText = ocrResult.text.substring(0, 500);
              console.log(`✓ OCR extracted ${ocrResult.charCount} characters from ${file.originalname}`);
            } else {
              console.error('Image OCR failed:', ocrResult.error);
            }
          });
        } catch (err) {
          console.error('Image OCR error:', err);
        }
      }

      // Process Excel files (extract text and auto-extract debt profile)
      const fileExt = path.extname(file.originalname).toLowerCase();
      if (fileExt === '.xlsx' || fileExt === '.xls') {
        try {
          console.log(`📊 Processing Excel: ${file.originalname}`);
          const workbook = xlsx.read(file.buffer, { type: 'buffer' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          // Convert to text for storage
          const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '', header: 1 });
          fullText = rawData.map(row => row.join('\t')).join('\n');
          extractedText = fullText.substring(0, 500);
          console.log(`✓ Excel extracted ${rawData.length} rows from ${file.originalname}`);

          // Auto-extract debt profile if category is debtProfile
          if (fileDetail.category === 'debtProfile') {
            try {
              const data = findHeaderRowAndParseExcel(sheet);
              if (data.length > 0) {
                const mappedData = processDebtProfileData(data, proposalId);
                if (mappedData.length > 0) {
                  await DebtProfile.deleteMany({ proposalId: proposalId });
                  await DebtProfile.insertMany(mappedData);
                  console.log(`✓ Auto-extracted ${mappedData.length} debt profile entries`);
                }
              }
            } catch (debtErr) {
              console.error('Debt profile auto-extraction error:', debtErr.message);
            }
          }
        } catch (xlsErr) {
          console.error('Excel processing error:', xlsErr.message);
        }
      }

      // Re-read current category from saved proposal (user may have manually re-categorized)
      const latestProposal = await getProposalById(proposalId);
      const latestDoc = latestProposal ? latestProposal.documents.find(d => d.filename === fileDetail.filename) : null;
      if (latestDoc && latestDoc.manualCategory) {
        fileDetail.category = latestDoc.category;
        console.log(`📌 Using manual category "${latestDoc.category}" for ${file.originalname}`);
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

      // Extract CIBIL/Credit Score from credit reports
      if (fileDetail.category === 'creditReports' && fullText) {
        console.log('Processing Credit Report for score extraction:', file.originalname);
        const lowerName = file.originalname.toLowerCase();

        let cibilScore = null;
        let creditBureau = null;
        let personName = null;

        // Detect credit bureau type
        if (fullText.toLowerCase().includes('cibil') || fullText.toLowerCase().includes('transunion')) {
          creditBureau = 'CIBIL';
        } else if (fullText.toLowerCase().includes('experian')) {
          creditBureau = 'Experian';
        } else if (fullText.toLowerCase().includes('equifax')) {
          creditBureau = 'Equifax';
        } else if (fullText.toLowerCase().includes('crif') || fullText.toLowerCase().includes('high mark')) {
          creditBureau = 'CRIF High Mark';
        }

        // Extract CIBIL/Credit Score - common patterns
        const scorePatterns = [
          /cibil\s*score\s*(?:is|:)\s*(\d{3})/i,
          /credit\s*score\s*(?:is|:)\s*(\d{3})/i,
          /cibil\s*score[:\s]*(\d{3})/i,
          /credit\s*score[:\s]*(\d{3})/i,
          /score[:\s]*(\d{3})\s*(?:out of|\/)\s*900/i,
          /transunion\s*cibil\s*score[:\s]*(\d{3})/i,
          /your\s*score\s*(?:is|:)\s*(\d{3})/i,
          /your\s*score[:\s]*(\d{3})/i,
          /cibil\s*transunion\s*score[:\s]*(\d{3})/i,
          /(\d{3})\s*(?:cibil|credit)\s*score/i,
          /score\s*summary[:\s]*(\d{3})/i,
          /bureau\s*score[:\s]*(\d{3})/i
        ];

        for (const pattern of scorePatterns) {
          const match = fullText.match(pattern);
          if (match && match[1]) {
            const score = parseInt(match[1]);
            // Valid CIBIL scores are between 300-900
            if (score >= 300 && score <= 900) {
              cibilScore = score;
              break;
            }
          }
        }

        // Try to extract person/entity name from credit report
        const namePatterns = [
          /name[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$|date|address|pan)/i,
          /consumer\s*name[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$)/i,
          /applicant[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$)/i
        ];

        for (const pattern of namePatterns) {
          const match = fullText.match(pattern);
          if (match && match[1] && match[1].trim().length > 3) {
            personName = match[1].trim();
            break;
          }
        }

        if (cibilScore) {
          console.log(`✓ Extracted Credit Score: ${cibilScore} (${creditBureau || 'Unknown Bureau'})`);
          extractedDetails = {
            ...(extractedDetails || {}),
            cibilScore: cibilScore,
            creditBureau: creditBureau,
            personName: personName,
            documentType: 'Credit Report'
          };
        } else {
          console.log('⚠ Could not extract credit score from report');
        }
      }

      // Extract DOB from PAN card or Aadhaar card for personal ID documents
      if (fileDetail.category === 'personalId' && fullText) {
        const lowerText = fullText.toLowerCase();
        const lowerName = file.originalname.toLowerCase();

        const isPAN = lowerName.includes('pan') || lowerText.includes('permanent account number') || lowerText.includes('income tax department');
        const isAadhaar = lowerName.includes('aadhar') || lowerName.includes('aadhaar') || lowerText.includes('aadhaar') || lowerText.includes('unique identification');

        if (isPAN || isAadhaar) {
          const docType = isPAN ? 'PAN Card' : 'Aadhaar Card';
          console.log(`Processing ${docType} for DOB extraction:`, file.originalname);

          let dateOfBirth = null;

          const dobPatterns = [
            /date\s*of\s*birth[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
            /dob[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
            /birth[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
            /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s*date\s*of\s*birth/i,
            /DOB\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/,
            /Year\s*of\s*Birth[:\s]*(\d{4})/i
          ];

          // PAN cards often have standalone dates without labels
          if (isPAN) {
            dobPatterns.push(
              /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/  // Any date in DD/MM/YYYY format
            );
          }

          // Aadhaar-specific patterns (DOB or Year of Birth)
          if (isAadhaar) {
            dobPatterns.push(
              /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/,  // Any date in DD/MM/YYYY format
              /जन्म\s*तिथि[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i  // Hindi DOB
            );
          }

          for (const pattern of dobPatterns) {
            const match = fullText.match(pattern);
            if (match && match[1]) {
              dateOfBirth = match[1];
              break;
            }
          }

          if (dateOfBirth) {
            console.log(`✓ Extracted DOB from ${docType}:`, dateOfBirth);
            extractedDetails = {
              ...(extractedDetails || {}),
              dateOfBirth: dateOfBirth,
              documentType: docType
            };
          }

          // Extract PAN number if PAN card
          if (isPAN) {
            const panMatch = fullText.match(/[A-Z]{5}[0-9]{4}[A-Z]/);
            if (panMatch) {
              extractedDetails = {
                ...(extractedDetails || {}),
                panNumber: panMatch[0]
              };
              console.log('✓ Extracted PAN number:', panMatch[0]);
            }
          }

          // Extract Aadhaar number if Aadhaar card
          if (isAadhaar) {
            const aadhaarMatch = fullText.match(/\b(\d{4}\s?\d{4}\s?\d{4})\b/);
            if (aadhaarMatch) {
              extractedDetails = {
                ...(extractedDetails || {}),
                aadhaarNumber: aadhaarMatch[1].replace(/\s/g, '')
              };
              console.log('✓ Extracted Aadhaar number:', aadhaarMatch[1]);
            }
          }
        }
      }

      // Note: Title document extraction from collateral docs is done via "Extract from Documents" button
      // after user has classified documents as "Title Documents". See /reprocess-collateral route.

      // Run auto-classification (may involve API call which takes time)
      let autoClassification = '';
      const preClassifyProposal = await getProposalById(proposalId);
      const preClassifyDoc = preClassifyProposal?.documents?.find(d => d.filename === fileDetail.filename);
      const effectiveCategory = (preClassifyDoc && preClassifyDoc.manualCategory) ? preClassifyDoc.category : fileDetail.category;

      if (effectiveCategory && !(preClassifyDoc && preClassifyDoc.manualClassification)) {
        try {
          autoClassification = await autoClassifyDocument(
            file.originalname,
            fullText,
            effectiveCategory,
            preClassifyProposal
          );
          if (autoClassification) {
            console.log(`📋 Auto-classified "${file.originalname}" as: ${autoClassification}`);
          }
        } catch (classErr) {
          console.error('Auto-classification error:', classErr.message);
        }
      }

      // Atomic update: re-read proposal, update ONLY this document, save immediately
      // This prevents overwriting manual changes made to OTHER documents during processing
      const saveProposal = await getProposalById(proposalId);
      if (saveProposal && saveProposal.documents) {
        const docIndex = saveProposal.documents.findIndex(d => d.filename === fileDetail.filename);
        if (docIndex !== -1) {
          const currentDoc = saveProposal.documents[docIndex];

          // Always update extracted data (pages, text, details)
          currentDoc.pages = pageCount;
          const currentCategory = currentDoc.category || fileDetail.category;
          const fullTextCategories = ['financials', 'turnover', 'banking', 'collateral', 'otherIncome', 'otherDocuments'];
          if (fullTextCategories.includes(currentCategory)) {
            currentDoc.extractedText = fullText;
          } else {
            currentDoc.extractedText = extractedText;
          }
          currentDoc.extractedDetails = extractedDetails;

          // Only set auto-classification if user hasn't manually classified
          if (!currentDoc.manualClassification) {
            currentDoc.classification = autoClassification;
          } else {
            console.log(`⏭️ Keeping manual classification "${currentDoc.classification}" for "${file.originalname}"`);
          }

          // Only set auto-category if user hasn't manually categorized
          if (currentDoc.manualCategory) {
            console.log(`⏭️ Keeping manual category "${currentDoc.category}" for "${file.originalname}"`);
          } else if (!currentDoc.category && fullText) {
            // Re-run categorization using extracted text for uncategorized docs
            let textCategory = autoCategorizeDocument(file.originalname, fullText);
            if (textCategory) {
              console.log(`🔍 Text-based re-categorization: "${file.originalname}" → ${textCategory}`);
            }

            // If text patterns fail, try AI categorization as fallback
            if (!textCategory) {
              try {
                textCategory = await aiCategorizeDocument(fullText, file.originalname);
                if (textCategory) {
                  console.log(`🤖 AI categorization: "${file.originalname}" → ${textCategory}`);
                }
              } catch (aiCatErr) {
                console.error('AI categorization error:', aiCatErr.message);
              }
            }

            if (textCategory) {
              currentDoc.category = textCategory;
              currentDoc.autoCategorized = true;
              fileDetail.category = textCategory;
              // Re-run classification with new category
              try {
                const reclassProposal = await getProposalById(proposalId);
                const reclass = await autoClassifyDocument(file.originalname, fullText, textCategory, reclassProposal);
                if (reclass) {
                  currentDoc.classification = reclass;
                  autoClassification = reclass;
                  console.log(`📋 Re-classified "${file.originalname}" as: ${reclass}`);
                }
              } catch (reclassErr) {
                console.error('Re-classification error:', reclassErr.message);
              }
            }
          }

          saveProposal.documents[docIndex] = currentDoc;
          await updateProposal(proposalId, { documents: saveProposal.documents });
          console.log(`✓ Updated document: ${file.originalname}`);
        }
      }
    } catch (error) {
      console.error(`Error processing file ${file.originalname}:`, error);
    }
  }
  
  console.log(`✅ Background processing complete for proposal ${proposalId}`);
}

// Health check
app.get('/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const state = mongoose.connection.readyState;
  res.json({
    status: state === 1 ? 'ok' : 'degraded',
    mongodb: dbStates[state] || 'unknown',
    uptime: process.uptime(),
    env: (process.env.MONGODB_URL || process.env.MONGO_URL) ? 'MongoDB URL set' : 'MongoDB URL NOT SET'
  });
});

// Routes
app.get('/', (req, res) => {
  res.render('dashboard', { user: 'Associate' });
});

// Stage 1: Customer Proposal Form
app.get('/stage1/new', (req, res) => {
  res.render('stage1-proposal');
});

app.post('/stage1/submit', async (req, res) => {
  try {
    console.log('Stage 1 submit received, MongoDB state:', mongoose.connection.readyState);
    if (mongoose.connection.readyState !== 1) {
      console.error('MongoDB not connected. readyState:', mongoose.connection.readyState);
      return res.status(503).json({ success: false, error: 'Database not connected. Please try again in a few seconds.' });
    }
    if (!req.body || !req.body.applicantName) {
      console.error('Empty or invalid request body:', JSON.stringify(req.body).substring(0, 200));
      return res.status(400).json({ success: false, error: 'Invalid form data received.' });
    }
    const proposal = await saveProposal(req.body);
    console.log('Stage 1 proposal saved successfully, id:', proposal.id);
    res.json({ success: true, proposalId: proposal.id });
  } catch (error) {
    console.error('Stage 1 submit error:', error.name, error.message, error.stack);
    res.status(500).json({ success: false, error: error.message });
  }
});

// View all proposals
app.get('/proposals', async (req, res) => {
  try {
    const proposals = await getProposals();
    res.render('proposals-list', { proposals });
  } catch (error) {
    res.status(500).send('Error loading proposals: ' + error.message);
  }
});

// Edit proposal
app.get('/proposals/:proposalId/edit', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) {
      return res.status(404).send('Proposal not found');
    }
    res.render('edit-proposal', { proposal });
  } catch (error) {
    res.status(500).send('Error loading proposal: ' + error.message);
  }
});

app.post('/proposals/:proposalId/update', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const updates = req.body;
    const updatedProposal = await updateProposal(proposalId, updates);
    
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
app.post('/proposals/:proposalId/delete', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const result = await Proposal.deleteOne({ id: proposalId });

    if (result.deletedCount > 0) {
      // Delete all uploaded files for this proposal from GridFS
      await deleteAllByProposal(proposalId);

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
  const proposal = await getProposalById(req.params.proposalId);
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
      extractedText: doc.extractedText, // Ensure extractedText is available for GST dashboard
      financialComponents: doc.financialComponents // Include financial components for ITR parsing
    }));
    
    // Remove duplicate files by originalName (keep the first occurrence/most recent)
    const seenNames = new Set();
    uploadedFiles = uploadedFiles.filter(file => {
      if (seenNames.has(file.originalName)) {
        return false; // Skip duplicate
      }
      seenNames.add(file.originalName);
      return true;
    });
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
  upload.array('documents', 500)(req, res, async (err) => {
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
    const proposal = await getProposalById(proposalId);
    const existingDocuments = proposal.documents || [];
    
    // Process files - extract zip/rar files if any (all in-memory)
    const allFiles = [];

    for (const file of files) {
      const fileExt = path.extname(file.originalname).toLowerCase();
      // Generate filename since memoryStorage doesn't set it
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);

      if (fileExt === '.zip') {
        // Extract zip file from buffer
        try {
          const zip = new AdmZip(file.buffer);
          const zipEntries = zip.getEntries();

          zipEntries.forEach(entry => {
            if (!entry.isDirectory && !entry.entryName.startsWith('__MACOSX') && !entry.name.startsWith('.')) {
              const entryBuffer = entry.getData();
              const extractedFileName = `${Date.now()}-${entry.name}`;

              allFiles.push({
                filename: extractedFileName,
                originalname: entry.name,
                buffer: entryBuffer,
                size: entryBuffer.length,
                mimetype: entry.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
              });
            }
          });
        } catch (err) {
          console.error('Zip extraction error:', err);
          const fallbackName = file.fieldname + '-' + uniqueSuffix + fileExt;
          allFiles.push({ filename: fallbackName, originalname: file.originalname, buffer: file.buffer, size: file.buffer.length, mimetype: file.mimetype });
        }
      } else if (fileExt === '.rar') {
        // Extract rar file from buffer
        try {
          const extractor = await createExtractorFromData({ data: new Uint8Array(file.buffer) });
          const extracted = extractor.extract();
          for (const entry of extracted.files) {
            if (!entry.fileHeader.flags.directory) {
              const entryName = path.basename(entry.fileHeader.name);
              if (entryName.startsWith('.') || entry.fileHeader.name.startsWith('__MACOSX')) continue;
              const entryBuffer = Buffer.from(entry.extraction);
              const extractedFileName = `${Date.now()}-${entryName}`;
              allFiles.push({
                filename: extractedFileName,
                originalname: entryName,
                buffer: entryBuffer,
                size: entryBuffer.length,
                mimetype: entryName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'
              });
            }
          }
        } catch (err) {
          console.error('RAR extraction error:', err);
          const fallbackName = file.fieldname + '-' + uniqueSuffix + fileExt;
          allFiles.push({ filename: fallbackName, originalname: file.originalname, buffer: file.buffer, size: file.buffer.length, mimetype: file.mimetype });
        }
      } else {
        // Regular file
        const generatedName = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
        allFiles.push({
          filename: generatedName,
          originalname: file.originalname,
          buffer: file.buffer,
          size: file.buffer.length,
          mimetype: file.mimetype
        });
      }
    }

    // Compress large files (>50MB) using temp files
    for (const file of allFiles) {
      if (file.size > COMPRESS_THRESHOLD) {
        try {
          const compressedBuffer = await withTempFile(file.buffer, file.filename, async (tempPath) => {
            const result = await compressFileIfNeeded(tempPath, file.size, file.mimetype);
            if (result.compressed) {
              file.size = result.newSize;
              return fs.readFileSync(tempPath);
            }
            return null;
          });
          if (compressedBuffer) {
            file.buffer = compressedBuffer;
          }
        } catch (compErr) {
          console.error('Compression error:', compErr.message);
        }
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
      return res.status(400).json({
        success: false,
        error: `Duplicate files detected: ${duplicates.join(', ')}. These documents have already been uploaded.`,
        duplicates: duplicates
      });
    }

    // Save files to GridFS and create file details
    const fileDetails = [];
    for (const file of allFiles) {
      // Auto-categorize based on filename only (quick)
      const autoCategory = autoCategorizeDocument(file.originalname, '');

      // Save to GridFS with proposal metadata
      await saveToGridFS(file.buffer, file.filename, { proposalId, originalName: file.originalname });

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
    await updateProposal(proposalId, { documents: proposal.documents });

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
app.post('/stage2/:proposalId/delete-multiple-documents', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileIds } = req.body;

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ success: false, error: 'File IDs array is required' });
    }

    // Get proposal
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    if (!proposal.documents || !Array.isArray(proposal.documents)) {
      return res.status(400).json({ success: false, error: 'No documents found in proposal' });
    }

    let deletedCount = 0;
    const errors = [];

    // Process each file ID
    for (const fileId of fileIds) {
      const docIndex = proposal.documents.findIndex(doc => doc.id === fileId || doc.filename === fileId);

      if (docIndex !== -1) {
        const document = proposal.documents[docIndex];

        // Delete file from GridFS
        try {
          await deleteFromGridFS(document.filename);
          deletedCount++;
        } catch (err) {
          errors.push(`Failed to delete file: ${document.originalName}`);
        }

        // Remove from proposal documents array
        proposal.documents.splice(docIndex, 1);
      } else {
        errors.push(`Document not found: ${fileId}`);
      }
    }

    // Update proposal
    await updateProposal(proposalId, { documents: proposal.documents });

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
app.post('/stage2/:proposalId/delete-document', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId } = req.body;
    
    console.log('Delete request - ProposalId:', proposalId, 'FileId:', fileId);
    
    if (!fileId) {
      return res.status(400).json({ success: false, error: 'File ID is required' });
    }
    
    // Get proposal
    const proposal = await getProposalById(proposalId);
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

    // Delete file from GridFS
    console.log('Attempting to delete file from GridFS:', document.filename);
    try {
      await deleteFromGridFS(document.filename);
      console.log('File deleted from GridFS successfully');
    } catch (delErr) {
      console.log('GridFS delete error (may not exist):', delErr.message);
    }

    // Remove from proposal documents array
    proposal.documents.splice(docIndex, 1);
    await updateProposal(proposalId, { documents: proposal.documents });

    console.log('Document removed from proposal. Remaining:', proposal.documents.length);

    res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Serve uploaded files from GridFS
app.get('/uploads/:proposalId/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const exists = await existsInGridFS(filename);
    if (!exists) {
      return res.status(404).send('File not found');
    }

    // Set Content-Type based on extension
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.zip': 'application/zip', '.rar': 'application/x-rar-compressed'
    };
    if (mimeTypes[ext]) res.set('Content-Type', mimeTypes[ext]);

    await streamFromGridFS(filename, res);
  } catch (err) {
    console.error('File serve error:', err.message);
    res.status(404).send('File not found');
  }
});

// Decrypt password-protected PDF and save without password (GridFS)
app.post('/api/decrypt-pdf', async (req, res) => {
  try {
    const { proposalId, filename, password } = req.body;

    if (!proposalId || !filename || !password) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const exists = await existsInGridFS(filename);
    if (!exists) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    // Read file from GridFS, decrypt via temp file, save back
    const fileBuffer = await readFromGridFS(filename);

    await withTempFile(fileBuffer, filename, async (tempPath) => {
      const tempDecrypted = tempPath + '.decrypted.tmp';
      const useQpdf = process.platform !== 'win32';

      if (useQpdf) {
        await new Promise((resolve, reject) => {
          const qpdfProcess = spawn('qpdf', ['--password=' + password, '--decrypt', tempPath, tempDecrypted]);
          let stderr = '';
          qpdfProcess.stderr.on('data', (data) => { stderr += data.toString(); });
          qpdfProcess.on('close', (code) => {
            if (code === 0 || (code === 3 && fs.existsSync(tempDecrypted))) {
              resolve();
            } else {
              if (fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted);
              if (stderr.includes('invalid password')) {
                reject(new Error('INCORRECT_PASSWORD'));
              } else {
                reject(new Error(stderr.trim() || 'Failed to decrypt PDF'));
              }
            }
          });
          qpdfProcess.on('error', (err) => reject(new Error('qpdf not available: ' + err.message)));
        });
      } else {
        const pythonScript = path.join(__dirname, 'decrypt_pdf.py');
        await new Promise((resolve, reject) => {
          const pythonProcess = spawn('python', [pythonScript, tempPath, password], { shell: true });
          let stderr = '';
          pythonProcess.stderr.on('data', (data) => { stderr += data.toString(); });
          pythonProcess.on('close', (code) => {
            if (code === 0) {
              // Python script modifies file in-place, so decrypted file is at tempPath
              resolve();
            } else {
              const errorMsg = stderr.trim();
              if (errorMsg.includes('Incorrect password')) {
                reject(new Error('INCORRECT_PASSWORD'));
              } else {
                reject(new Error(errorMsg || 'Failed to decrypt PDF'));
              }
            }
          });
          pythonProcess.on('error', (err) => reject(new Error('Failed to run decryption: ' + err.message)));
        });
      }

      // Read decrypted file and save back to GridFS
      const decryptedPath = useQpdf ? tempDecrypted : tempPath;
      const decryptedBuffer = fs.readFileSync(decryptedPath);
      if (useQpdf && fs.existsSync(tempDecrypted)) fs.unlinkSync(tempDecrypted);

      // Delete old and save new
      await deleteFromGridFS(filename);
      await saveToGridFS(decryptedBuffer, filename, { proposalId });
    });

    res.json({ success: true, message: 'PDF decrypted successfully' });
  } catch (error) {
    console.error('PDF decryption error:', error);
    if (error.message === 'INCORRECT_PASSWORD') {
      return res.status(401).json({ success: false, error: 'Incorrect password' });
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to decrypt PDF' });
  }
});

app.post('/stage2/:proposalId/categorize', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId, category } = req.body;
    
    const proposal = await getProposalById(proposalId);
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
      proposal.documents[fileIndex].manualCategory = true;
      // Clear classification if category changes
      proposal.documents[fileIndex].classification = '';
      proposal.documents[fileIndex].manualClassification = false;
      await updateProposal(proposalId, { documents: proposal.documents });
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
app.post('/stage2/:proposalId/classify', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fileId, classification } = req.body;
    
    const proposal = await getProposalById(proposalId);
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
      proposal.documents[fileIndex].manualClassification = true;
      await updateProposal(proposalId, { documents: proposal.documents });
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
    
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    let processedCount = 0;
    const extractionResults = [];
    let updated = false;

    // Process each incorporation document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];

      if (doc.category === 'incorporation') {
        const fileExists = await existsInGridFS(doc.filename);

        if (fileExists && doc.originalName.toLowerCase().endsWith('.pdf')) {
          // For Private Limited companies, prioritize "List of Directors & Shareholders" document
          // Fallback to AOA only if the dedicated document is not available
          if (proposal.applicantType === 'Private Limited' || proposal.applicantType === 'Public Limited') {
            const classification = (doc.classification || '').toLowerCase();
            const originalName = (doc.originalName || '').toLowerCase();
            const isShareholderDoc = classification.includes('list of shareholders') ||
                                     originalName.includes('list of director') ||
                                     originalName.includes('list of shareholder');
            const isAOA = classification.includes('articles of association') || originalName.includes('aoa');

            // Check if a dedicated "List of Directors & Shareholders" document exists in this proposal
            const hasDirectorListDoc = proposal.documents.some(d => {
              const dClass = (d.classification || '').toLowerCase();
              const dName = (d.originalName || '').toLowerCase();
              return dClass.includes('list of shareholders') ||
                     dName.includes('list of director') ||
                     dName.includes('list of shareholder');
            });

            if (!isShareholderDoc) {
              // If dedicated director list exists, clear directors from AOA (use director list as primary)
              if (hasDirectorListDoc && isAOA) {
                console.log(`⏭️ Skipping ${doc.originalName} - "List of Directors & Shareholders" document available as primary source`);
                if (doc.extractedDetails && doc.extractedDetails.directors && doc.extractedDetails.directors.length > 0) {
                  console.log(`🧹 Clearing ${doc.extractedDetails.directors.length} previously extracted directors from AOA (using dedicated document instead)`);
                  doc.extractedDetails.directors = [];
                  proposal.documents[i] = doc;
                  updated = true;
                }
                continue;
              }
              // If no dedicated director list exists, skip non-AOA documents
              if (!isAOA) {
                console.log(`⏭️ Skipping ${doc.originalName} - not a List of Shareholders or AOA document`);
                continue;
              }
              // If this is AOA and no dedicated list exists, process it as fallback
              console.log(`📋 Processing ${doc.originalName} as fallback (no dedicated List of Directors & Shareholders document found)`);
            }
          }

          try {
            const fileBuffer = await readFromGridFS(doc.filename);
            await withTempFile(fileBuffer, doc.filename, async (filePath) => {
            // Use table-aware extraction for reprocessing
            const pdfResult = await extractPDFWithTableDetection(filePath);
            let fullText = pdfResult.text;

            // Vision OCR fallback for scanned/image PDFs (empty or very short text)
            if (!fullText || fullText.trim().length < 20) {
              console.log(`⚠ Empty/short text (${fullText ? fullText.trim().length : 0} chars) for incorporation doc, trying Vision OCR...`);
              try {
                const ocrResult = await extractAllPagesWithVisionOCR(filePath);
                if (ocrResult.success && ocrResult.text && ocrResult.text.trim().length > 20) {
                  fullText = ocrResult.text;
                  pdfResult.method = 'gemini-vision-ocr';
                  if (ocrResult.numPages) pdfResult.numPages = ocrResult.numPages;
                  console.log(`✓ Vision OCR extracted ${fullText.length} characters from scanned incorporation PDF`);
                }
              } catch (ocrErr) {
                console.error('Vision OCR fallback error for incorporation doc:', ocrErr.message);
              }
            }

            console.log('\n========================================');
            console.log('📄 EXTRACTING:', doc.originalName);
            console.log('Classification:', doc.classification || 'None');
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
              console.log('📊 Extracting Private Limited company details from List of Shareholders document...');

              // Try Document AI first for better accuracy
              try {
                console.log('🤖 Attempting Document AI extraction for Private Limited...');
                const aiResult = await extractWithDocumentAI(fullText, 'private-limited', pdfResult.tables || []);

                if (aiResult.success && aiResult.data) {
                  console.log('✓ Document AI extraction successful for Private Limited');
                  extractedDetails = {
                    companyName: aiResult.data.companyName || null,
                    cin: aiResult.data.cin || null,
                    dateOfIncorporation: aiResult.data.dateOfIncorporation || null,
                    shareholders: aiResult.data.shareholders || [],
                    directors: aiResult.data.directors || []
                  };
                  rawExtraction.method = 'Document AI (Private Limited)';
                } else {
                  console.log('⚠ Document AI failed, using fallback extraction');
                  extractedDetails = extractPrivateLimitedDetails(fullText, pdfResult.tables || []);
                  rawExtraction.method = 'Pattern Matching (Private Limited)';
                }
              } catch (aiErr) {
                console.log('⚠ Document AI error, using fallback:', aiErr.message);
                extractedDetails = extractPrivateLimitedDetails(fullText, pdfResult.tables || []);
                rawExtraction.method = 'Pattern Matching (Private Limited)';
              }

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

            proposal.documents[i].extractedText = fullText; // Save extracted text
            proposal.documents[i].extractedDetails = extractedDetails;
            proposal.documents[i].pages = pdfResult.numPages; // Save page count
            
            extractionResults.push({
              fileName: doc.originalName,
              ...rawExtraction,
              extractedData: extractedDetails
            });
            
            console.log('Updated extractedDetails for:', doc.originalName);
            processedCount++;
            }); // end withTempFile
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
      await updateProposal(proposalId, { documents: proposal.documents });
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

// Dismiss a pending document item (mark as not required)
app.post('/stage2/:proposalId/dismiss-pending', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { category, pendingText } = req.body;

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    // Initialize dismissedPendingDocs if not exists
    if (!proposal.dismissedPendingDocs) {
      proposal.dismissedPendingDocs = [];
    }

    // Add to dismissed list
    proposal.dismissedPendingDocs.push({
      category,
      text: pendingText,
      dismissedAt: new Date().toISOString()
    });

    // Save proposal
    await updateProposal(proposalId, { dismissedPendingDocs: proposal.dismissedPendingDocs });

    res.json({ success: true, message: 'Pending item dismissed' });
  } catch (error) {
    console.error('Error dismissing pending item:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save title documents for collateral
app.post('/stage2/:proposalId/title-documents', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { titleDocuments } = req.body;

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    await updateProposal(proposalId, { titleDocuments: titleDocuments || [] });

    res.json({ success: true, message: 'Title documents saved' });
  } catch (error) {
    console.error('Error saving title documents:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reprocess collateral documents to extract title document details
app.post('/stage2/:proposalId/reprocess-collateral', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const titleClassifications = ['title documents', 'title documents - unregistered'];
    const collateralDocs = (proposal.documents || []).filter(d =>
      d.category === 'collateral' &&
      d.classification &&
      titleClassifications.includes(d.classification.toLowerCase())
    );
    if (collateralDocs.length === 0) {
      return res.json({ success: false, error: 'No documents classified as "Title Documents" found. Please upload collateral documents and classify them as "Title Documents" first.' });
    }

    console.log(`\n📜 Reprocessing ${collateralDocs.length} collateral document(s) for proposal ${proposalId}`);
    let extractedTitleDocs = [];
    let processedCount = 0;

    for (const doc of collateralDocs) {
      try {
        const fileExists = await existsInGridFS(doc.filename);
        if (!fileExists) {
          console.log(`⚠ File not found in GridFS: ${doc.filename}`);
          continue;
        }

        // Extract text from PDF
        let fullText = doc.extractedText || '';
        let tables = [];
        if (doc.filename.endsWith('.pdf')) {
          const fileBuffer = await readFromGridFS(doc.filename);
          await withTempFile(fileBuffer, doc.filename, async (filePath) => {
            const pdfResult = await extractPDFWithTableDetection(filePath);
            fullText = pdfResult.text;
            tables = pdfResult.tables || [];

            // Vision OCR fallback for scanned PDFs
            if (!fullText || fullText.trim().length < 500) {
              console.log(`⚠ Short text (${fullText.length} chars) for collateral doc, trying Vision OCR...`);
              try {
                const ocrResult = await extractAllPagesWithVisionOCR(filePath);
                if (ocrResult.success && ocrResult.text && ocrResult.text.length > fullText.length) {
                  fullText = ocrResult.text;
                  console.log(`✓ Vision OCR improved text: ${fullText.length} chars`);
                }
              } catch (ocrErr) {
                console.error('Vision OCR error:', ocrErr.message);
              }
            }
          });

          // Update stored text
          const docIdx = proposal.documents.findIndex(d => d.filename === doc.filename);
          if (docIdx !== -1) {
            proposal.documents[docIdx].extractedText = fullText;
          }
        }

        if (!fullText || fullText.trim().length < 50) {
          console.log(`⚠ Insufficient text for ${doc.originalName}, skipping`);
          continue;
        }

        // AI extraction
        const aiResult = await extractWithDocumentAI(fullText, 'title-document', tables);
        if (aiResult.success && aiResult.data && aiResult.data.titleDocuments && aiResult.data.titleDocuments.length > 0) {
          console.log(`✓ Extracted ${aiResult.data.titleDocuments.length} title doc(s) from ${doc.originalName}`);
          extractedTitleDocs.push(...aiResult.data.titleDocuments);

          // Update extractedDetails on the document
          const docIdx = proposal.documents.findIndex(d => d.filename === doc.filename);
          if (docIdx !== -1) {
            proposal.documents[docIdx].extractedDetails = {
              ...(proposal.documents[docIdx].extractedDetails || {}),
              titleDocuments: aiResult.data.titleDocuments,
              documentType: 'Title Document'
            };
          }
          processedCount++;
        } else {
          console.log(`⚠ No title documents extracted from ${doc.originalName}`);
        }
      } catch (docErr) {
        console.error(`Error processing ${doc.originalName}:`, docErr.message);
      }
    }

    // Merge into proposal.titleDocuments (deduplicate by documentNo)
    if (!proposal.titleDocuments) proposal.titleDocuments = [];
    extractedTitleDocs.forEach(td => {
      const exists = proposal.titleDocuments.some(existing =>
        existing.documentNo && td.documentNo &&
        existing.documentNo.trim().toLowerCase() === td.documentNo.trim().toLowerCase()
      );
      if (!exists) {
        proposal.titleDocuments.push(td);
      }
    });

    await updateProposal(proposalId, {
      documents: proposal.documents,
      titleDocuments: proposal.titleDocuments
    });

    console.log(`✅ Collateral reprocessing complete: ${processedCount} doc(s) processed, ${proposal.titleDocuments.length} total title entries`);
    res.json({
      success: true,
      message: `Extracted from ${processedCount} document(s). ${extractedTitleDocs.length} title document(s) found.`,
      titleDocuments: proposal.titleDocuments
    });
  } catch (error) {
    console.error('Reprocess collateral error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reprocess banking documents to extract bank statement details
app.post('/stage2/:proposalId/reprocess-banking', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    
    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }
    
    let processedCount = 0;
    const extractionResults = [];

    // Process each banking document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];

      if (doc.category === 'banking') {
        const fileExists = await existsInGridFS(doc.filename);

        if (fileExists && doc.originalName.toLowerCase().endsWith('.pdf')) {
          try {
            const fileBuffer = await readFromGridFS(doc.filename);
            let fullText = '';
            let pdfResult;
            let bankStatementDetails;

            await withTempFile(fileBuffer, doc.filename, async (filePath) => {
            // Use table-aware extraction for bank statements
            pdfResult = await extractPDFWithTableDetection(filePath);
            fullText = pdfResult.text;
            
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
            
            if (aiResult.success && aiResult.data) {
              console.log('✓ Document AI extraction successful for:', doc.originalName);
              console.log('AI Extracted Data:', JSON.stringify(aiResult.data, null, 2));

              // Validate AI-extracted account holder against actual text (prevent hallucination)
              let aiAccountHolder = aiResult.data.accountHolder || 'N/A';
              if (aiAccountHolder && aiAccountHolder !== 'N/A') {
                const headerText = fullText.substring(0, 1500).toUpperCase();
                const holderUpper = aiAccountHolder.toUpperCase().trim();
                if (!headerText.includes(holderUpper)) {
                  console.log(`⚠ AI account holder "${aiAccountHolder}" NOT found in header text, using fallback extraction`);
                  // Try fallback extraction for account holder
                  const fallbackDetails = extractBankStatementDetailsFallback(fullText, doc.originalName);
                  aiAccountHolder = fallbackDetails.accountHolder || 'N/A';
                  console.log(`  Fallback account holder: "${aiAccountHolder}"`);
                }
              }

              // Extract last 4 digits from account number for matching masked accounts
              const acNo = aiResult.data.accountNumber || '';
              const digitsOnly = acNo.replace(/[^0-9]/g, '');
              const last4 = digitsOnly.length >= 4 ? digitsOnly.slice(-4) : (digitsOnly || 'N/A');

              bankStatementDetails = {
                bankName: aiResult.data.bankName || 'N/A',
                accountHolder: aiAccountHolder,
                accountNumber: aiResult.data.accountNumber || 'N/A',
                last4Digits: last4,
                periodFrom: aiResult.data.periodFrom || 'N/A',
                periodTo: aiResult.data.periodTo || 'N/A',
                period: (aiResult.data.periodFrom && aiResult.data.periodTo)
                  ? `${aiResult.data.periodFrom} to ${aiResult.data.periodTo}`
                  : 'N/A'
              };
            } else {
              console.log('⚠ Document AI failed, using fallback for:', doc.originalName);
              // Fallback pattern matching for bank statements
              bankStatementDetails = extractBankStatementDetailsFallback(fullText, doc.originalName);
            }
            
            // Fallback: Try to extract dates from filename if still N/A
            if (bankStatementDetails.periodFrom === 'N/A' || bankStatementDetails.periodTo === 'N/A') {
              const filename = doc.originalName || '';
              // Match patterns like: dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy
              const datePatterns = [
                /(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})\s*(?:to|TO|-)\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/,
                /(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4}).*?(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/
              ];

              for (const pattern of datePatterns) {
                const match = filename.match(pattern);
                if (match) {
                  // Normalize date format to dd/mm/yyyy
                  const normalizeDate = (dateStr) => {
                    const parts = dateStr.split(/[-\/\.]/);
                    if (parts.length === 3) {
                      let [d, m, y] = parts;
                      if (y.length === 2) y = '20' + y;
                      return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
                    }
                    return dateStr;
                  };

                  bankStatementDetails.periodFrom = normalizeDate(match[1]);
                  bankStatementDetails.periodTo = normalizeDate(match[2]);
                  bankStatementDetails.period = `${bankStatementDetails.periodFrom} - ${bankStatementDetails.periodTo}`;
                  console.log('✓ Extracted dates from filename:', bankStatementDetails.period);
                  break;
                }
              }
            }

            console.log('\n📋 FINAL EXTRACTED BANK DETAILS:');
            console.log(JSON.stringify(bankStatementDetails, null, 2));
            console.log('========================================\n');

            }); // end withTempFile

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
      await updateProposal(proposalId, { documents: proposal.documents });
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

// Fallback regex-based financial extraction from ITR / P&L / Balance Sheet text
function extractFinancialDetailsFallback(text) {
  const result = { turnover: null, grossProfit: null, netProfit: null, depreciation: null, interestOnLoans: null, assessmentYear: null };

  // Helper: parse Indian currency format - handles OCR artifacts where commas are read as periods
  // e.g., "1,80,72,865" or "87.75.935" or "26.41,469" or "19010274"
  const parseCurrency = (str) => {
    if (!str) return null;
    // Remove spaces
    let cleaned = str.replace(/\s/g, '');
    // If the number has multiple periods (e.g., "87.75.935"), treat ALL periods as thousand separators (OCR artifact)
    const periodCount = (cleaned.match(/\./g) || []).length;
    if (periodCount > 1) {
      cleaned = cleaned.replace(/[.,]/g, '');
    } else if (periodCount === 1) {
      // Single period: if it has exactly 2 digits after it and is at the end, it's a decimal point
      // Otherwise (e.g., "26.41,469"), it's a misread comma
      if (/\.\d{2}$/.test(cleaned) && !cleaned.includes(',')) {
        cleaned = cleaned.replace(/,/g, '');
      } else {
        cleaned = cleaned.replace(/[.,]/g, '');
      }
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  };

  // Regex token for Indian currency amounts (digits with commas or periods as separators)
  const AMT = '[\\d][\\d,. ]*[\\d]';

  // Assessment Year
  const ayMatch = text.match(/Assessment\s*Year[:\s]*(\d{4}[-–]\d{2,4})/i);
  if (ayMatch) result.assessmentYear = ayMatch[1];

  // Turnover / Sales - look in P&L section
  const turnoverPatterns = [
    new RegExp(`Total\\s*Turnover\\s*as\\s*per\\s*Form\\s*3CD[:\\s]*[\\d()\\s]*?[:\\s]*(${AMT})`, 'i'),
    new RegExp(`By\\s+Sales\\s+(${AMT})`, 'i'),
    new RegExp(`(?:^|\\n)\\s*(?:Total\\s+)?Sales\\s+(${AMT})`, 'im'),
    new RegExp(`(?:^|\\n)\\s*Total\\s+(?:Revenue|Turnover|Receipts)\\s+(${AMT})`, 'im')
  ];
  for (const pattern of turnoverPatterns) {
    const match = text.match(pattern);
    if (match) {
      const val = parseCurrency(match[1]);
      if (val && val > 0) { result.turnover = val; break; }
    }
  }

  // Gross Profit
  const gpRegex = new RegExp(`Gross\\s+Profit\\s+(${AMT})`, 'i');
  const gpMatch = text.match(gpRegex);
  if (gpMatch) {
    const val = parseCurrency(gpMatch[1]);
    if (val && val > 0) result.grossProfit = val;
  }

  // Net Profit
  const npRegex = new RegExp(`Net\\s+Profit\\s+(${AMT})`, 'gi');
  const npMatches = [...text.matchAll(npRegex)];
  if (npMatches.length > 0) {
    const val = parseCurrency(npMatches[0][1]);
    if (val && val > 0) result.netProfit = val;
  }

  // Depreciation (note: often misspelled as "Deprecation" in Indian ITRs)
  const depRegex = new RegExp(`Deprec[ia]a?tion\\s*["']?\\s*(${AMT})`, 'i');
  const depMatch = text.match(depRegex);
  if (depMatch) {
    const val = parseCurrency(depMatch[1]);
    if (val && val > 0) result.depreciation = val;
  }

  // Interest on Loans - sum all loan interest lines from P&L
  // Find the P&L section (between "Gross Profit" and "Net Profit")
  let totalInterest = 0;
  const plSection = text.match(/Gross\s+Profit[\s\S]*?Net\s+Profit/i);
  if (plSection) {
    const plText = plSection[0];
    const intRegex = new RegExp(`(?:Business\\s+Loan|Vehicle\\s+Loan|Car\\s+Loan|Bank\\s+(?:Interst|Interest)|Loan\\s+(?:Interst|Interest)|Finance\\s+(?:Loan\\s+)?(?:Interst|Interest)|OD\\s+(?:Loan\\s+)?(?:Interst|Interest))\\s*(${AMT})`, 'gi');
    const interestLines = [...plText.matchAll(intRegex)];
    interestLines.forEach(m => {
      const val = parseCurrency(m[1]);
      if (val && val > 0) totalInterest += val;
    });
  }
  if (totalInterest > 0) result.interestOnLoans = totalInterest;

  console.log('Regex financial extraction result:', JSON.stringify(result));
  return result;
}

// Reprocess financial documents to extract full text for component detection
app.post('/stage2/:proposalId/reprocess-financials', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }

    let processedCount = 0;
    const extractionResults = [];

    // Process each financial document
    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];

      if (doc.category === 'financials') {
        const fileExists = await existsInGridFS(doc.filename);

        if (fileExists && doc.originalName.toLowerCase().endsWith('.pdf')) {
          try {
            const fileBuffer = await readFromGridFS(doc.filename);
            let fullText = '';
            let pdfResult;

            await withTempFile(fileBuffer, doc.filename, async (filePath) => {
            // Extract full text from PDF (table extraction disabled for speed)
            pdfResult = await extractPDFWithTableDetection(filePath, false);
            fullText = pdfResult.text;

            console.log('\n========================================');
            console.log('📊 EXTRACTING FINANCIAL DOC:', doc.originalName);
            console.log('========================================');
            console.log('Text length:', fullText.length);
            console.log('Pages:', pdfResult.numPages);

            // Check if text extraction is inadequate (scanned/image PDF)
            const charsPerPage = fullText.length / (pdfResult.numPages || 1);
            if (pdfResult.numPages > 3 && charsPerPage < 200) {
              console.log(`⚠ Low text density (${Math.round(charsPerPage)} chars/page) for ${pdfResult.numPages} pages - likely scanned PDF`);
              console.log('🔍 Attempting multi-page Vision OCR...');
              try {
                const ocrResult = await extractAllPagesWithVisionOCR(filePath);
                if (ocrResult.success && ocrResult.text.length > fullText.length) {
                  fullText = ocrResult.text;
                  console.log(`✓ Vision OCR improved extraction: ${fullText.length} chars (was ${pdfResult.text.length})`);
                }
              } catch (ocrErr) {
                console.error('Vision OCR fallback error:', ocrErr.message);
              }
            }
            });

            // Check for each component with strict keyword matching
            const textLower = fullText.toLowerCase();

            // Check if this is Form 26AS (Annual Tax Statement) - NOT an ITR
            const isForm26AS = textLower.includes('annual tax statement') ||
                              (textLower.includes('form 26as') || textLower.includes('form-26as')) ||
                              (textLower.includes('data updated till') && textLower.includes('tax deducted'));

            // Check for Balance Sheet - must be actual BS, not just ITR summary
            const hasBalanceSheet = (
              // Full balance sheet indicators (has date like "as at" or "as on")
              textLower.includes('balance sheet as at') ||
              textLower.includes('balance sheet as on') ||
              // OCR-resilient: "alance Sheet as on" (missing "B" from OCR)
              /alance\s*sheet\s*as\s*(?:on|at)/i.test(fullText) ||
              // ITR-6 specific: Schedule-AL for Assets & Liabilities
              textLower.includes('schedule-al') ||
              textLower.includes('schedule al') ||
              // Has actual BS content (assets/liabilities sections)
              (textLower.includes('balance sheet') &&
               (textLower.includes('fixed assets') || textLower.includes('current assets') ||
                textLower.includes('total assets') || textLower.includes('capital account') ||
                textLower.includes('partners capital') || textLower.includes("partner's capital") ||
                textLower.includes('share capital') || textLower.includes('reserves and surplus'))) ||
              // OCR fallback: if text has liabilities + assets + BS indicators without explicit "balance sheet"
              (textLower.includes('liabilities') && textLower.includes('assets') &&
               (textLower.includes('sundry debtors') || textLower.includes('sundry creditors') || textLower.includes('capital account')) &&
               (textLower.includes('fixed assets') || textLower.includes('current assets')))
            ) && !textLower.includes('balance sheet (regular books of account');

            // Check for Profit & Loss - must be actual P&L section header
            const hasProfitLoss =
              textLower.includes('profit and loss account') ||
              textLower.includes('profit & loss account') ||
              textLower.includes('profit and loss a/c') ||
              textLower.includes('profit & loss a/c') ||
              textLower.includes('trading and profit and loss') ||
              textLower.includes('trading, profit and loss') ||
              textLower.includes('income and expenditure account') ||
              textLower.includes('statement of profit and loss') ||
              // ITR specific markers
              textLower.includes('net profit before tax as per p & l') ||
              textLower.includes('net profit before tax as per p&l') ||
              textLower.includes('profit before tax as per p & l') ||
              // Has actual P&L content
              (textLower.includes('trading account') && textLower.includes('gross profit')) ||
              // ITR-6 P&L schedule
              (textLower.includes('statement of income') && textLower.includes('business or profession'));

            // Check for Computation of Income
            const hasComputation = textLower.includes('computation of total income') ||
                          textLower.includes('computation of income') ||
                          (textLower.includes('computation') && textLower.includes('total income')) ||
                          // ITR summary section
                          (textLower.includes('total income rounded off') && textLower.includes('tax on total income')) ||
                          // OCR-friendly: computation sheet markers (OCR may miss the heading)
                          (textLower.includes('depreciation as per i.t.act') && textLower.includes('total income')) ||
                          (textLower.includes('depreciation as per it act') && textLower.includes('total income')) ||
                          (textLower.includes('disallowed expenses') && textLower.includes('tax payable')) ||
                          (textLower.includes('name of the assessee') && textLower.includes('tax payable') && textLower.includes('total income'));

            // ITR Acknowledgement indicators (check independently of 26AS)
            const hasITRAckIndicators = textLower.includes('indian income tax return acknowledgement') ||
                      textLower.includes('itr acknowledgement') ||
                      textLower.includes('itr-6') || textLower.includes('itr-5') || textLower.includes('itr-3') ||
                      (textLower.includes('acknowledgement number') && textLower.includes('date of filing'));

            const components = {
              // ITR Acknowledgement - exclude pure Form 26AS (but allow ITR+26AS combo docs)
              itrAck: hasITRAckIndicators || (!isForm26AS && false),
              computation: hasComputation,
              balanceSheet: hasBalanceSheet,
              profitLoss: hasProfitLoss
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
      await updateProposal(proposalId, { documents: proposal.documents });
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

// Reprocess personal ID and credit report documents using Vision OCR
app.post('/stage2/:proposalId/reprocess-personal-docs', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }

    const targetCategories = ['personalId', 'creditReports'];
    const docsToProcess = (proposal.documents || []).filter(d =>
      targetCategories.includes(d.category) &&
      (!d.extractedText || d.extractedText.trim().length === 0 || !d.extractedDetails ||
       (d.category === 'personalId' && d.extractedDetails && !d.extractedDetails.dateOfBirth))
    );

    console.log(`Reprocessing ${docsToProcess.length} personal/credit docs for proposal ${proposalId}`);

    let processedCount = 0;
    const results = [];

    for (const doc of docsToProcess) {
      const fileExists = await existsInGridFS(doc.filename);
      if (!fileExists) {
        results.push({ file: doc.originalName, status: 'skipped', reason: 'File not found' });
        continue;
      }

      try {
        let fullText = '';
        const isImage = /\.(jpe?g|png)$/i.test(doc.originalName || doc.filename || '');
        const fileBuffer = await readFromGridFS(doc.filename);

        await withTempFile(fileBuffer, doc.filename, async (filePath) => {
          if (isImage) {
            // Image file — use Vision OCR directly
            console.log(`Using Vision OCR for image: ${doc.originalName}`);
            const ocrResult = await extractTextFromImage(filePath);
            if (ocrResult.success && ocrResult.text) {
              fullText = ocrResult.text;
            }
          } else {
            // Try standard PDF extraction first
            try {
              const pdfResult = await extractPDFWithTableDetection(filePath);
              fullText = pdfResult.text || '';
              if (pdfResult.numPages) doc.pages = pdfResult.numPages;
            } catch (e) {
              console.log('Standard extraction failed for', doc.originalName);
            }

            // If empty, try Vision OCR for scanned PDFs
            if (!fullText || fullText.trim().length === 0) {
              console.log(`Using Vision OCR for scanned PDF: ${doc.originalName}`);
              const ocrResult = await extractTextFromScannedPDF(filePath);
              if (ocrResult.success && ocrResult.text) {
                fullText = ocrResult.text;
                if (ocrResult.numPages) doc.pages = ocrResult.numPages;
              }
            }
          }
        });

        if (!fullText || fullText.trim().length === 0) {
          results.push({ file: doc.originalName, status: 'failed', reason: 'No text extracted' });
          continue;
        }

        doc.extractedText = fullText.substring(0, 500);

        // Extract DOB from PAN cards or Aadhaar cards
        if (doc.category === 'personalId') {
          const lowerText = fullText.toLowerCase();
          const lowerName = (doc.originalName || '').toLowerCase();

          const isPAN = lowerName.includes('pan') || lowerText.includes('permanent account number') || lowerText.includes('income tax department');
          const isAadhaar = lowerName.includes('aadhar') || lowerName.includes('aadhaar') || lowerText.includes('aadhaar') || lowerText.includes('unique identification');

          if (isPAN || isAadhaar) {
            const docType = isPAN ? 'PAN Card' : 'Aadhaar Card';
            console.log(`Processing ${docType} for DOB extraction: ${doc.originalName}`);

            let dateOfBirth = null;
            const dobPatterns = [
              /date\s*of\s*birth[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
              /dob[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
              /birth[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
              /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s*date\s*of\s*birth/i,
              /DOB\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/
            ];

            if (isPAN) {
              dobPatterns.push(
                /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/  // Any date in DD/MM/YYYY
              );
            }

            if (isAadhaar) {
              dobPatterns.push(
                /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/,  // Any date in DD/MM/YYYY
                /जन्म\s*तिथि[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i
              );
            }

            for (const pattern of dobPatterns) {
              const match = fullText.match(pattern);
              if (match && match[1]) {
                dateOfBirth = match[1];
                break;
              }
            }

            doc.extractedDetails = {
              ...(doc.extractedDetails || {}),
              documentType: docType
            };

            if (dateOfBirth) {
              doc.extractedDetails.dateOfBirth = dateOfBirth;
              console.log(`✓ Extracted DOB: ${dateOfBirth} from ${doc.originalName} (${docType})`);
            }

            if (isPAN) {
              const panMatch = fullText.match(/[A-Z]{5}[0-9]{4}[A-Z]/);
              if (panMatch) {
                doc.extractedDetails.panNumber = panMatch[0];
                console.log(`✓ Extracted PAN: ${panMatch[0]} from ${doc.originalName}`);
              }
            }

            if (isAadhaar) {
              const aadhaarMatch = fullText.match(/\b(\d{4}\s?\d{4}\s?\d{4})\b/);
              if (aadhaarMatch) {
                doc.extractedDetails.aadhaarNumber = aadhaarMatch[1].replace(/\s/g, '');
                console.log(`✓ Extracted Aadhaar: ${aadhaarMatch[1]} from ${doc.originalName}`);
              }
            }
          }
        }

        // Extract CIBIL score from credit reports
        if (doc.category === 'creditReports') {
          let cibilScore = null;
          let creditBureau = null;
          let personName = null;

          if (fullText.toLowerCase().includes('cibil') || fullText.toLowerCase().includes('transunion')) {
            creditBureau = 'CIBIL';
          } else if (fullText.toLowerCase().includes('experian')) {
            creditBureau = 'Experian';
          } else if (fullText.toLowerCase().includes('equifax')) {
            creditBureau = 'Equifax';
          } else if (fullText.toLowerCase().includes('crif') || fullText.toLowerCase().includes('high mark')) {
            creditBureau = 'CRIF High Mark';
          }

          const scorePatterns = [
            /cibil\s*score\s*(?:is|:)\s*(\d{3})/i,
            /credit\s*score\s*(?:is|:)\s*(\d{3})/i,
            /cibil\s*score[:\s]*(\d{3})/i,
            /credit\s*score[:\s]*(\d{3})/i,
            /score[:\s]*(\d{3})\s*(?:out of|\/)\s*900/i,
            /transunion\s*cibil\s*score[:\s]*(\d{3})/i,
            /your\s*score\s*(?:is|:)\s*(\d{3})/i,
            /your\s*score[:\s]*(\d{3})/i,
            /cibil\s*transunion\s*score[:\s]*(\d{3})/i,
            /(\d{3})\s*(?:cibil|credit)\s*score/i,
            /score\s*summary[:\s]*(\d{3})/i,
            /bureau\s*score[:\s]*(\d{3})/i,
            /\bscore\b[:\s]*(\d{3})\b/i
          ];

          for (const pattern of scorePatterns) {
            const match = fullText.match(pattern);
            if (match && match[1]) {
              const score = parseInt(match[1]);
              if (score >= 300 && score <= 900) {
                cibilScore = score;
                break;
              }
            }
          }

          const namePatterns = [
            /name[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$|date|address|pan)/i,
            /consumer\s*name[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$)/i,
            /applicant[:\s]*([A-Z][A-Za-z\s]+?)(?:\n|$)/i
          ];

          for (const pattern of namePatterns) {
            const match = fullText.match(pattern);
            if (match && match[1] && match[1].trim().length > 3) {
              personName = match[1].trim();
              break;
            }
          }

          doc.extractedDetails = {
            ...(doc.extractedDetails || {}),
            documentType: 'Credit Report',
            creditBureau: creditBureau
          };

          if (cibilScore) {
            doc.extractedDetails.cibilScore = cibilScore;
            console.log(`✓ Extracted CIBIL Score: ${cibilScore} (${creditBureau}) from ${doc.originalName}`);
          }
          if (personName) {
            doc.extractedDetails.personName = personName;
          }
        }

        processedCount++;
        results.push({ file: doc.originalName, status: 'success', details: doc.extractedDetails });

      } catch (docErr) {
        console.error(`Error processing ${doc.originalName}:`, docErr.message);
        results.push({ file: doc.originalName, status: 'error', reason: docErr.message });
      }
    }

    // Save updated proposal
    await updateProposal(proposalId, { documents: proposal.documents });

    res.json({
      success: true,
      message: `Processed ${processedCount} of ${docsToProcess.length} documents`,
      results
    });
  } catch (error) {
    console.error('Personal docs reprocess error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fallback pattern matching for bank statement details
function extractBankStatementDetailsFallback(text, filename = '') {
  // Normalize Unicode dashes/minus signs to regular hyphens (Cosmos Bank etc. use − U+2212)
  text = text.replace(/[\u2212\u2013\u2014]/g, '-');

  const result = {
    bankName: 'N/A',
    accountHolder: 'N/A',
    accountNumber: 'N/A',
    last4Digits: 'N/A',
    periodFrom: 'N/A',
    periodTo: 'N/A',
    period: 'N/A'
  };

  // Only look in the first 800 characters for bank name (letterhead area only)
  // This avoids matching bank names in transaction descriptions or opening balance sections
  const headerText = text.substring(0, 800);

  // Exclude text that appears to be transaction-related
  // Remove lines containing transaction keywords before searching for bank name
  const transactionKeywords = /(?:NEFT|RTGS|IMPS|UPI|TRANSFER|TRF|TO\s+[A-Z]+\s+BANK|FROM\s+[A-Z]+\s+BANK|OPENING\s*BALANCE|CLOSING\s*BALANCE|DEBIT|CREDIT|WITHDRAWAL|DEPOSIT)/i;
  const cleanHeaderLines = headerText.split('\n')
    .filter(line => !transactionKeywords.test(line))
    .join('\n');

  // Bank name patterns - ordered by specificity (longer names first to avoid partial matches)
  const bankNames = [
    'KOTAK MAHINDRA BANK', 'STATE BANK OF INDIA', 'PUNJAB NATIONAL BANK',
    'INDIAN OVERSEAS BANK', 'TAMILNAD MERCANTILE BANK', 'BANK OF BARODA',
    'SOUTH INDIAN BANK', 'KARUR VYSYA BANK', 'KARNATAKA BANK',
    'CITY UNION BANK', 'CENTRAL BANK OF INDIA', 'UNION BANK OF INDIA',
    'HDFC BANK', 'ICICI BANK', 'AXIS BANK', 'CANARA BANK',
    'FEDERAL BANK', 'BANDHAN BANK', 'INDUSIND BANK', 'YES BANK',
    'RBL BANK', 'IDBI BANK', 'DCB BANK', 'KOTAK BANK',
    'IDFC FIRST BANK', 'IDFC BANK', 'AU SMALL FINANCE BANK',
    'CENTRAL BANK', 'UNION BANK', 'PNB', 'SBI', 'IOB', 'TMB'
  ];

  // Check for bank website URLs (e.g., sbi.co.in, hdfcbank.com) - very reliable indicator
  const bankUrlPatterns = [
    { pattern: /sbi\.co\.in/i, name: 'STATE BANK OF INDIA' },
    { pattern: /hdfcbank\.com/i, name: 'HDFC BANK' },
    { pattern: /icicibank\.com/i, name: 'ICICI BANK' },
    { pattern: /axisbank\.com/i, name: 'AXIS BANK' },
    { pattern: /kotak\.com/i, name: 'KOTAK MAHINDRA BANK' },
    { pattern: /pnbindia\.in/i, name: 'PUNJAB NATIONAL BANK' },
    { pattern: /canarabank\.com/i, name: 'CANARA BANK' },
    { pattern: /bankofbaroda\.in/i, name: 'BANK OF BARODA' },
    { pattern: /iob\.in/i, name: 'INDIAN OVERSEAS BANK' },
    { pattern: /federalbank\.co\.in/i, name: 'FEDERAL BANK' },
    { pattern: /bandhanbank\.com/i, name: 'BANDHAN BANK' },
    { pattern: /indusind\.com/i, name: 'INDUSIND BANK' },
    { pattern: /yesbank\.in/i, name: 'YES BANK' },
    { pattern: /rblbank\.com/i, name: 'RBL BANK' },
    { pattern: /idbibank\.in/i, name: 'IDBI BANK' },
    { pattern: /unionbankofindia\.co\.in/i, name: 'UNION BANK OF INDIA' },
    { pattern: /idfcfirstbank\.com|dfcfir\.st/i, name: 'IDFC FIRST BANK' },
  ];

  for (const { pattern, name } of bankUrlPatterns) {
    if (pattern.test(text)) {
      result.bankName = name;
      break;
    }
  }

  // First, try to find bank name in official statement header patterns
  // These patterns specifically look for the issuing bank, not transferred-to banks
  if (result.bankName === 'N/A') {
    const headerPatterns = [
      // Pattern: "Account Statement" or "Statement of Account" with bank name nearby
      /(?:Account\s*Statement|Statement\s*of\s*Account|Bank\s*Statement)[\s\S]{0,50}?(IDFC FIRST BANK|HDFC BANK|ICICI BANK|STATE BANK OF INDIA|SBI|AXIS BANK|KOTAK MAHINDRA BANK|KOTAK BANK|PUNJAB NATIONAL BANK|PNB|CANARA BANK|BANK OF BARODA|INDIAN OVERSEAS BANK|IOB|FEDERAL BANK|BANDHAN BANK|INDUSIND BANK|YES BANK|RBL BANK|IDBI BANK|UNION BANK|CENTRAL BANK)/i,
      // Pattern: Bank name at the very start (first 200 chars - likely letterhead)
      /^[\s\S]{0,200}?(IDFC FIRST BANK|HDFC BANK|ICICI BANK|STATE BANK OF INDIA|AXIS BANK|KOTAK MAHINDRA BANK|PUNJAB NATIONAL BANK|CANARA BANK|BANK OF BARODA|INDIAN OVERSEAS BANK|FEDERAL BANK|BANDHAN BANK|INDUSIND BANK|YES BANK|RBL BANK|IDBI BANK|UNION BANK|CENTRAL BANK)/i,
      // Pattern: "Bank Name:" label
      /Bank\s*Name[:\s]+([A-Za-z\s]+(?:Bank|BANK))/i,
      // Pattern: Branch name indicating the bank
      /Branch[:\s]+[A-Za-z\s,]+[\s,]+(IDFC FIRST|IDFC|HDFC|ICICI|SBI|STATE BANK|AXIS|KOTAK|PUNJAB NATIONAL|CANARA|BANK OF BARODA|INDIAN OVERSEAS|FEDERAL|BANDHAN|INDUSIND|YES|RBL|IDBI|UNION|CENTRAL)(?:\s*BANK)?/i
    ];

    for (const pattern of headerPatterns) {
      const match = cleanHeaderLines.match(pattern);
      if (match) {
        let bankName = (match[1] || match[0]).trim();
        // Normalize to standard bank names
        const bankUpper = bankName.toUpperCase();
        if (bankUpper.includes('IDFC')) result.bankName = 'IDFC FIRST BANK';
        else if (bankUpper.includes('HDFC')) result.bankName = 'HDFC BANK';
        else if (bankUpper.includes('ICICI')) result.bankName = 'ICICI BANK';
        else if (bankUpper.includes('SBI') || bankUpper.includes('STATE BANK')) result.bankName = 'STATE BANK OF INDIA';
        else if (bankUpper.includes('AXIS')) result.bankName = 'AXIS BANK';
        else if (bankUpper.includes('KOTAK')) result.bankName = 'KOTAK MAHINDRA BANK';
        else if (bankUpper.includes('INDUSIND')) result.bankName = 'INDUSIND BANK';
        else if (bankUpper.includes('YES')) result.bankName = 'YES BANK';
        else if (bankUpper.includes('CANARA')) result.bankName = 'CANARA BANK';
        else if (bankUpper.includes('FEDERAL')) result.bankName = 'FEDERAL BANK';
        else if (bankUpper.includes('BANDHAN')) result.bankName = 'BANDHAN BANK';
        else if (bankUpper.includes('BARODA')) result.bankName = 'BANK OF BARODA';
        else if (bankUpper.includes('PUNJAB') || bankUpper.includes('PNB')) result.bankName = 'PUNJAB NATIONAL BANK';
        else if (bankUpper.includes('INDIAN OVERSEAS') || bankUpper.includes('IOB')) result.bankName = 'INDIAN OVERSEAS BANK';
        else if (bankUpper.includes('RBL')) result.bankName = 'RBL BANK';
        else if (bankUpper.includes('IDBI')) result.bankName = 'IDBI BANK';
        else if (bankUpper.includes('UNION')) result.bankName = 'UNION BANK OF INDIA';
        else if (bankUpper.includes('CENTRAL')) result.bankName = 'CENTRAL BANK OF INDIA';
        else result.bankName = bankName;
        break;
      }
    }
  }

  // If still not found, check for bank name at the very beginning (first 300 chars only)
  // This should only be letterhead area, not transaction area
  if (result.bankName === 'N/A') {
    const firstLines = text.substring(0, 300).toUpperCase();
    // Exclude if it looks like a transaction line
    if (!transactionKeywords.test(firstLines)) {
      for (const bankName of bankNames) {
        if (firstLines.includes(bankName)) {
          result.bankName = bankName;
          break;
        }
      }
    }
  }

  // If still not found, detect bank from IFSC code prefix (very reliable)
  if (result.bankName === 'N/A') {
    const ifscMatch = headerText.match(/IFSC\s*(?:(?:Code|\/\s*MICR)\s*)?[:\s]*([A-Z]{4})\d{7}/i);
    if (ifscMatch) {
      const ifscPrefix = ifscMatch[1].toUpperCase();
      const ifscBankMap = {
        'UTIB': 'AXIS BANK', 'HDFC': 'HDFC BANK', 'ICIC': 'ICICI BANK',
        'SBIN': 'STATE BANK OF INDIA', 'KKBK': 'KOTAK MAHINDRA BANK',
        'PUNB': 'PUNJAB NATIONAL BANK', 'CNRB': 'CANARA BANK',
        'BARB': 'BANK OF BARODA', 'IOBA': 'INDIAN OVERSEAS BANK',
        'FDRL': 'FEDERAL BANK', 'BDBL': 'BANDHAN BANK',
        'INDB': 'INDUSIND BANK', 'YESB': 'YES BANK',
        'RATN': 'RBL BANK', 'IBKL': 'IDBI BANK',
        'UBIN': 'UNION BANK OF INDIA', 'CBIN': 'CENTRAL BANK OF INDIA',
        'BKID': 'BANK OF INDIA', 'ALLA': 'INDIAN BANK',
        'IDIB': 'INDIAN BANK', 'UCBA': 'UCO BANK',
        'TMBL': 'TAMILNAD MERCANTILE BANK', 'KVBL': 'KARUR VYSYA BANK',
        'KARB': 'KARNATAKA BANK', 'CIUB': 'CITY UNION BANK',
        'SIBL': 'SOUTH INDIAN BANK', 'DCBL': 'DCB BANK',
        'IDFB': 'IDFC FIRST BANK', 'COSB': 'COSMOS CO-OPERATIVE BANK',
        'SRCB': 'SARASWAT CO-OPERATIVE BANK', 'JAKA': 'JAMMU AND KASHMIR BANK'
      };
      if (ifscBankMap[ifscPrefix]) {
        result.bankName = ifscBankMap[ifscPrefix];
      }
    }
  }
  
  // Account number patterns - look for full or masked account numbers
  const accountPatterns = [
    // Full account number with label (e.g., "Account Number : 00000020005843572" or "Loan Account No.: 39541976")
    /(?:(?:Loan\s*)?Account\s*(?:No|Number|#)[.:\s]*|A\/c\s*No[.:\s]*|Acct\s*No[.:\s]*)(\d{8,18})/i,
    // Masked account number (e.g., "XXXXXXX3572" or "XXXX1234")
    /(?:Account\s*(?:No|Number|#)?[:\s]*)?([X]{3,}\d{3,6})/i,
    // Full account number without label (not surrounded by letters - excludes tracking numbers like RD388515151IN)
    /(?<![A-Za-z])(\d{9,18})(?![A-Za-z])/
  ];
  
  for (const pattern of accountPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.accountNumber = match[1] || match[0];
      break;
    }
  }
  
  // Extract last 4 digits for matching masked account numbers
  // This allows grouping XXXXXXX3572 with 00000020005843572
  if (result.accountNumber && result.accountNumber !== 'N/A') {
    // Get only the numeric digits from end of account number
    const digitsOnly = result.accountNumber.replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 4) {
      result.last4Digits = digitsOnly.slice(-4);
    } else if (digitsOnly.length > 0) {
      result.last4Digits = digitsOnly;
    } else {
      result.last4Digits = 'N/A';
    }
  } else {
    result.last4Digits = 'N/A';
  }
  
  // Account holder patterns - limit to avoid capturing address
  const holderPatterns = [
    // SBI format: "Welcome:\nNAME" or "Welcome: NAME" (name on next line after Welcome:)
    // Negative lookahead excludes "Welcome to the..." greeting phrases
    /Welcome[:\s]*\n\s*(?!to\s+the\s)([A-Z][A-Za-z\s&.]{2,50}?)(?:\s*\n)/i,
    // SBI format: "Welcome Mr./Mrs./Miss. NAME"
    /Welcome\s+(?:Mr\.|Mrs\.|Ms\.?|Miss\.?|M\/S\.?)\s*([A-Z][A-Za-z\s&.]+?)(?:\s*\.?\s*(?:As\s*on|$|\n))/i,
    // Explicit label: "Account Holder: NAME" or "Customer Name: NAME"
    /(?:Account\s*Holder|Customer\s*Name)[:\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|Branch|A\/c|Account|\d|,|\n))/i,
    /(?:Account\s*Holder|Customer\s*Name)[:\s]+([A-Z][A-Za-z\s&.]{2,50})/i,
    // ICICI / generic format: "Name:\nVALUE\n" (label on one line, name on next)
    /(?:^|\n)\s*Name\s*:\s*\n\s*([A-Z][A-Za-z\s&.]{2,60}?)\s*\n/im,
    // Generic format: "Name: VALUE" on same line
    /(?:^|\n)\s*Name\s*:\s*([A-Z][A-Za-z\s&.]{2,60}?)(?:\s*\n)/im,
    // HDFC Bank format: "MR\nNAME\nADDRESS" or "MS\nNAME\nADDRESS" (salutation on separate line)
    /(?:^|\n)(?:MR|MRS|MS|M\/S)\s*\n\s*([A-Z][A-Za-z\s&.]+?)\s*\n\s*(?:H[\s-]*NO|Plot|Door|No\.|House|Flat|Building|Street|Road|\d+[\s-]+\d+)/im,
    // Salutation on same line: "Mr. NAME ADDRESS_BOUNDARY"
    /(?:Mr\.|Mrs\.|Ms\.|Miss\.|M\/S)[.\s]+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:Plot|Door|No\.|House|Flat|Building|Street|Road|Lane|Address|\d|,|\n))/i,
    /(?:Mr\.|Mrs\.|Ms\.|Miss\.|M\/S)[.\s]+([A-Z][A-Za-z &.]{2,50})/i,
    // Axis Bank / generic format: Name on the very first non-empty line, followed by "Joint Holder"
    /^\s*([A-Z][A-Z\s&.]{2,60}?)\s*\n\s*(?:Joint\s*Holder)/im,
    // Address block format: ALL-CAPS name on own line, followed by address (IDFC, Bajaj, etc.)
    // e.g., "RADHA KRISHNA RAVI\n\nVILLA 168..." or "JOHN DOE\nFLAT 12..."
    /(?:^|\n)\s*([A-Z][A-Z\s]{4,50}?)\s*\n+\s*(?:VILLA|FLAT|HOUSE|PLOT|DOOR|H[\s-]*NO|NO\.\s*\d|\d+[\s,\/-]+\d+|#\d)/m
  ];

  // Only search in the header area (first 1500 chars) to avoid matching names in transactions
  const holderSearchText = text.substring(0, 1500);

  for (const pattern of holderPatterns) {
    const match = holderSearchText.match(pattern);
    if (match) {
      // Clean up the account holder name - remove trailing common words
      let holder = match[1].trim();
      // Remove trailing address-related words if any slipped through
      holder = holder.replace(/\s+(Plot|Door|No|House|Flat|Building|Street|Road|Lane|Address|Branch).*$/i, '').trim();
      // Remove trailing period
      holder = holder.replace(/\.\s*$/, '').trim();
      result.accountHolder = holder;
      break;
    }
  }
  
  // Helper function to convert "D Mon YYYY" to "DD/MM/YYYY"
  const convertMonthNameDate = (dateStr) => {
    const months = {
      'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04', 'may': '05', 'jun': '06',
      'jul': '07', 'aug': '08', 'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
    };
    // Match patterns like "1 Feb 2025", "28 Feb 2025", "01 Mar 2025"
    const match = dateStr.match(/(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*(\d{4})/i);
    if (match) {
      const day = match[1].padStart(2, '0');
      const month = months[match[2].toLowerCase()];
      const year = match[3];
      return `${day}/${month}/${year}`;
    }
    return dateStr;
  };
  
  // Date period patterns - standard formats (DD-MM-YYYY or DD/MM/YYYY)
  const periodPatterns = [
    /(?:Statement\s*Period|Period)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|[-–])\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:From)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:To)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /Statement\s*From[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|To)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    // "Statement of Account for the period of 01-01-2025 to 16-02-2026" (Cosmos, IDFC, co-op banks)
    /(?:Statement\s*of\s*Account|Account\s*Statement)[\s\S]{0,30}?(?:period\s*(?:of|from)?|from)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  ];
  
  for (const pattern of periodPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.periodFrom = match[1];
      result.periodTo = match[2];
      result.period = `${match[1]} - ${match[2]}`;
      console.log(`✓ Extracted period from DD-MM-YYYY pattern: ${result.period}`);
      break;
    }
  }
  
  // If not found with DD-MM-YYYY, try "D Mon YYYY" format (e.g., "06 Oct 2025 - 06 Jan 2026")
  if (result.periodFrom === 'N/A' || result.periodTo === 'N/A') {
    const monthDatePatterns = [
      // "Period: 06 Oct 2025 - 06 Jan 2026" or "Statement Period: 06 Oct 2025 - 06 Jan 2026"
      /(?:Statement\s*)?Period[:\s]*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})\s*(?:to|To|[-–])\s*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})/i,
      // "Account Statement from 1 Feb 2025 to 28 Feb 2025"
      /(?:Account\s*)?Statement\s*(?:from|From)[:\s]*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})\s*(?:to|To|[-–])\s*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})/i,
      // "From 1 Feb 2025 To 28 Feb 2025"
      /From[:\s]*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})\s*(?:to|To|[-–])\s*(\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{4})/i
    ];
    for (const monthDatePattern of monthDatePatterns) {
      const monthMatch = text.match(monthDatePattern);
      if (monthMatch) {
        result.periodFrom = convertMonthNameDate(monthMatch[1]);
        result.periodTo = convertMonthNameDate(monthMatch[2]);
        result.period = `${result.periodFrom} - ${result.periodTo}`;
        console.log(`✓ Extracted period from D Mon YYYY pattern: ${result.period}`);
        break;
      }
    }
  }
  
  // If period still not found, try to extract from transaction dates
  // This handles SBI-style statements that only show "As on DD-MM-YY"
  if (result.periodFrom === 'N/A' || result.periodTo === 'N/A') {
    // Look for "As on" date which is typically the end date
    const asOnMatch = text.match(/As\s*on\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i);
    
    // Find all transaction dates in DD-MM-YY or DD-MM-YYYY format (excluding loan dates which might be older)
    const datePattern = /\b(\d{1,2}[-\/]\d{1,2}[-\/](\d{2}|\d{4}))\b/g;
    const allDates = [];
    let dateMatch;
    
    while ((dateMatch = datePattern.exec(text)) !== null) {
      const dateStr = dateMatch[1];
      // Parse the date
      const parts = dateStr.split(/[-\/]/);
      if (parts.length === 3) {
        let [d, m, y] = parts.map(p => parseInt(p, 10));
        if (y < 100) y += 2000; // Convert 2-digit year to 4-digit
        // Only include dates from 2020 onwards (to exclude old loan dates)
        if (y >= 2020 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          allDates.push({ date: new Date(y, m - 1, d), original: dateStr, y, m, d });
        }
      }
    }
    
    if (allDates.length > 0) {
      // Sort dates and get min/max
      allDates.sort((a, b) => a.date - b.date);
      const minDate = allDates[0];
      const maxDate = allDates[allDates.length - 1];
      
      // Format dates as DD/MM/YYYY
      const formatDate = (d) => {
        return `${String(d.d).padStart(2, '0')}/${String(d.m).padStart(2, '0')}/${d.y}`;
      };
      
      result.periodFrom = formatDate(minDate);
      result.periodTo = formatDate(maxDate);
      result.period = `${result.periodFrom} - ${result.periodTo}`;
      
      console.log(`✓ Extracted period from transaction dates: ${result.period}`);
    } else if (asOnMatch) {
      // If we only have "As on" date, use it as periodTo and derive periodFrom from filename
      const asOnDate = asOnMatch[1];
      const parts = asOnDate.split(/[-\/\.]/);
      if (parts.length === 3) {
        let [d, m, y] = parts.map(p => parseInt(p, 10));
        if (y < 100) y += 2000;
        
        result.periodTo = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
        // Assume first day of same month as periodFrom
        result.periodFrom = `01/${String(m).padStart(2, '0')}/${y}`;
        result.period = `${result.periodFrom} - ${result.periodTo}`;
        
        console.log(`✓ Extracted period from 'As on' date: ${result.period}`);
      }
    }
  }
  
  // If still no period, try to extract from filename (e.g., May2025.pdf, Nov2025.pdf)
  if ((result.periodFrom === 'N/A' || result.periodTo === 'N/A') && filename) {
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const filenameLower = filename.toLowerCase();
    
    for (let i = 0; i < monthNames.length; i++) {
      const monthMatch = filenameLower.match(new RegExp(`(${monthNames[i]})[a-z]*[-_\\s]?(\\d{4}|\\d{2})`, 'i'));
      if (monthMatch) {
        let year = parseInt(monthMatch[2], 10);
        if (year < 100) year += 2000;
        const month = i + 1;
        
        // Get last day of month
        const lastDay = new Date(year, month, 0).getDate();
        
        result.periodFrom = `01/${String(month).padStart(2, '0')}/${year}`;
        result.periodTo = `${String(lastDay).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
        result.period = `${result.periodFrom} - ${result.periodTo}`;
        
        console.log(`✓ Extracted period from filename: ${result.period}`);
        break;
      }
    }
  }
  
  return result;
}

app.post('/stage2/:proposalId/complete', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const updates = {
      currentStage: 3,
      status: 'Stage 2 - Documents Submitted',
      stage2CompletedAt: new Date().toISOString()
    };
    
    await updateProposal(proposalId, updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 3: CAM (Credit Appraisal Memo)
app.get('/stage3/:proposalId', async (req, res) => {
  const proposal = await getProposalById(req.params.proposalId);
  if (!proposal) {
    return res.status(404).send('Proposal not found');
  }
  
  // Fetch debt profiles from MongoDB
  let debtProfiles = [];
  try {
    debtProfiles = await DebtProfile.find({ proposalId: req.params.proposalId }).sort({ sNo: 1 });
  } catch (err) {
    console.error('Error fetching debt profiles for stage 3:', err);
  }
  
  res.render('stage3-cam', { proposal, debtProfiles });
});

// Stage 3: Download entire proposal as ZIP with categorized folders
app.get('/stage3/:proposalId/download-zip', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).send('Proposal not found');

    const docs = proposal.documents || [];
    if (docs.length === 0) return res.status(400).send('No documents to download');

    const categoryLabels = {
      personalId: 'Personal ID',
      businessId: 'Business ID',
      incorporation: 'Incorporation',
      creditReports: 'Credit Reports',
      financials: 'Financials',
      banking: 'Banking',
      turnover: 'Turnover',
      debtProfile: 'Debt Profile',
      otherIncome: 'Other Income',
      collateral: 'Collateral',
      otherDocuments: 'Other Documents'
    };

    // Diagnose mode: return JSON showing which files exist in GridFS
    if (req.query.diagnose === 'true') {
      const fileStatus = [];
      for (const doc of docs) {
        const exists = await existsInGridFS(doc.filename);
        fileStatus.push({
          category: doc.category,
          originalName: doc.originalName,
          filename: doc.filename,
          existsInGridFS: exists
        });
      }
      return res.json({
        proposalId: req.params.proposalId,
        totalDocsInDB: docs.length,
        fileStatus: fileStatus
      });
    }

    const zip = new AdmZip();

    let addedCount = 0;
    let missingCount = 0;
    const missingFiles = [];
    const usedPaths = new Set();

    for (const doc of docs) {
      try {
        const fileBuffer = await readFromGridFS(doc.filename);
        const folder = categoryLabels[doc.category] || 'Other';
        let fileName = doc.originalName || doc.filename;
        // Handle duplicate originalNames within the same category
        let zipPath = folder + '/' + fileName;
        if (usedPaths.has(zipPath)) {
          const ext = path.extname(fileName);
          const base = path.basename(fileName, ext);
          let counter = 2;
          while (usedPaths.has(folder + '/' + base + '_' + counter + ext)) counter++;
          fileName = base + '_' + counter + ext;
          zipPath = folder + '/' + fileName;
        }
        usedPaths.add(zipPath);
        zip.addFile(zipPath, fileBuffer);
        addedCount++;
      } catch (err) {
        missingCount++;
        missingFiles.push({ category: doc.category, filename: doc.filename, originalName: doc.originalName });
      }
    }

    console.log(`ZIP download: ${addedCount} files added, ${missingCount} files missing in GridFS`);
    if (missingFiles.length > 0) {
      console.log('Missing files:', JSON.stringify(missingFiles, null, 2));
    }

    const applicant = (proposal.applicantName || proposal.customerName || 'proposal').replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_');
    const zipName = `${applicant}_${req.params.proposalId}.zip`;

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName}"`);
    res.send(zip.toBuffer());
  } catch (error) {
    console.error('ZIP download error:', error);
    res.status(500).send('Error creating ZIP: ' + error.message);
  }
});

// Stage 3: Re-extract financial documents (ITR / P&L / Balance Sheet)
app.post('/stage3/:proposalId/reextract-financials', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });
    if (!proposal.documents || proposal.documents.length === 0) {
      return res.status(400).json({ success: false, error: 'No documents found' });
    }

    let processedCount = 0;

    for (let i = 0; i < proposal.documents.length; i++) {
      const doc = proposal.documents[i];
      if (doc.category !== 'financials') continue;

      const fileExists = await existsInGridFS(doc.filename);
      if (!fileExists || !doc.originalName.toLowerCase().endsWith('.pdf')) continue;

      try {
        console.log('\n========================================');
        console.log('RE-EXTRACTING FINANCIAL DOC:', doc.originalName);
        console.log('========================================');

        const fileBuffer = await readFromGridFS(doc.filename);
        let fullText = '';
        let pdfResult;

        await withTempFile(fileBuffer, doc.filename, async (filePath) => {
          pdfResult = await extractPDFWithTableDetection(filePath, false);
          fullText = pdfResult.text;

          // Vision OCR for scanned/image PDFs
          const charsPerPage = fullText.length / (pdfResult.numPages || 1);
          const isShortText = fullText.trim().length > 0 && fullText.trim().length < 2000 && pdfResult.numPages > 1;
          if ((pdfResult.numPages > 3 && charsPerPage < 200) || isShortText) {
            console.log('Attempting multi-page Vision OCR...');
            try {
              const ocrResult = await extractAllPagesWithVisionOCR(filePath);
              if (ocrResult.success && ocrResult.text.length > fullText.length) {
                if (isShortText && fullText.trim().length > 0) {
                  fullText = fullText + '\n\n' + ocrResult.text;
                } else {
                  fullText = ocrResult.text;
                }
                console.log('Vision OCR improved extraction:', fullText.length, 'chars');
              }
            } catch (ocrErr) {
              console.error('Vision OCR error:', ocrErr.message);
            }
          }
        });

        proposal.documents[i].extractedText = fullText;
        proposal.documents[i].pages = pdfResult.numPages;

        // Extract financial data from tables
        const textLower = fullText.toLowerCase();
        const hasBS = textLower.includes('balance sheet') ||
          /alance\s*sheet\s*as\s*on/i.test(fullText) ||
          (textLower.includes('liabilities') && textLower.includes('assets') && (textLower.includes('sundry debtors') || textLower.includes('sundry creditors') || textLower.includes('capital account')));
        const hasPL = textLower.includes('profit') && textLower.includes('loss');
        const hasComp = textLower.includes('computation') && textLower.includes('total income');
        const hasITR = textLower.includes('income tax return') || textLower.includes('acknowledgement number');
        proposal.documents[i].financialComponents = {
          itrAck: hasITR, computation: hasComp, balanceSheet: hasBS, profitLoss: hasPL
        };

        console.log('Text length:', fullText.length, 'Pages:', pdfResult.numPages);
        console.log('Components: ITR=' + hasITR, 'Comp=' + hasComp, 'BS=' + hasBS, 'PL=' + hasPL);

        // AI-based financial extraction
        let aiExtracted = false;
        try {
          console.log('🤖 Attempting AI financial extraction for:', doc.originalName);
          const aiResult = await extractWithDocumentAI(fullText, 'financial-itr', pdfResult.tables || []);
          if (aiResult.success && aiResult.data) {
            const ai = aiResult.data;
            if (!proposal.documents[i].extractedDetails) proposal.documents[i].extractedDetails = {};
            if (ai.turnover) { proposal.documents[i].extractedDetails.turnover = ai.turnover; aiExtracted = true; }
            if (ai.grossProfit) { proposal.documents[i].extractedDetails.grossProfit = ai.grossProfit; aiExtracted = true; }
            if (ai.depreciation) { proposal.documents[i].extractedDetails.depreciation = ai.depreciation; aiExtracted = true; }
            if (ai.interestOnLoans) { proposal.documents[i].extractedDetails.interestOnLoans = ai.interestOnLoans; aiExtracted = true; }
            if (ai.netProfit) { proposal.documents[i].extractedDetails.netProfit = ai.netProfit; aiExtracted = true; }
            if (ai.assessmentYear) { proposal.documents[i].extractedDetails.assessmentYear = ai.assessmentYear; aiExtracted = true; }
            console.log('✓ AI financial extraction:', JSON.stringify(ai));
          }
        } catch (aiErr) {
          console.error('AI financial extraction error:', aiErr.message);
        }

        // Fallback: regex-based financial extraction if AI failed
        if (!aiExtracted) {
          console.log('⚠ AI failed, using regex fallback for financial extraction:', doc.originalName);
          const fb = extractFinancialDetailsFallback(fullText);
          if (fb && (fb.turnover || fb.netProfit || fb.depreciation)) {
            if (!proposal.documents[i].extractedDetails) proposal.documents[i].extractedDetails = {};
            if (fb.turnover) proposal.documents[i].extractedDetails.turnover = fb.turnover;
            if (fb.grossProfit) proposal.documents[i].extractedDetails.grossProfit = fb.grossProfit;
            if (fb.depreciation) proposal.documents[i].extractedDetails.depreciation = fb.depreciation;
            if (fb.interestOnLoans) proposal.documents[i].extractedDetails.interestOnLoans = fb.interestOnLoans;
            if (fb.netProfit) proposal.documents[i].extractedDetails.netProfit = fb.netProfit;
            if (fb.assessmentYear) proposal.documents[i].extractedDetails.assessmentYear = fb.assessmentYear;
            console.log('✓ Regex fallback extraction:', JSON.stringify(fb));
          }
        }

        processedCount++;
      } catch (err) {
        console.error('Error re-extracting:', doc.originalName, err.message);
      }
    }

    if (processedCount > 0) {
      await updateProposal(proposalId, { documents: proposal.documents });
    }

    res.json({ success: true, processedCount });
  } catch (err) {
    console.error('Re-extract financials error:', err);
    res.json({ success: false, error: err.message });
  }
});

// Fetch website and generate business summary
app.post('/stage3/:proposalId/fetch-business-summary', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    const websiteUrl = proposal.website;
    if (!websiteUrl) return res.status(400).json({ error: 'No website URL provided for this proposal. Please add it in Stage 1.' });

    console.log(`Fetching business summary from website: ${websiteUrl}`);

    // Helper to extract text from HTML
    function extractTextFromHTML(html) {
      return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Helper to extract meta info from HTML
    function extractMetaInfo(html) {
      const info = [];
      const title = (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1];
      if (title) info.push('Title: ' + title.trim());

      const metaTags = html.match(/<meta[^>]+>/gi) || [];
      metaTags.forEach(tag => {
        const nameMatch = tag.match(/(?:name|property)=["']([^"']+)["']/i);
        const contentMatch = tag.match(/content=["']([^"']+)["']/i);
        if (nameMatch && contentMatch) {
          const name = nameMatch[1].toLowerCase();
          if (name.includes('description') || name.includes('og:') || name.includes('twitter:') ||
              name.includes('keywords') || name.includes('author') || !name.includes('viewport') && !name.includes('charset') && !name.includes('theme') && !name.includes('verification') && !name.includes('robots')) {
            info.push(nameMatch[1] + ': ' + contentMatch[1].trim());
          }
        }
      });

      // Extract JSON-LD structured data
      const jsonldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
      jsonldMatches.forEach(match => {
        const jsonContent = (match.match(/>([\s\S]*?)<\/script>/i) || [])[1];
        if (jsonContent) {
          try {
            const data = JSON.parse(jsonContent.trim());
            if (data.description) info.push('Schema Description: ' + data.description);
            if (data.name) info.push('Schema Name: ' + data.name);
            if (data.about) info.push('About: ' + (typeof data.about === 'string' ? data.about : JSON.stringify(data.about)));
          } catch(e) {}
        }
      });

      return info.join('\n');
    }

    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    // Fetch main page
    let pageText = '';
    let metaInfo = '';
    let allText = '';
    try {
      const response = await axios.get(websiteUrl, { timeout: 15000, headers: fetchHeaders, maxRedirects: 5 });
      const html = response.data;
      pageText = extractTextFromHTML(html);
      metaInfo = extractMetaInfo(html);
      allText = pageText;

      // If main page has insufficient text (JS-rendered SPA), try sub-pages
      if (pageText.length < 100) {
        const baseUrl = websiteUrl.replace(/\/+$/, '');
        const subPages = ['/about', '/about-us', '/aboutus', '/services', '/our-services', '/what-we-do', '/company'];
        console.log('Main page has insufficient text, trying sub-pages...');

        for (const subPage of subPages) {
          try {
            const subResponse = await axios.get(baseUrl + subPage, { timeout: 8000, headers: fetchHeaders, maxRedirects: 5 });
            const subHtml = subResponse.data;
            const subText = extractTextFromHTML(subHtml);
            const subMeta = extractMetaInfo(subHtml);
            if (subText.length > allText.length) allText = subText;
            if (subMeta.length > metaInfo.length) metaInfo = subMeta;
            if (subText.length > 200) {
              console.log(`Found content on ${subPage}: ${subText.length} chars`);
              break;
            }
          } catch(e) { /* sub-page not available, skip */ }
        }
      }
    } catch (fetchErr) {
      console.error('Error fetching website:', fetchErr.message);
      return res.status(400).json({ error: `Could not fetch website: ${fetchErr.message}` });
    }

    // Combine all available info
    if (allText.length > 8000) allText = allText.substring(0, 8000);
    const combinedInfo = (metaInfo + '\n\n' + allText).trim();

    // Use OpenRouter to summarize - even with minimal info (meta tags + company name + industry)
    const companyName = proposal.applicantName || 'the company';
    const industry = proposal.industry || '';
    const businessNature = proposal.businessNature || proposal.natureOfBusiness || '';

    let promptContent;
    if (combinedInfo.length > 80) {
      promptContent = `Based on the following website information of "${companyName}" (Website: ${websiteUrl}, Industry: ${industry || 'Not specified'}, Nature of Business: ${businessNature || 'Not specified'}), provide a concise business process summary suitable for a bank's Credit Appraisal Memo (CAM). Include:
1. What the company does (products/services)
2. Key business activities and operations
3. Target market/customers
4. Any notable achievements, certifications, or strengths mentioned

Keep it professional, factual, and within 150-200 words. Do not include any introductory phrases like "Based on the website..." - start directly with the business description. If website content is limited, use the company name, website URL, and industry context to infer and describe the likely business activities.

Website information:
${combinedInfo}`;
    } else {
      promptContent = `Generate a concise business process summary for "${companyName}" (Website: ${websiteUrl}, Industry: ${industry || 'Not specified'}, Nature of Business: ${businessNature || 'Not specified'}) suitable for a bank's Credit Appraisal Memo (CAM).

Based on the company name, website URL, and industry, describe:
1. What the company likely does (products/services)
2. Key business activities and operations
3. Target market/customers

Keep it professional and within 150-200 words. Start directly with the business description. Note: The website content could not be fully extracted as it uses dynamic rendering.`;
    }

    const aiResponse = await axios.post(OPENROUTER_API_URL, {
      model: 'google/gemini-2.0-flash-001',
      messages: [{ role: 'user', content: promptContent }]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const summary = aiResponse.data?.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      return res.status(500).json({ error: 'AI could not generate a summary from the website content.' });
    }

    // Save the summary to proposal
    if (!proposal.camMemo) proposal.camMemo = {};
    proposal.camMemo.businessProcess = summary;
    proposal.businessWebsiteSummary = summary;
    await updateProposal(req.params.proposalId, { camMemo: proposal.camMemo, businessWebsiteSummary: summary });

    console.log(`Business summary generated for ${companyName} from ${websiteUrl}`);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('Error generating business summary:', err.message);
    res.status(500).json({ error: 'Failed to generate business summary: ' + err.message });
  }
});

// Stage 3: Generate CAM text summary for WhatsApp sharing
app.get('/stage3/:proposalId/cam-text', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });

    const debtProfiles = await DebtProfile.find({ proposalId: req.params.proposalId }).sort({ sNo: 1 });

    // Helper: format Indian currency
    const fmtAmt = (n) => {
      if (!n) return '-';
      return '₹' + parseInt(n).toLocaleString('en-IN');
    };

    // 1. Case Type
    const appType = proposal.applicantType || '';
    const loanCat = proposal.loanCategory || 'Fresh Loan';
    const natOfLoan = proposal.natureOfLoan || '';
    const typOfLoan = proposal.typeOfLoan || 'Loan';
    const btBank = proposal.btFromBank || '';
    let caseType = `${proposal.applicantName || 'Applicant'}`;
    if (appType) caseType += ` (${appType})`;
    caseType += ` - ${loanCat === 'Balance Transfer' ? 'BT' + (btBank ? ' from ' + btBank : '') : 'Fresh'} ${natOfLoan} ${typOfLoan}`;
    if (proposal.loanAmount) caseType += ` ${fmtAmt(proposal.loanAmount)}`;
    if (proposal.loanTenure) caseType += ` / ${proposal.loanTenure} Yrs`;

    // 2. CIBIL scores
    let cibilInfo = '';
    if (proposal.documents) {
      const creditDocs = proposal.documents.filter(d => d.category === 'creditReports');
      creditDocs.forEach(d => {
        if (d.extractedDetails && d.extractedDetails.cibilScore) {
          const name = d.extractedDetails.personName || d.classification || 'Applicant';
          cibilInfo += `${name}: ${d.extractedDetails.cibilScore}\n`;
        }
      });
    }
    if (!cibilInfo && proposal.applicantCibil) cibilInfo = `Applicant: ${proposal.applicantCibil}\n`;

    // 3. Co-applicants
    let coAppInfo = '';
    if (proposal.coApplicants && proposal.coApplicants.length > 0) {
      proposal.coApplicants.forEach((ca, i) => {
        coAppInfo += `${i + 1}. ${ca.name || '-'}`;
        if (ca.relation) coAppInfo += ` (${ca.relation})`;
        if (ca.pan) coAppInfo += ` PAN: ${ca.pan}`;
        coAppInfo += '\n';
      });
    }

    // 4. Financial summary from ITR docs
    let finInfo = '';
    if (proposal.documents) {
      const finDocs = proposal.documents.filter(d => d.category === 'financials');
      const fyMap = {};
      finDocs.forEach(d => {
        const classMatch = (d.classification || '').match(/FY\s*(\d{4}-\d{2,4})/i);
        if (classMatch && d.extractedDetails) {
          const fy = classMatch[1];
          const det = d.extractedDetails;
          if (!fyMap[fy]) fyMap[fy] = {};
          if (det.turnover) fyMap[fy].turnover = det.turnover;
          if (det.netProfit) fyMap[fy].netProfit = det.netProfit;
          if (det.grossProfit) fyMap[fy].grossProfit = det.grossProfit;
          if (det.depreciation) fyMap[fy].depreciation = det.depreciation;
        }
      });
      Object.keys(fyMap).sort().forEach(fy => {
        const d = fyMap[fy];
        finInfo += `FY ${fy}: `;
        if (d.turnover) finInfo += `Sales: ${fmtAmt(d.turnover)} | `;
        if (d.netProfit) finInfo += `NP: ${fmtAmt(d.netProfit)} | `;
        if (d.depreciation) finInfo += `Dep: ${fmtAmt(d.depreciation)} | `;
        finInfo = finInfo.replace(/\| $/, '') + '\n';
      });
    }
    // Turnover data fallback
    if (!finInfo && proposal.turnoverData) {
      if (proposal.turnoverData.fy2324) finInfo += `FY 2023-24 Sales: ${fmtAmt(proposal.turnoverData.fy2324)}\n`;
      if (proposal.turnoverData.fy2425) finInfo += `FY 2024-25 Sales: ${fmtAmt(proposal.turnoverData.fy2425)}\n`;
    }

    // 5. Debt profile
    let debtInfo = '';
    let totalEmi = 0, totalPOS = 0;
    debtProfiles.forEach((dp, i) => {
      debtInfo += `${i + 1}. ${dp.bank || '-'} - ${dp.loanType || '-'} | Amt: ${fmtAmt(dp.loanAmount)} | EMI: ${fmtAmt(dp.emi)}\n`;
      totalEmi += dp.emi || 0;
      totalPOS += dp.loanAmount || 0;
    });
    if (totalEmi > 0) debtInfo += `Total EMI: ${fmtAmt(totalEmi)}\n`;

    // 6. Banking summary from extracted bank statements
    let bankingInfo = '';
    if (proposal.documents) {
      const bankDocs = proposal.documents.filter(d => d.category === 'banking');
      bankDocs.forEach(d => {
        if (d.extractedDetails) {
          const det = d.extractedDetails;
          const bankName = det.bankName || d.originalName || '-';
          let line = bankName;
          if (det.averageBalance) line += ` | ABB: ${fmtAmt(det.averageBalance)}`;
          if (det.totalCredits) line += ` | Credits: ${fmtAmt(det.totalCredits)}`;
          if (det.totalDebits) line += ` | Debits: ${fmtAmt(det.totalDebits)}`;
          bankingInfo += line + '\n';
        }
      });
    }

    // 7. Collateral / Property
    let collateralInfo = '';
    if (proposal.collateralType) collateralInfo += `Type: ${proposal.collateralType}\n`;
    if (proposal.propertyValue) collateralInfo += `Value: ${fmtAmt(proposal.propertyValue)}\n`;
    if (proposal.propertyAddress) collateralInfo += `Address: ${proposal.propertyAddress}\n`;

    // 8. Business details
    let bizInfo = '';
    if (proposal.industry) bizInfo += `Industry: ${proposal.industry}\n`;
    if (proposal.businessNature) bizInfo += `Nature: ${proposal.businessNature}\n`;
    if (proposal.yearsInBusiness) bizInfo += `Vintage: ${proposal.yearsInBusiness} Yrs\n`;
    if (proposal.businessWebsiteSummary) bizInfo += `Summary: ${proposal.businessWebsiteSummary.substring(0, 300)}\n`;

    // Build the full CAM text
    let camText = `*CREDIT APPRAISAL MEMO*\n`;
    camText += `━━━━━━━━━━━━━━━\n`;
    camText += `*${caseType}*\n\n`;

    if (bizInfo) camText += `*Business:*\n${bizInfo}\n`;
    if (coAppInfo) camText += `*Co-Applicants:*\n${coAppInfo}\n`;
    if (cibilInfo) camText += `*CIBIL Scores:*\n${cibilInfo}\n`;
    if (finInfo) camText += `*Financials (P&L):*\n${finInfo}\n`;
    if (debtInfo) camText += `*Debt Profile:*\n${debtInfo}\n`;
    if (bankingInfo) camText += `*Banking Summary:*\n${bankingInfo}\n`;
    if (collateralInfo) camText += `*Collateral:*\n${collateralInfo}\n`;

    if (proposal.endUseOfFunds) {
      camText += `*End Use:* ${proposal.endUseOfFunds}`;
      if (proposal.endUseOthersDesc) camText += ` - ${proposal.endUseOthersDesc}`;
      camText += '\n';
    }

    res.json({ success: true, text: camText.trim() });
  } catch (err) {
    console.error('CAM text error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/stage3/:proposalId/submit', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const profilingData = req.body;

    const updates = {
      currentStage: 4,
      status: 'Stage 3 - Profiling Complete',
      profiling: profilingData,
      stage3CompletedAt: new Date().toISOString()
    };

    await updateProposal(proposalId, updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save P&L Sales turnover data
app.post('/stage3/:proposalId/save-turnover-data', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const { fy2324, fy2425 } = req.body;

    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    const turnoverData = {
      fy2324: parseFloat(fy2324) || 0,
      fy2425: parseFloat(fy2425) || 0,
      updatedAt: new Date().toISOString()
    };

    await updateProposal(proposalId, { turnoverData });
    res.json({ success: true, message: 'Turnover data saved successfully' });
  } catch (error) {
    console.error('Save turnover data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 3: Save eligibility data
app.post('/stage3/:proposalId/save-eligibility', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    const eligibilityData = {
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    await updateProposal(proposalId, { eligibilityData });
    res.json({ success: true, message: 'Eligibility data saved successfully' });
  } catch (error) {
    console.error('Save eligibility data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 3: Save banking eligibility data
app.post('/stage3/:proposalId/save-banking-eligibility', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    const bankingEligibilityData = {
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    await updateProposal(proposalId, { bankingEligibilityData });
    res.json({ success: true, message: 'Banking eligibility data saved successfully' });
  } catch (error) {
    console.error('Save banking eligibility data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stage 3: Save GST eligibility data
app.post('/stage3/:proposalId/save-gst-eligibility', async (req, res) => {
  try {
    const proposalId = req.params.proposalId;
    const proposal = await getProposalById(proposalId);
    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Proposal not found' });
    }

    const gstEligibilityData = {
      ...req.body,
      updatedAt: new Date().toISOString()
    };

    await updateProposal(proposalId, { gstEligibilityData });
    res.json({ success: true, message: 'GST eligibility data saved successfully' });
  } catch (error) {
    console.error('Save GST eligibility data error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== STAGE 4 ROUTES ==========

// Admin: Import Chat page
app.get('/admin/import-chat', async (req, res) => {
  try {
    const imports = await ChatImport.find().sort({ createdAt: -1 }).lean();
    const totalPolicies = await BankPolicy.countDocuments({ is_deleted: false });
    const uniqueBanksAgg = await BankPolicy.distinct('bank_name', { is_deleted: false });
    const totalMessages = await ChatMessage.countDocuments({});
    const totalBanks = await Bank.countDocuments({});
    const totalSurrogates = await SurrogateProgram.countDocuments({});
    const stats = {
      totalPolicies,
      uniqueBanks: uniqueBanksAgg.length,
      totalImports: imports.length,
      totalMessages,
      totalBanks,
      totalSurrogates
    };
    res.render('admin-import-chat', { imports, stats });
  } catch (err) {
    console.error('Admin import page error:', err);
    res.status(500).send('Error loading import page');
  }
});

// Admin: Upload & process policy files (txt, pdf, jpg, png)
app.post('/admin/import-chat', policyUpload.array('policyFiles', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const imports = [];
    let firstId = null;

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const isBinary = ['.pdf', '.jpg', '.jpeg', '.png'].includes(ext);

      // Compute file hash from buffer (memoryStorage)
      let fileHash;
      if (isBinary) {
        fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      } else {
        const fileContent = file.buffer.toString('utf8');
        fileHash = computeFileHash(fileContent);
      }

      // File-level dedup
      const existingImport = await ChatImport.findOne({ file_hash_sha256: fileHash });
      if (existingImport) {
        const activePolicies = await BankPolicy.countDocuments({ chat_import_id: existingImport._id, is_deleted: false });
        if (activePolicies > 0) {
          imports.push({ filename: file.originalname, error: 'Already imported (' + activePolicies + ' active policies)' });
          continue;
        }
        await ChatMessage.deleteMany({ chat_import_id: existingImport._id });
        await BankPolicy.deleteMany({ chat_import_id: existingImport._id, is_deleted: true });
        await ChatImport.findByIdAndDelete(existingImport._id);
      }

      // Determine import type
      let importType = 'whatsapp_chat';
      if (ext === '.pdf') importType = 'pdf_document';
      else if (['.jpg', '.jpeg', '.png'].includes(ext)) importType = 'image_document';

      const importDoc = await ChatImport.create({
        filename: file.originalname,
        file_hash_sha256: fileHash,
        file_size_bytes: file.buffer.length,
        import_type: importType,
        status: 'uploading',
        processing_log: ['File uploaded: ' + file.originalname + ' (' + importType + ')']
      });

      if (!firstId) firstId = importDoc._id;

      // Dispatch to appropriate processor
      if (ext === '.txt') {
        const fileContent = file.buffer.toString('utf8');
        processLargeChat(importDoc._id, fileContent);
      } else {
        // Write buffer to temp file for OCR processing (runs in background)
        const os = require('os');
        const tempPath = path.join(os.tmpdir(), `chat_import_${Date.now()}_${file.originalname}`);
        fs.writeFileSync(tempPath, file.buffer);
        const fileType = ext === '.pdf' ? 'pdf' : 'image';
        processDocumentImport(importDoc._id, tempPath, fileType);
      }

      imports.push({ id: importDoc._id, filename: file.originalname });
    }

    res.json({ success: true, importId: firstId, imports });
  } catch (err) {
    console.error('Policy upload error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Process pasted text directly
app.post('/admin/import-chat/paste', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ success: false, error: 'Text is too short' });
    }

    const fileContent = text.trim();
    const fileHash = computeFileHash(fileContent);

    // Allow re-import if previous import's policies are all deleted
    const existingImport = await ChatImport.findOne({ file_hash_sha256: fileHash });
    if (existingImport) {
      const activePolicies = await BankPolicy.countDocuments({ chat_import_id: existingImport._id, is_deleted: false });
      if (activePolicies > 0) {
        return res.json({ success: false, error: 'This text has already been imported (' + activePolicies + ' active policies). Delete them first.' });
      }
      await ChatMessage.deleteMany({ chat_import_id: existingImport._id });
      await BankPolicy.deleteMany({ chat_import_id: existingImport._id, is_deleted: true });
      await ChatImport.findByIdAndDelete(existingImport._id);
    }

    const importDoc = await ChatImport.create({
      filename: 'Pasted text (' + new Date().toLocaleString() + ')',
      file_hash_sha256: fileHash,
      file_size_bytes: Buffer.byteLength(fileContent, 'utf8'),
      import_type: 'pasted_text',
      status: 'uploading',
      processing_log: ['Text pasted directly (' + fileContent.length + ' characters)']
    });

    // Start async processing
    processLargeChat(importDoc._id, fileContent);

    res.json({ success: true, importId: importDoc._id });
  } catch (err) {
    console.error('Paste import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Poll import processing status
app.get('/admin/import-chat/:id/status', async (req, res) => {
  try {
    const importDoc = await ChatImport.findById(req.params.id).lean();
    if (!importDoc) return res.status(404).json({ error: 'Import not found' });
    res.json(importDoc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete import and all associated data
app.post('/admin/import-chat/:id/delete', async (req, res) => {
  try {
    const importId = req.params.id;
    const importDoc = await ChatImport.findById(importId);
    if (!importDoc) return res.status(404).json({ success: false, error: 'Import not found' });

    // Delete associated messages
    await ChatMessage.deleteMany({ chat_import_id: importId });
    // Soft-delete associated policies
    await BankPolicy.updateMany({ chat_import_id: importId }, { $set: { is_deleted: true, deleted_at: new Date() } });
    // Delete the import record itself
    await ChatImport.findByIdAndDelete(importId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Browse all policies
app.get('/admin/policies', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 50;
    const filters = {
      bank: req.query.bank || '',
      department: req.query.department || '',
      loanType: req.query.loanType || '',
      productType: req.query.productType || '',
      search: req.query.search || ''
    };

    const query = { is_deleted: false };
    if (filters.bank) query.bank_name = filters.bank;
    if (filters.department) query.department = filters.department;
    if (filters.loanType) query.loan_type = filters.loanType;
    if (filters.productType) query.product_type = filters.productType;
    if (filters.search) {
      const searchRegex = new RegExp(filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { bank_name: searchRegex },
        { other_remarks: searchRegex },
        { profiles: searchRegex },
        { programs: searchRegex },
        { collateral_types: searchRegex },
        { loan_type: searchRegex },
        { department: searchRegex },
        { product_type: searchRegex },
        { banker_name: searchRegex },
        { special_conditions: searchRegex },
        { raw_message_text: searchRegex }
      ];
    }

    const totalCount = await BankPolicy.countDocuments(query);
    const totalPages = Math.ceil(totalCount / perPage);
    const policies = await BankPolicy.find(query)
      .populate('bank_id')
      .sort({ bank_name: 1, department: 1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();

    const bankNames = await BankPolicy.distinct('bank_name', { is_deleted: false });
    const loanTypes = await BankPolicy.distinct('loan_type', { is_deleted: false });
    const uniqueBanks = bankNames.length;

    res.render('admin-policies', {
      policies, totalCount, totalPages, currentPage: page,
      bankNames: bankNames.sort(), loanTypes: loanTypes.filter(Boolean).sort(),
      uniqueBanks, filters
    });
  } catch (err) {
    console.error('Policies page error:', err);
    res.status(500).send('Error loading policies');
  }
});

// Admin: Bulk soft-delete policies (must be before :id route)
app.post('/admin/policies/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'No policy IDs provided' });
    }
    const result = await BankPolicy.updateMany(
      { _id: { $in: ids } },
      { $set: { is_deleted: true, deleted_at: new Date() } }
    );
    res.json({ success: true, deletedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Re-extract fields from raw_message_text for all policies
app.post('/admin/policies/reextract', async (req, res) => {
  try {
    const policies = await BankPolicy.find({ is_deleted: false, raw_message_text: { $exists: true, $ne: '' } });
    let updated = 0;
    for (const p of policies) {
      const text = p.raw_message_text;

      // Full regex re-extraction with updated patterns
      const regexResults = regexExtractPolicies(text);
      const regexPolicy = Array.isArray(regexResults) ? regexResults[0] || {} : regexResults;

      // Overwrite all extracted fields
      const changes = {};
      const fillable = [
        'loan_min_lakhs', 'loan_max_lakhs', 'roi_min_pct', 'roi_max_pct',
        'ltv_pct', 'ltv_min_pct', 'geo_limits_km', 'min_cibil',
        'max_tenure_years', 'processing_fee_pct', 'loan_nature',
        'own_house_required', 'max_usl', 'special_conditions', 'other_remarks',
        'banker_name', 'banker_contact', 'profiles', 'programs', 'collateral_types'
      ];

      for (const field of fillable) {
        const val = regexPolicy[field];
        if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
          changes[field] = val;
        }
      }

      if (Object.keys(changes).length > 0) {
        await BankPolicy.findByIdAndUpdate(p._id, { $set: changes });
        updated++;
      }
    }
    res.json({ success: true, total: policies.length, updated });
  } catch (err) {
    console.error('Re-extract error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Re-extract single policy via AI
app.post('/admin/policies/:id/reextract', async (req, res) => {
  try {
    const policy = await BankPolicy.findById(req.params.id);
    if (!policy) return res.status(404).json({ success: false, error: 'Policy not found' });
    if (!policy.raw_message_text) return res.status(400).json({ success: false, error: 'No raw text available' });

    const text = policy.raw_message_text;

    // Phase 1: Full regex extraction (fast, uses all updated patterns)
    const regexResults = regexExtractPolicies(text);
    const regexPolicy = Array.isArray(regexResults) ? regexResults[0] || {} : regexResults;

    // Phase 2: AI extraction for fields regex missed
    let aiResult = {};
    try {
      aiResult = await aiExtractPolicy(text);
    } catch (aiErr) {
      console.error('AI re-extract fallback error:', aiErr.message);
    }

    // Merge: regex takes priority, AI fills gaps
    const merged = { ...aiResult, ...regexPolicy };

    // Apply all extracted fields (overwrite with fresh extraction)
    const changes = {};
    const fillable = [
      'bank_name', 'department', 'loan_type', 'product_type',
      'loan_min_lakhs', 'loan_max_lakhs', 'roi_min_pct', 'roi_max_pct',
      'ltv_pct', 'ltv_min_pct', 'geo_limits_km', 'min_cibil',
      'max_tenure_years', 'processing_fee_pct', 'loan_nature',
      'own_house_required', 'max_usl', 'special_conditions', 'other_remarks',
      'banker_name', 'banker_contact', 'profiles', 'programs', 'collateral_types'
    ];

    for (const field of fillable) {
      const val = merged[field];
      if (val !== null && val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0)) {
        changes[field] = val;
      }
    }

    if (Object.keys(changes).length > 0) {
      await BankPolicy.findByIdAndUpdate(policy._id, { $set: changes });
    }

    res.json({ success: true, updated: Object.keys(changes).length, fields: Object.keys(changes) });
  } catch (err) {
    console.error('Re-extract single policy error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Soft-delete policy
app.post('/admin/policies/:id/delete', async (req, res) => {
  try {
    await BankPolicy.findByIdAndUpdate(req.params.id, { is_deleted: true, deleted_at: new Date() });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Update policy
app.post('/admin/policies/:id/update', async (req, res) => {
  try {
    const allowedFields = [
      'bank_name', 'department', 'loan_type', 'product_type',
      'loan_min_lakhs', 'loan_max_lakhs', 'roi_min_pct', 'roi_max_pct',
      'ltv_pct', 'ltv_min_pct', 'geo_limits_km', 'min_cibil',
      'max_tenure_years', 'processing_fee_pct', 'loan_nature',
      'own_house_required', 'max_usl',
      'special_conditions', 'other_remarks', 'banker_name', 'banker_contact'
    ];
    const arrayFields = ['profiles', 'programs', 'collateral_types'];
    const numberFields = [
      'loan_min_lakhs', 'loan_max_lakhs', 'roi_min_pct', 'roi_max_pct',
      'ltv_pct', 'ltv_min_pct', 'geo_limits_km', 'min_cibil',
      'max_tenure_years', 'processing_fee_pct', 'max_usl'
    ];

    const update = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (numberFields.includes(field)) {
          const val = req.body[field];
          update[field] = val === '' || val === null ? null : Number(val);
        } else {
          update[field] = req.body[field];
        }
      }
    }
    for (const field of arrayFields) {
      if (req.body[field] !== undefined) {
        const val = req.body[field];
        update[field] = typeof val === 'string'
          ? val.split(',').map(s => s.trim()).filter(Boolean)
          : Array.isArray(val) ? val : [];
      }
    }

    await BankPolicy.findByIdAndUpdate(req.params.id, { $set: update });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stage 4: Banker match view
app.get('/stage4/:proposalId', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).send('Proposal not found');

    // Get or create match record
    let matchRecord = await BankerMatch.findOne({ proposal_id: req.params.proposalId });

    if (!matchRecord) {
      // Auto-run matching on first visit - attach surrogate IDs to policies
      const policies = await BankPolicy.find({ is_deleted: false }).lean();
      // Attach surrogate program IDs to each policy
      for (const p of policies) {
        const surrogates = await SurrogateProgram.find({ product_id: p._id }).select('_id').lean();
        p._surrogateIds = surrogates.map(s => s._id);
      }
      const matches = findMatchingPolicies(proposal, policies);

      let cibilScore = null;
      if (proposal.documents) {
        for (const doc of proposal.documents) {
          if (doc.extractedDetails && doc.extractedDetails.cibilScore) {
            cibilScore = parseInt(doc.extractedDetails.cibilScore);
            break;
          }
        }
      }

      matchRecord = await BankerMatch.create({
        proposal_id: req.params.proposalId,
        matches,
        proposal_snapshot: {
          applicant_name: proposal.applicantName,
          loan_amount: parseFloat(proposal.loanAmount) || 0,
          loan_type: proposal.typeOfLoan,
          loan_nature: proposal.natureOfLoan,
          cibil_score: cibilScore,
          industry: proposal.industry,
          applicant_type: proposal.applicantType
        },
        last_matched_at: new Date()
      });
    }

    // Populate bank details and surrogates for each match
    const matchesWithDetails = [];
    for (const m of (matchRecord.matches || [])) {
      const mObj = m.toObject ? m.toObject() : { ...m };
      // Populate bank info
      if (mObj.bank_id) {
        mObj.bank_info = await Bank.findById(mObj.bank_id).lean();
      }
      // Populate surrogate programs
      if (mObj.surrogate_matches && mObj.surrogate_matches.length > 0) {
        mObj.surrogate_programs = await SurrogateProgram.find({
          _id: { $in: mObj.surrogate_matches }
        }).lean();
      } else if (mObj.policy_id) {
        mObj.surrogate_programs = await SurrogateProgram.find({
          product_id: mObj.policy_id
        }).lean();
      }
      matchesWithDetails.push(mObj);
    }

    // Get CIBIL score for display
    let cibilScore = matchRecord.proposal_snapshot.cibil_score;
    if (!cibilScore && proposal.documents) {
      for (const doc of proposal.documents) {
        if (doc.extractedDetails && doc.extractedDetails.cibilScore) {
          cibilScore = parseInt(doc.extractedDetails.cibilScore);
          break;
        }
      }
    }

    res.render('stage4-banker-match', {
      proposal,
      matches: matchesWithDetails,
      cibilScore
    });
  } catch (err) {
    console.error('Stage 4 error:', err);
    res.status(500).send('Error loading Stage 4');
  }
});

// Stage 4: Refresh matches
app.post('/stage4/:proposalId/refresh-matches', async (req, res) => {
  try {
    const proposal = await getProposalById(req.params.proposalId);
    if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });

    const policies = await BankPolicy.find({ is_deleted: false }).lean();
    // Attach surrogate program IDs to each policy
    for (const p of policies) {
      const surrogates = await SurrogateProgram.find({ product_id: p._id }).select('_id').lean();
      p._surrogateIds = surrogates.map(s => s._id);
    }
    const matches = findMatchingPolicies(proposal, policies);

    let cibilScore = null;
    if (proposal.documents) {
      for (const doc of proposal.documents) {
        if (doc.extractedDetails && doc.extractedDetails.cibilScore) {
          cibilScore = parseInt(doc.extractedDetails.cibilScore);
          break;
        }
      }
    }

    await BankerMatch.findOneAndUpdate(
      { proposal_id: req.params.proposalId },
      {
        matches,
        proposal_snapshot: {
          applicant_name: proposal.applicantName,
          loan_amount: parseFloat(proposal.loanAmount) || 0,
          loan_type: proposal.typeOfLoan,
          loan_nature: proposal.natureOfLoan,
          cibil_score: cibilScore,
          industry: proposal.industry,
          applicant_type: proposal.applicantType
        },
        last_matched_at: new Date()
      },
      { upsert: true }
    );

    res.json({ success: true, matchCount: matches.length });
  } catch (err) {
    console.error('Refresh matches error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stage 4: Update individual match status
app.post('/stage4/:proposalId/match/:idx/status', async (req, res) => {
  try {
    const { status } = req.body;
    const idx = parseInt(req.params.idx);
    const matchRecord = await BankerMatch.findOne({ proposal_id: req.params.proposalId });
    if (!matchRecord) return res.status(404).json({ success: false, error: 'No match record found' });
    if (idx < 0 || idx >= matchRecord.matches.length) return res.status(400).json({ success: false, error: 'Invalid match index' });

    matchRecord.matches[idx].status = status;
    await matchRecord.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Browse banks/NBFCs/HFCs
app.get('/admin/banks', async (req, res) => {
  try {
    const typeFilter = req.query.type || '';
    const query = {};
    if (typeFilter) query.bank_type = typeFilter;

    const banks = await Bank.find(query).sort({ bank_name: 1 }).lean();

    // Get policy counts per bank
    for (const bank of banks) {
      bank.policy_count = await BankPolicy.countDocuments({ bank_id: bank._id, is_deleted: false });
    }

    res.render('admin-banks', { banks, typeFilter });
  } catch (err) {
    console.error('Banks page error:', err);
    res.status(500).send('Error loading banks');
  }
});

// Admin: Bank Contacts - extract contacts from WhatsApp chat
app.get('/admin/bank-contacts', (req, res) => {
  res.render('admin-bank-contacts');
});

// Admin: Bank Contacts - fetch saved contacts from DB
app.get('/admin/bank-contacts/saved', async (req, res) => {
  try {
    const contacts = await BankerContact.find({ phone: { $regex: /\d{10,}/ } }).sort({ message_count: -1 }).lean();
    const mapped = contacts.map(c => ({
      phone: c.phone,
      name: c.name || c.phone,
      messageCount: c.message_count || 0,
      lastActive: c.last_active ? c.last_active.toISOString().split('T')[0] : '',
      bank: c.bank || '',
      bankType: c.bank_type || ''
    }));
    res.json({ success: true, contacts: mapped, totalMessages: mapped.reduce((s, c) => s + c.messageCount, 0) });
  } catch (err) {
    console.error('Fetch saved contacts error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Bank Contacts - extract contacts from uploaded/pasted chat
app.post('/admin/bank-contacts/extract', policyUpload.single('chatFile'), async (req, res) => {
  try {
    let chatText = '';

    if (req.file) {
      chatText = req.file.buffer.toString('utf8');
    } else if (req.body && req.body.text) {
      chatText = req.body.text;
    } else {
      return res.status(400).json({ success: false, error: 'No file or text provided' });
    }

    const { messages } = parseWhatsAppChat(chatText);
    if (!messages || messages.length === 0) {
      return res.json({ success: true, contacts: [], totalMessages: 0 });
    }

    // Group by sender
    const senderMap = {};
    for (const msg of messages) {
      if (!msg.sender) continue;
      const key = msg.sender;
      if (!senderMap[key]) {
        senderMap[key] = { sender: key, messages: [], lastDate: null };
      }
      senderMap[key].messages.push(msg);
      if (msg.parsedDate && (!senderMap[key].lastDate || msg.parsedDate > senderMap[key].lastDate)) {
        senderMap[key].lastDate = msg.parsedDate;
      }
    }

    // Build contacts list
    const contacts = [];
    const bankKeys = Object.keys(KNOWN_BANKS_MAP).sort((a, b) => b.length - a.length);

    for (const key of Object.keys(senderMap)) {
      const info = senderMap[key];
      const phone = extractSenderNumber(info.sender);
      const isPhoneOnly = /^\+?\d[\d\s-]{8,}$/.test(info.sender.replace(/^~/, '').trim());

      // Determine display name
      let name = '';
      if (!isPhoneOnly) {
        name = info.sender.replace(/^~/, '').trim();
        // If name contains the phone number, strip it out
        if (phone && phone !== info.sender) {
          name = name.replace(/\+?\d[\d\s-]{8,}/, '').replace(/^[\s~]+|[\s~]+$/g, '').trim();
        }
      }

      // Scan messages for bank mentions
      const bankMentions = {};
      for (const msg of info.messages) {
        const text = (msg.text || '').toLowerCase();
        for (const bk of bankKeys) {
          if (text.includes(bk.toLowerCase())) {
            bankMentions[bk] = (bankMentions[bk] || 0) + 1;
          }
        }
      }
      // Pick most-mentioned bank
      let associatedBank = '';
      let maxMentions = 0;
      for (const [bk, count] of Object.entries(bankMentions)) {
        if (count > maxMentions) { maxMentions = count; associatedBank = bk; }
      }

      contacts.push({
        phone: phone,
        name: name || phone,
        messageCount: info.messages.length,
        lastActive: info.lastDate ? info.lastDate.toISOString().split('T')[0] : '',
        bank: associatedBank,
        bankType: associatedBank ? (KNOWN_BANKS_MAP[associatedBank] || '') : ''
      });
    }

    // Remove contacts without a valid phone number and sort by message count
    const validContacts = contacts.filter(c => /\d{10,}/.test(c.phone));
    validContacts.sort((a, b) => b.messageCount - a.messageCount);

    res.json({ success: true, contacts: validContacts, totalMessages: messages.length });
  } catch (err) {
    console.error('Bank contacts extract error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Bank Contacts - save extracted contacts to DB
app.post('/admin/bank-contacts/save', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: 'No contacts to save' });
    }

    let saved = 0, updated = 0, skipped = 0;
    for (const c of contacts) {
      if (!c.phone || !/\d{10,}/.test(c.phone)) { skipped++; continue; }
      const existing = await BankerContact.findOne({ phone: c.phone });
      if (existing) {
        // Update if new data is richer
        const updates = {};
        if (c.name && c.name !== c.phone && (!existing.name || existing.name === existing.phone)) updates.name = c.name;
        if (c.bank && !existing.bank) { updates.bank = c.bank; updates.bank_type = c.bankType || ''; }
        if (c.messageCount > (existing.message_count || 0)) updates.message_count = c.messageCount;
        if (c.lastActive) {
          const newDate = new Date(c.lastActive);
          if (!existing.last_active || newDate > existing.last_active) updates.last_active = newDate;
        }
        if (Object.keys(updates).length > 0) {
          await BankerContact.updateOne({ _id: existing._id }, { $set: updates });
          updated++;
        } else {
          skipped++;
        }
      } else {
        await BankerContact.create({
          phone: c.phone,
          name: c.name || '',
          bank: c.bank || '',
          bank_type: c.bankType || '',
          message_count: c.messageCount || 0,
          last_active: c.lastActive ? new Date(c.lastActive) : null
        });
        saved++;
      }
    }

    res.json({ success: true, saved, updated, skipped, total: contacts.length });
  } catch (err) {
    console.error('Bank contacts save error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin: Bank detail + linked policies
app.get('/admin/banks/:id', async (req, res) => {
  try {
    const bank = await Bank.findById(req.params.id).lean();
    if (!bank) return res.status(404).send('Bank not found');

    const policies = await BankPolicy.find({ bank_id: bank._id, is_deleted: false })
      .sort({ createdAt: -1 }).lean();
    const surrogates = await SurrogateProgram.find({ bank_id: bank._id }).lean();

    res.render('admin-banks', { banks: [bank], typeFilter: '', detail: true, bank, policies, surrogates });
  } catch (err) {
    console.error('Bank detail error:', err);
    res.status(500).send('Error loading bank detail');
  }
});

// Admin: Browse stored messages from import
app.get('/admin/messages/:importId', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 100;
    const filters = {
      type: req.query.type || '',
      sender: req.query.sender || '',
      duplicates: req.query.duplicates || ''
    };

    const query = { chat_import_id: req.params.importId };
    if (filters.type) query.message_type = filters.type;
    if (filters.sender) query.sender_number = filters.sender;
    if (filters.duplicates === 'hide') query.is_duplicate = false;
    else if (filters.duplicates === 'only') query.is_duplicate = true;

    const totalCount = await ChatMessage.countDocuments(query);
    const totalPages = Math.ceil(totalCount / perPage);
    const messages = await ChatMessage.find(query)
      .sort({ timestamp: 1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean();

    const importDoc = await ChatImport.findById(req.params.importId).lean();
    const senders = await ChatMessage.distinct('sender_number', { chat_import_id: req.params.importId });

    res.render('admin-messages', {
      messages, importDoc, totalCount, totalPages, currentPage: page,
      senders: senders.filter(Boolean).sort(), filters, importId: req.params.importId
    });
  } catch (err) {
    console.error('Messages page error:', err);
    res.status(500).send('Error loading messages');
  }
});

// Admin: Browse surrogate programs
app.get('/admin/surrogates', async (req, res) => {
  try {
    const typeFilter = req.query.type || '';
    const query = {};
    if (typeFilter) query.program_type = typeFilter;

    const surrogates = await SurrogateProgram.find(query)
      .populate('bank_id')
      .populate('product_id', 'bank_name loan_type product_type department')
      .sort({ createdAt: -1 })
      .lean();

    res.render('admin-surrogates', { surrogates, typeFilter });
  } catch (err) {
    console.error('Surrogates page error:', err);
    res.status(500).send('Error loading surrogates');
  }
});

// ========== END STAGE 4 ROUTES ==========

// One-time migration: import proposals from JSON file into MongoDB
app.get('/migrate-proposals', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'data', 'proposals.json');
    if (!fs.existsSync(filePath)) return res.json({ message: 'No proposals.json found' });
    const proposals = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    let imported = 0;
    for (const p of proposals) {
      const exists = await Proposal.findOne({ id: p.id });
      if (!exists) {
        await new Proposal(p).save();
        imported++;
      }
    }
    res.json({ success: true, imported, total: proposals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Migrate existing files from uploads/ directory to GridFS (one-time migration)
app.get('/migrate-files-to-gridfs', async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      return res.json({ success: true, message: 'No uploads directory found, nothing to migrate' });
    }

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    const entries = fs.readdirSync(uploadsDir);
    for (const entry of entries) {
      const entryPath = path.join(uploadsDir, entry);
      const stat = fs.statSync(entryPath);

      if (stat.isDirectory()) {
        // This is a proposal directory
        const proposalId = entry;
        const files = fs.readdirSync(entryPath);

        for (const filename of files) {
          try {
            const exists = await existsInGridFS(filename);
            if (exists) {
              skippedCount++;
              continue;
            }

            const filePath = path.join(entryPath, filename);
            const fileBuffer = fs.readFileSync(filePath);
            await saveToGridFS(fileBuffer, filename, { proposalId, originalName: filename });
            migratedCount++;
            console.log(`Migrated: ${proposalId}/${filename}`);
          } catch (err) {
            errorCount++;
            console.error(`Error migrating ${entry}/${filename}:`, err.message);
          }
        }
      }
    }

    res.json({
      success: true,
      message: `Migration complete: ${migratedCount} files migrated, ${skippedCount} already in GridFS, ${errorCount} errors`
    });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Customer Profiling & Banker Selection App running on port ${port}`);
});