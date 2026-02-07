// Simulate the stage3-cam.ejs debit parser for the ICICI bank statement
const fs = require('fs');
const proposals = JSON.parse(fs.readFileSync('./data/proposals.json', 'utf8'));

const proposal = proposals.find(p => p.id === '1770050619765');
const iciciDoc = proposal.documents.find(d =>
    d.category === 'banking' &&
    d.extractedDetails && d.extractedDetails.accountNumber === '720305000315'
);

if (!iciciDoc) { console.log('ICICI doc not found!'); process.exit(1); }
console.log('Found:', iciciDoc.documentName);

const text = iciciDoc.extractedText || '';

// Replicate the parser logic from stage3-cam.ejs
const rawLines = text.split(/\n/);

const lineHasDate = (line) => /\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(line) || /\d{2}\/\w{3}\/\d{4}/i.test(line);
const lineHasAmounts = (line) => /\d{1,3}(,\d{2,3})*\.\d{2}/.test(line) || /\d{1,2},\d{2},\d{3}/.test(line);
const isHeaderFooter = (line) => /^\s*(Date|Particulars|Debit|Credit|Balance|Opening\s*Balance|Closing\s*Balance|Total|Page|Statement|From\s+\d|Period|Account)/i.test(line);

const lines = [];
let currentTxnLine = '';
let currentHasDate = false;

rawLines.forEach((line, idx) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) return;
    if (isHeaderFooter(trimmedLine)) return;

    const hasDate = lineHasDate(trimmedLine);
    const startsNewTxn = hasDate && (/^\s*\d/.test(trimmedLine) || /^[A-Z]\d/.test(trimmedLine));

    if (startsNewTxn) {
        if (currentTxnLine && currentHasDate && lineHasAmounts(currentTxnLine)) {
            lines.push(currentTxnLine);
        }
        currentTxnLine = trimmedLine;
        currentHasDate = true;
    } else if (currentTxnLine) {
        currentTxnLine += ' ' + trimmedLine;
        if (currentHasDate && lineHasAmounts(currentTxnLine)) {
            const nextLine = rawLines[idx + 1]?.trim() || '';
            if (lineHasDate(nextLine) && (/^\s*\d/.test(nextLine) || /^[A-Z]\d/.test(nextLine))) {
                lines.push(currentTxnLine);
                currentTxnLine = '';
                currentHasDate = false;
            }
        }
    }
});

if (currentTxnLine && currentHasDate && lineHasAmounts(currentTxnLine)) {
    lines.push(currentTxnLine);
}

console.log(`Merged lines: ${lines.length} (from ${rawLines.length} raw lines)`);

const creditKeywords = ['INF/', 'NEFT', 'RTGS', 'IMPS', 'UPI/', 'MMT/', 'CLG/', 'GRS/', 'INFT/', 'TRF', 'BY ', 'CREDIT', 'DEPOSIT', 'TO A/C'];
const debitKeywords = ['BIL/', 'GIB/', 'ATM/', 'CAM/', 'MPS/', 'NFS/', 'IPS/', 'ACH', 'EMI', 'NACH', 'BIL/ONL', 'Chg', 'FROM A/C', 'DEBIT', 'WITHDRAW'];

const seenCredits = new Set();
const seenDebits = new Set();
const monthDebitsTotal = {};
const monthCreditsTotal = {};
const monthDebitTxns = {}; // Track individual debit transactions per month

lines.forEach(line => {
    // Special handling for Int.Coll lines: use the "to" date
    let dateSearchLine = line;
    const intCollMatch = line.match(/Int\.Coll.*?to\s+(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i);
    if (intCollMatch) {
        dateSearchLine = intCollMatch[1] + '/' + intCollMatch[2] + '/' + intCollMatch[3] + ' ' + line;
    }

    const dateMatch1 = dateSearchLine.match(/(\d{2})\/(\w{3})\/(\d{4})/i);
    const dateMatch2 = dateSearchLine.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);

    let txnDate = null;

    if (dateMatch1) {
        const monthNamesMap = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
        const monthNum = monthNamesMap[dateMatch1[2].toLowerCase()] || '01';
        txnDate = { dateStr: dateMatch1[0], day: dateMatch1[1], month: dateMatch1[2], monthNum, year: dateMatch1[3], monthKey: monthNum + '-' + dateMatch1[3] };
    } else if (dateMatch2) {
        const monthNum = dateMatch2[2];
        const monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        txnDate = { dateStr: dateMatch2[0], day: dateMatch2[1], month: monthNames[parseInt(monthNum)] || monthNum, monthNum, year: dateMatch2[3], monthKey: monthNum + '-' + dateMatch2[3] };
    }

    if (!txnDate) return;

    let cleanedLine = line
        .replace(/(\d)\s+\.(\d)/g, '$1.$2')
        .replace(/(\d)\.\s+(\d)/g, '$1.$2')
        .replace(/(\d),\s+(\d)/g, '$1,$2')
        .replace(/(\.\d{2})(\d)/g, '$1 $2');

    const lineAmounts = [];
    const amtRegex1 = /\b([\d,]+\.\d{2})\b/g;
    const amtRegex2 = /\b(\d{1,2},\d{2},\d{3})\b/g;
    const amtRegex3 = /\b(\d[\d,]*\d)\b/g;

    let amtMatch;
    while ((amtMatch = amtRegex1.exec(cleanedLine)) !== null) {
        const val = parseFloat(amtMatch[1].replace(/,/g, ''));
        if (val > 0 && val < 1000000000) {
            const afterStr = cleanedLine.substring(amtMatch.index + amtMatch[0].length, amtMatch.index + amtMatch[0].length + 5);
            if (/^\.\d{4}/.test(afterStr)) continue;
            lineAmounts.push({ value: val, str: amtMatch[1], index: amtMatch.index });
        }
    }

    if (lineAmounts.length === 0) {
        while ((amtMatch = amtRegex2.exec(cleanedLine)) !== null) {
            const val = parseFloat(amtMatch[1].replace(/,/g, ''));
            if (val > 100 && val < 1000000000) {
                lineAmounts.push({ value: val, str: amtMatch[1], index: amtMatch.index });
            }
        }
    }

    if (lineAmounts.length === 0) {
        while ((amtMatch = amtRegex3.exec(cleanedLine)) !== null) {
            const val = parseFloat(amtMatch[1].replace(/,/g, ''));
            if (val >= 100 && val < 1000000000) {
                lineAmounts.push({ value: val, str: amtMatch[1], index: amtMatch.index });
            }
        }
    }

    if (lineAmounts.length < 1) return;

    const hasDR = /\bDR\b/i.test(cleanedLine) || /\bDr\b/.test(cleanedLine) || /debit/i.test(cleanedLine);
    const hasCR = /\bCR\b/i.test(cleanedLine) || /\bCr\b/.test(cleanedLine) || /credit/i.test(cleanedLine);
    const hasCredKw = creditKeywords.some(kw => cleanedLine.toUpperCase().includes(kw.toUpperCase()));
    const hasDebKw = debitKeywords.some(kw => cleanedLine.toUpperCase().includes(kw.toUpperCase()));

    let isCredit = false;
    let isDebit = false;
    let txnAmount = 0;

    if (hasDR && hasCR) {
        const drIdx = cleanedLine.search(/\bDR\b/i);
        const crIdx = cleanedLine.search(/\bCR\b/i);
        if (drIdx >= 0 && (crIdx < 0 || drIdx < crIdx)) isDebit = true;
        else isCredit = true;
    } else if (hasDR && !hasCR) {
        isDebit = true;
    } else if (hasCR && !hasDR) {
        isCredit = true;
    } else if (!hasDR && !hasCR) {
        if (lineAmounts.length >= 2) {
            const sortedAmts = [...lineAmounts].sort((a, b) => a.index - b.index);
            const firstIdx = sortedAmts[0].index;
            if (firstIdx >= 2 && cleanedLine.substring(firstIdx - 2, firstIdx) === '--') isDebit = true;
        }
        if (!isCredit && !isDebit) {
            if (hasCredKw && !hasDebKw) isCredit = true;
            else if (hasDebKw) isDebit = true;
        }
    }

    if (!isCredit && !isDebit && lineAmounts.length >= 3) {
        const sortedAmts = [...lineAmounts].sort((a, b) => a.index - b.index);
        const col1 = sortedAmts[sortedAmts.length - 3]?.value || 0;
        const col2 = sortedAmts[sortedAmts.length - 2]?.value || 0;
        const threshold = 0.01;
        if (col1 < threshold && col2 >= threshold) { isCredit = true; txnAmount = col2; }
        else if (col1 >= threshold && col2 < threshold) { isDebit = true; txnAmount = col1; }
        else if (col1 >= threshold && col2 >= threshold) {
            if (col1 > col2) { isDebit = true; txnAmount = col1; }
            else { isCredit = true; txnAmount = col2; }
        }
    }

    if (!isCredit && !isDebit) return;

    if (txnAmount === 0) {
        const drcrMatch = cleanedLine.match(/\b(DR|CR)\s+([\d,]+\.\d{2})/i);
        if (drcrMatch) txnAmount = parseFloat(drcrMatch[2].replace(/,/g, ''));
        if (txnAmount === 0) {
            if (lineAmounts.length === 1) txnAmount = lineAmounts[0].value;
            else if (lineAmounts.length === 2) txnAmount = lineAmounts[0].value;
            else txnAmount = lineAmounts[lineAmounts.length - 2].value;
        }
    }

    const particulars = cleanedLine.substring(0, 100).replace(/\s+/g, ' ').trim();
    const refMatch = cleanedLine.match(/(?:RVSL|NEFT|IMPS|RTGS|UPI|INF|CLG|ACH|CMS|MMT|CAM)[\/\w]*\d{6,}/i);
    const txnRef = refMatch ? refMatch[0].substring(0, 30) : particulars.substring(0, 60);
    const key = `${txnDate.dateStr}-${txnAmount}-${isCredit ? 'CR' : 'DR'}-${txnRef}`;

    if (txnAmount > 0) {
        if (isCredit && !seenCredits.has(key)) {
            seenCredits.add(key);
            if (!monthCreditsTotal[txnDate.monthKey]) monthCreditsTotal[txnDate.monthKey] = 0;
            monthCreditsTotal[txnDate.monthKey] += txnAmount;
        } else if (isDebit && !seenDebits.has(key)) {
            seenDebits.add(key);
            if (!monthDebitsTotal[txnDate.monthKey]) monthDebitsTotal[txnDate.monthKey] = 0;
            monthDebitsTotal[txnDate.monthKey] += txnAmount;

            if (!monthDebitTxns[txnDate.monthKey]) monthDebitTxns[txnDate.monthKey] = [];
            monthDebitTxns[txnDate.monthKey].push({ date: txnDate.dateStr, amount: txnAmount, particulars: particulars.substring(0, 60) });
        }
    }
});

console.log('\n=== MONTHLY DEBIT TOTALS (Parser Output) ===');
const expectedDebits = {
    '09-2025': 17796032.52,
    '10-2025': 8539932.58,
    '01-2026': 2377534.03
};

const allMonths = [...new Set([...Object.keys(monthDebitsTotal), ...Object.keys(monthCreditsTotal)])].sort();
allMonths.forEach(mk => {
    const debit = monthDebitsTotal[mk] || 0;
    const credit = monthCreditsTotal[mk] || 0;
    const expected = expectedDebits[mk];
    const diff = expected ? (debit - expected).toFixed(2) : '';
    const status = expected ? (Math.abs(debit - expected) < 1 ? 'OK' : `MISMATCH (diff: ${diff})`) : '';
    console.log(`${mk}: Debits=₹${debit.toLocaleString('en-IN', {minimumFractionDigits:2})}  Credits=₹${credit.toLocaleString('en-IN', {minimumFractionDigits:2})}  ${status}`);
});

// Show details for mismatched months
console.log('\n=== DEBIT TRANSACTION DETAILS FOR KEY MONTHS ===');
['09-2025', '10-2025', '01-2026'].forEach(mk => {
    const txns = monthDebitTxns[mk] || [];
    const total = monthDebitsTotal[mk] || 0;
    const expected = expectedDebits[mk];
    console.log(`\n--- ${mk}: ${txns.length} txns, Total: ₹${total.toLocaleString('en-IN', {minimumFractionDigits:2})} (Expected: ₹${expected?.toLocaleString('en-IN', {minimumFractionDigits:2})}) ---`);
    if (Math.abs(total - (expected || 0)) > 1) {
        txns.forEach((t, i) => console.log(`  ${i+1}. ${t.date} | ₹${t.amount.toLocaleString('en-IN', {minimumFractionDigits:2})} | ${t.particulars}`));
    }
});
