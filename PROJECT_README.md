# Customer Profiling & Banker Selection Application

A comprehensive 4-stage application for customer proposal management, document processing, and banker matching.

## 🚀 Application Overview

This system manages the complete lifecycle of customer banking proposals through 4 distinct stages.

## 📋 Stages

### Stage 1: Customer Proposal Submission
**Purpose**: Capture basic customer information and service requirements

**Features**:
- Comprehensive customer information form (40+ fields)
- Business & financial overview
- Service requirements selection
- Urgency and timeline tracking
- Associate information capture

**Access**: http://localhost:3001/stage1/new

---

### Stage 2: Document Upload & Proposal Perfection
**Purpose**: Upload and manage required documentation

**Features**:
- ✅ **PDF Parsing**: Automatically extracts text from uploaded PDF documents
- 📄 Multi-file upload with drag & drop support
- 📋 Required documents checklist tracking
- ⚠️ Pending documents monitoring
- 📊 Document type categorization
- File format support: PDF, DOC, DOCX, XLS, XLSX, JPG, PNG
- 10MB file size limit per file

**Required Documents**:
1. Financial Statements (Last 3 years)
2. Tax Returns (Last 3 years)
3. Bank Statements (Last 6 months)
4. Business Plan
5. Corporate Documents
6. KYC Documents
7. Collateral Documents
8. Credit Report
9. Trade References
10. Legal Documents

**Access**: http://localhost:3001/stage2/{proposalId}

---

### Stage 3: Comprehensive Customer Profiling
**Purpose**: Detailed profiling across multiple dimensions

**Profiling Categories**:

#### 💰 Financial Profiling
- Total Assets, Liabilities, Net Worth
- Financial ratios (Current Ratio, Debt-to-Equity)
- Revenue, Income, EBITDA
- Cash flow analysis
- Financial health scoring

#### 🏦 Banking Relationship Profiling
- Primary banking relationships
- Account types and duration
- Average balances and transaction volumes
- Loan history and payment behavior
- International banking experience
- Relationship scoring

#### 🏢 Collateral Profiling
- Real estate ownership and valuation
- Equipment and machinery assets
- Inventory and receivables
- Intellectual property
- Personal guarantees
- Loan-to-value calculations
- Collateral liquidity assessment

#### ⚠️ Risk Assessment
- Credit score tracking
- Overall risk rating
- Industry risk evaluation
- Risk factors identification
- Risk mitigation strategies

#### 📊 Additional Profiling
- Management experience
- Market position
- Growth potential
- Competitive advantage analysis
- Analyst recommendations

**Access**: http://localhost:3001/stage3/{proposalId}

---

### Stage 4: Banker Database & Matching
**Purpose**: Admin management of banker database (Coming Soon)

**Planned Features**:
- Banker profile management
- Expertise and specialization tracking
- Automatic banker-customer matching
- Assignment and notification system

---

## 🛠️ Technical Stack

- **Backend**: Node.js + Express
- **Frontend**: EJS Templates
- **File Upload**: Multer
- **PDF Processing**: pdf-parse, pdf-lib, pdfjs-dist
- **Data Storage**: JSON files
- **Styling**: Custom CSS with responsive design

## 📦 Installation

```bash
npm install
```

## ▶️ Running the Application

```bash
npm start
# Or specify a port
PORT=3001 npm start
```

## 🌐 Access Points

- **Dashboard**: http://localhost:3001
- **New Proposal**: http://localhost:3001/stage1/new
- **View Proposals**: http://localhost:3001/proposals
- **Stage 2 (Documents)**: http://localhost:3001/stage2/{proposalId}
- **Stage 3 (Profiling)**: http://localhost:3001/stage3/{proposalId}

## 📁 Project Structure

```
├── index.js                 # Main application server
├── package.json            # Dependencies
├── data/                   # JSON data storage
│   ├── proposals.json     # Customer proposals
│   └── bankers.json       # Banker database
├── uploads/               # Uploaded documents (organized by proposal ID)
├── views/                 # EJS templates
│   ├── dashboard.ejs
│   ├── stage1-proposal.ejs
│   ├── stage2-documents.ejs
│   ├── stage3-profiling.ejs
│   └── proposals-list.ejs
└── public/
    └── css/
        ├── main.css
        └── proposal.css
```

## 🔐 User Roles

- **Associate**: Create proposals, upload documents, complete profiling
- **Admin**: Manage banker database, assign bankers (Stage 4)

## 📊 Data Flow

1. **Associate** creates customer proposal (Stage 1)
2. **Associate** uploads required documents (Stage 2)
   - PDFs are automatically parsed for text extraction
   - Document checklist is tracked
3. **Associate** completes comprehensive profiling (Stage 3)
   - Financial analysis
   - Banking relationships
   - Collateral assessment
   - Risk evaluation
4. **Admin** matches with appropriate banker (Stage 4 - Coming Soon)

## 🎯 Key Features

✅ Multi-stage workflow with progress tracking  
✅ Comprehensive data capture  
✅ PDF parsing and text extraction  
✅ Document management with checklist  
✅ Detailed financial profiling  
✅ Risk assessment tools  
✅ Responsive design  
✅ Real-time form validation  
✅ Auto-calculated fields  

## 📝 Notes

- All data is stored in JSON files for easy portability
- Uploaded files are organized by proposal ID
- PDF text extraction helps with document verification
- Progress tracker shows current stage across all views
- Stage navigation is automatically enabled as stages complete

## 🔜 Upcoming Features (Stage 4)

- Banker database management
- Intelligent banker matching algorithm
- Assignment workflow
- Email notifications
- Reporting and analytics
- Export functionality

---

**Version**: 1.0.0  
**Last Updated**: January 2026
