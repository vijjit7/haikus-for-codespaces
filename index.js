let express = require('express');
let app = express();
let ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const port = process.env.PORT || 3000;

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
    
    // Check for duplicate filenames
    const duplicates = [];
    const uploadedFileNames = files.map(f => f.originalname);
    
    uploadedFileNames.forEach(fileName => {
      const isDuplicate = existingDocuments.some(doc => doc.originalName === fileName);
      if (isDuplicate) {
        duplicates.push(fileName);
      }
    });
    
    if (duplicates.length > 0) {
      // Delete the uploaded files since they're duplicates
      files.forEach(file => {
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
    for (const file of files) {
      let extractedText = '';
      if (file.mimetype === 'application/pdf') {
        try {
          const dataBuffer = fs.readFileSync(file.path);
          const pdfData = await pdfParse(dataBuffer);
          extractedText = pdfData.text.substring(0, 500); // First 500 chars
        } catch (err) {
          console.error('PDF parsing error:', err);
        }
      }
      
      // Auto-categorize based on filename and extracted text
      const autoCategory = autoCategorizeDocument(file.originalname, extractedText);
      
      fileDetails.push({
        id: file.filename,
        filename: file.filename,
        originalName: file.originalname,
        category: autoCategory,
        autoCategorized: !!autoCategory,
        size: file.size,
        extractedText: extractedText,
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