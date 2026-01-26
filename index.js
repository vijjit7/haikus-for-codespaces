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
const port = process.env.PORT || 3000;

// Configure pdfjs-dist worker - disable worker to avoid errors
pdfjsLib.GlobalWorkerOptions.workerSrc = false;

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
// TABLE-AWARE PDF PARSING (Camelot/Tabula-like)
// ============================================

// Enhanced PDF text extraction with table detection and structured data extraction
async function extractPDFWithTableDetection(pdfPath) {
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(dataBuffer),
      verbosity: 0
    });
    
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    let fullText = '';
    let tables = [];
    let structuredContent = [];
    
    // Extract text from each page with position tracking for table detection
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Group text items by vertical position (Y-coordinate) for table detection
      const lines = {};
      textContent.items.forEach(item => {
        const y = Math.round(item.transform[5]); // Y position
        if (!lines[y]) {
          lines[y] = [];
        }
        lines[y].push({
          text: item.str,
          x: item.transform[4], // X position
          width: item.width
        });
      });
      
      // Sort lines by Y position (top to bottom) and items by X position (left to right)
      const sortedYPositions = Object.keys(lines).sort((a, b) => b - a);
      let pageText = '';
      let pageLines = [];
      
      sortedYPositions.forEach(y => {
        const lineItems = lines[y].sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(item => item.text).join(' ');
        pageText += lineText + '\n';
        pageLines.push({
          y: parseFloat(y),
          items: lineItems,
          text: lineText
        });
      });
      
      fullText += pageText;
      
      // Detect tables on this page
      const pageTables = detectAndExtractTables(pageLines, pageNum);
      tables.push(...pageTables);
      
      structuredContent.push({
        pageNum,
        text: pageText,
        hasTable: pageTables.length > 0,
        tables: pageTables
      });
    }
    
    return {
      text: fullText,
      tables,
      structuredContent,
      numPages,
      success: true,
      method: 'pdfjs-table-aware'
    };
  } catch (error) {
    console.error('Table-aware PDF extraction error:', error.message);
    // Fallback to basic pdf-parse
    try {
      const dataBuffer = fs.readFileSync(pdfPath);
      const pdfData = await pdfParse(dataBuffer);
      return {
        text: pdfData.text,
        tables: [],
        structuredContent: [],
        numPages: pdfData.numpages,
        success: true,
        method: 'pdf-parse-fallback'
      };
    } catch (fallbackError) {
      console.error('Fallback PDF extraction error:', fallbackError.message);
      return {
        text: '',
        tables: [],
        structuredContent: [],
        numPages: null,
        success: false,
        method: 'failed'
      };
    }
  }
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

1. Date of Execution: Find the date when the deed was executed/signed
2. Partners: Extract ALL partner names with their profit and loss sharing percentages

Document Text:
${text.substring(0, 4000)}

${tables.length > 0 ? `\n\nDetected Tables:\n${JSON.stringify(tables, null, 2)}` : ''}

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
    
    const response = await axios.post(
      OPENROUTER_API_URL,
      {
        model: 'google/gemini-2.0-flash-exp:free', // Fast and cost-effective Gemini model
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
        timeout: 15000 // 15 second timeout
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
    console.error('Document AI extraction error:', error.message);
    return { success: false, error: error.message };
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
    /(?:dated|executed\s+on|dated\s+this|made\s+this|entered\s+into\s+on|deed\s+dated|this\s+deed\s+of\s+partnership\s+made\s+on)\s*(?:the\s*)?(\d{1,2}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[,\s]+\d{4})/gi,
    /(?:deed\s+date|date\s+of\s+deed|execution\s+date|on\s+this|amendment\s+dated)[\s:]+(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4})/gi,
    /(\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{4})/g
  ];

  for (const pattern of datePatterns) {
    const matches = fullText.matchAll(pattern);
    for (const match of matches) {
      if (match[1] || match[0]) {
        details.deedDate = match[1] || match[0];
        console.log('Found date:', details.deedDate);
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
      size: typeof doc.size === 'number' ? (doc.size / 1024).toFixed(2) + ' KB' : doc.size,
      uploadedAt: doc.uploadedAt
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
    
    // Parse PDF files and extract text
    const fileDetails = [];
    for (const file of allFiles) {
      let extractedText = '';
      let fullText = '';
      let pageCount = null;
      let extractedDetails = null;
      
      if (file.mimetype === 'application/pdf') {
        try {
          // Use table-aware extraction
          const pdfResult = await extractPDFWithTableDetection(file.path);
          fullText = pdfResult.text;
          extractedText = pdfResult.text.substring(0, 500);
          pageCount = pdfResult.numPages;
          
          // Store extracted tables for later use
          file.extractedTables = pdfResult.tables;
          file.structuredContent = pdfResult.structuredContent;
          
          console.log(`✓ Extracted ${pdfResult.tables.length} tables from ${file.originalname} using ${pdfResult.method}`);
        } catch (err) {
          console.error('PDF parsing error:', err);
        }
      }
      
      // Auto-categorize based on filename and extracted text
      const autoCategory = autoCategorizeDocument(file.originalname, extractedText);
      
      // Extract specific details for incorporation documents (partnership deeds)
      if (autoCategory === 'incorporation' && fullText) {
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
      
      fileDetails.push({
        id: file.filename,
        filename: file.filename,
        originalName: file.originalname,
        category: autoCategory,
        autoCategorized: !!autoCategory,
        size: file.size,
        pages: pageCount,
        extractedText: extractedText,
        extractedDetails: extractedDetails,
        uploadedAt: new Date().toISOString()
      });
    }
    
    // Update proposal with document info (reuse the proposal object we already fetched)
    if (!proposal.documents) {
      proposal.documents = [];
    }
    proposal.documents.push(...fileDetails);
    updateProposal(proposalId, { documents: proposal.documents });
    
    res.json({ success: true, files: fileDetails });
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
            
            console.log('Reprocessing:', doc.originalName, 'Text length:', fullText.length, 'Tables found:', pdfResult.tables.length);
            
            // Try Document AI first
            const aiResult = await extractWithDocumentAI(fullText, 'partnership-deed', pdfResult.tables || []);
            let extractedDetails;
            let rawExtraction = { textLength: fullText.length, tablesFound: pdfResult.tables.length };
            
            if (aiResult.success && aiResult.data) {
              console.log('✓ Document AI extraction successful for:', doc.originalName);
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
              rawExtraction.method = 'Fallback (Pattern Matching)';
              rawExtraction.rawResponse = extractedDetails;
            }
            
            proposal.documents[i].extractedDetails = extractedDetails;
            
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

app.listen(port, () => {
  console.log(`Customer Profiling & Banker Selection App running on port ${port}`);
});