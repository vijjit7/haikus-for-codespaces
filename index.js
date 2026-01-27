let express = require('express');
let app = express();
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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
  
  // Credit Reports keywords
  if ((lowerName.includes('credit') || lowerName.includes('cibil') || lowerName.includes('experian')) && 
      (lowerName.includes('report') || lowerName.includes('score'))) {
    return 'creditReports';
  }
  
  // Financials keywords
  if (lowerName.includes('itr') || lowerName.includes('income') && lowerName.includes('tax')) {
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

// ============================================
// 3-TIER PDF EXTRACTION SYSTEM
// ============================================
// Tier 1: Python FastAPI service (PyMuPDF + pdfplumber)
// Tier 2: Direct pdfplumber fallback
// Tier 3: Node.js pdf-parse as final fallback

/**
 * Tier 1: Extract PDF using Python FastAPI service
 * This service provides PyMuPDF (best quality) with pdfplumber fallback
 */
async function extractWithPythonService(pdfPath) {
  try {
    console.log('🔹 Tier 1: Attempting extraction via Python FastAPI service...');
    
    // Check if file exists
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`File not found: ${pdfPath}`);
    }
    
    // Create form data
    const formData = new FormData();
    formData.append('file', fs.createReadStream(pdfPath));
    
    // Call Python service
    const response = await axios.post(`${PDF_SERVICE_URL}/extract`, formData, {
      headers: formData.getHeaders(),
      timeout: PDF_SERVICE_TIMEOUT,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    if (response.data && response.data.success) {
      console.log(`✓ Python service extraction successful (${response.data.method}): ${response.data.total_chars} chars`);
      return {
        text: response.data.text,
        numPages: response.data.num_pages,
        method: `python-${response.data.method}`,
        success: true
      };
    } else {
      throw new Error('Python service returned unsuccessful result');
    }
    
  } catch (error) {
    console.error('✗ Python service extraction failed:', error.message);
    throw error;
  }
}

/**
 * Tier 2: Direct pdfplumber extraction (fallback)
 * Now returns JSON with text and numPages
 */
async function extractWithPdfplumber(pdfPath) {
  console.log('🔹 Tier 2: Attempting direct pdfplumber extraction...');
  
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', ['extract_pdf.py', pdfPath]);
    
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
  
  // Tier 1: Try Python FastAPI service (PyMuPDF + pdfplumber)
  try {
    const result = await extractWithPythonService(pdfPath);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: Python service extraction completed\n');
      return result;
    }
  } catch (tier1Error) {
    console.log('⚠ Tier 1 failed, falling back to Tier 2...\n');
  }
  
  // Tier 2: Try direct pdfplumber (now returns JSON with text and numPages)
  try {
    const result = await extractWithPdfplumber(pdfPath);
    if (result.text && result.text.trim().length > 0) {
      console.log('\n✓ SUCCESS: pdfplumber extraction completed\n');
      return {
        text: result.text,
        numPages: result.numPages || 1,
        method: 'python-pdfplumber-direct',
        success: true
      };
    }
  } catch (tier2Error) {
    console.log('⚠ Tier 2 failed, falling back to Tier 3...\n');
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
  const datePatterns = [
    /(?:dated|executed\s+on|dated\s+this|made\s+this|entered\s+into\s+on|deed\s+dated|this\s+deed\s+of\s+partnership\s+made\s+on|made\s+and\s+executed\s+on\s+this)\s*(?:the\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[,\s]+\d{4})/gi,
    /(?:deed\s+date|date\s+of\s+deed|execution\s+date|on\s+this|amendment\s+dated)[\s:]+(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4})/gi,
    /(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{4})/g
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

  // STEP 3: Enhanced profit/loss sharing extraction (fallback if table extraction didn't find partners)
  if (details.partners.length === 0) {
    const sharePatterns = [
      // Pattern: "Partner Name - 50%"
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*[-:]\s*(\d+)\s*%/g,
      // Pattern: "Partner Name shall have 50%"
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:shall|will)\s+(?:be\s+entitled\s+to|receive|have|get)\s+(\d+)\s*%/gi,
      // Pattern: "50% to Partner Name"
      /(\d+)\s*%\s+(?:to|for|of)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
      // Pattern: "profit sharing ratio: Partner1 50%, Partner2 50%"
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(\d+)\s*%/g,
      // Pattern: "ratio of 50:50" or "50:50"
      /(?:ratio|share|sharing)(?:\s+is|\s+shall\s+be)?[\s:]+(\d+)\s*:\s*(\d+)/gi,
      // Pattern: "equally" or "equal shares"
      /(?:share|profit|loss)(?:s)?\s+(?:shall\s+be\s+)?(?:equally|equal)/gi
    ];

    const foundShares = new Set();
  
  for (const pattern of sharePatterns) {
    const matches = fullText.matchAll(pattern);
      for (const match of matches) {
        if (match[0] && match[0].length < 300 && match[0].length > 3) {
          const shareText = match[0].trim();
          // Avoid duplicate or very similar entries
          if (!foundShares.has(shareText.toLowerCase())) {
            foundShares.add(shareText.toLowerCase());
            details.partners.push({ name: shareText, profitPercent: 'See text', lossPercent: 'See text' });
            console.log('Found share:', shareText);
          }
        }
      }
    }

    // Look for common patterns in partnership deeds
    const profitLossSection = fullText.match(/(?:profit\s+(?:and|&)\s+loss|sharing\s+ratio|distribution\s+of\s+profit)[\s\S]{0,500}/gi);
    if (profitLossSection && profitLossSection.length > 0) {
      console.log('Found profit/loss section:', profitLossSection[0].substring(0, 200));
      
      // Extract any percentage numbers from this section
      const percentages = profitLossSection[0].match(/\d+\s*%/g);
      if (percentages && percentages.length > 0) {
        const percentText = `Profit sharing: ${percentages.join(', ')}`;
        if (!foundShares.has(percentText.toLowerCase())) {
          details.partners.push({ name: percentText, profitPercent: 'See text', lossPercent: 'See text' });
          console.log('Found percentages in profit section:', percentText);
        }
      }
    }
  }

  console.log('Extraction complete. Date:', details.deedDate, 'Partners:', details.partners.length);
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
      
      // Find and update the document in the proposal
      const docIndex = proposal.documents.findIndex(d => d.filename === fileDetail.filename);
      if (docIndex !== -1) {
        proposal.documents[docIndex].pages = pageCount;
        proposal.documents[docIndex].extractedText = extractedText;
        proposal.documents[docIndex].extractedDetails = extractedDetails;
        
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
app.get('/stage2/:proposalId', (req, res) => {
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
      extractedDetails: doc.extractedDetails // Include extracted details
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
  
  res.render('stage2-documents', { 
    proposal,
    proposalId: req.params.proposalId,
    requiredDocuments: REQUIRED_DOCUMENTS,
    uploadedFiles
  });
});

app.post('/stage2/:proposalId/upload', upload.array('documents', 10), async (req, res) => {
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
            
            // Try Document AI first
            const aiResult = await extractWithDocumentAI(fullText, 'partnership-deed', pdfResult.tables || []);
            let extractedDetails;
            let rawExtraction = { textLength: fullText.length, tablesFound: pdfResult.tables.length };
            
            if (aiResult.success && aiResult.data) {
              console.log('✓ Document AI extraction successful for:', doc.originalName);
              console.log('AI Extracted Data:', JSON.stringify(aiResult.data, null, 2));
              const partners = (aiResult.data.partners || []).map(p => ({
                name: p.name,
                profitPercent: p.profitPercentage !== null ? p.profitPercentage : 'Not specified',
                lossPercent: p.lossPercentage !== null ? p.lossPercentage : 'Not specified'
              }));
              extractedDetails = {
                deedDate: aiResult.data.dateOfExecution,
                partners: partners
              };
              rawExtraction.method = 'AI (Gemini)';
              rawExtraction.rawResponse = aiResult.data;
            } else {
              console.log('⚠ Document AI failed, using fallback for:', doc.originalName);
              extractedDetails = extractPartnershipDeedDetails(fullText, pdfResult.tables || []);
              console.log('Fallback Extracted Data:', JSON.stringify(extractedDetails, null, 2));
              rawExtraction.method = 'Fallback (Pattern Matching)';
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

// Stage 3: Customer Profiling
app.get('/stage3/:proposalId', (req, res) => {
  const proposal = getProposalById(req.params.proposalId);
  if (!proposal) {
    return res.status(404).send('Proposal not found');
  }
  res.render('stage3-profiling', { proposal });
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Customer Profiling & Banker Selection App running on port ${port}`);
});