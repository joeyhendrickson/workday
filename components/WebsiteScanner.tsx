'use client';

import { useState, useEffect, useCallback } from 'react';

const MAX_DEPTH = 5;
const MAX_URLS = 200;
const MASTER_URLS_KEY = 'workday-scanner-master-urls';

interface Finding {
  html_context: string;
  primary_audience: string;
  task_category: string;
  reference_type: string;
  workday_feature: string;
  proposed_replacement: string;
  suggested_keywords: string[];
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

interface AnalyzedUrl {
  url: string;
  pageTitle: string;
  hasLegacyReferences: boolean;
  findings: Finding[];
}

interface ScannedUrl {
  url: string;
  depth: number;
  status: 'pending' | 'analyzed' | 'error';
  analysis?: AnalyzedUrl;
}

function normalizeUrlForCompare(url: string): string {
  try {
    const u = url.startsWith('http') ? url : `https://${url}`;
    const obj = new URL(u);
    obj.hash = '';
    return obj.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export default function WebsiteScanner() {
  const [baseUrl, setBaseUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [workStreamAreas, setWorkStreamAreas] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [scannedURLs, setScannedURLs] = useState<ScannedUrl[]>([]);
  const [masterUrlList, setMasterUrlList] = useState<ScannedUrl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    current: number;
    total: number;
    currentUrl: string;
  } | null>(null);
  const [uploadInputKey, setUploadInputKey] = useState(0);
  const [pastedUrls, setPastedUrls] = useState('');

  const loadMasterFromStorage = useCallback(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(MASTER_URLS_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Array<{ url: string; depth: number }>;
        const list: ScannedUrl[] = (parsed || []).map((u) => ({
          url: normalizeUrlForCompare(u.url),
          depth: typeof u.depth === 'number' ? u.depth : 0,
          status: 'pending' as const,
        }));
        setMasterUrlList(list);
        setScannedURLs(list);
        return list;
      }
    } catch (_) {}
    setMasterUrlList([]);
    return [];
  }, []);

  useEffect(() => {
    loadMasterFromStorage();
  }, [loadMasterFromStorage]);

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const mergeUrlLists = (existing: ScannedUrl[], incoming: ScannedUrl[]): ScannedUrl[] => {
    const byUrl = new Map<string, ScannedUrl>();
    for (const s of existing) byUrl.set(normalizeUrlForCompare(s.url), s);
    for (const s of incoming) byUrl.set(normalizeUrlForCompare(s.url), s);
    return Array.from(byUrl.values());
  };

  const handleScan = async () => {
    if (!baseUrl.trim()) {
      setError('Please enter a starting website URL');
      return;
    }
    const urlToScan = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
    if (!validateUrl(urlToScan)) {
      setError('Please enter a valid URL (e.g., example.edu or https://example.edu)');
      return;
    }

    setIsScanning(true);
    setError(null);
    setScanProgress({ current: 0, total: 0, currentUrl: 'Starting scan...' });

    const currentMaster = masterUrlList.length > 0 ? masterUrlList : loadMasterFromStorage();
    const excludeUrls = currentMaster.map((u) => u.url);

    try {
      const keywordList = keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
      const workStreamList = workStreamAreas.split(/[,;]/).map((w) => w.trim()).filter(Boolean);

      const response = await fetch('/api/website/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlToScan,
          maxUrls: MAX_URLS,
          maxDepth: MAX_DEPTH,
          keywords: keywordList,
          workStreamAreas: workStreamList,
          excludeUrls,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to scan website');
      }

      const data = await response.json();
      if (data.success && data.urls) {
        const newEntries: ScannedUrl[] = data.urls.map((u: { url: string; depth: number }) => ({
          url: u.url,
          depth: u.depth,
          status: 'pending' as const,
        }));
        const merged = mergeUrlLists(currentMaster, newEntries);
        setScannedURLs(merged);
        setMasterUrlList(merged);
      } else {
        throw new Error(data.error || 'Failed to scan website');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to scan website');
    } finally {
      setIsScanning(false);
      setScanProgress(null);
    }
  };

  const handleSaveUrls = () => {
    if (scannedURLs.length === 0) {
      setError('No URLs to save. Run a scan or load URLs first.');
      return;
    }
    const toSave = scannedURLs.map((s) => ({ url: s.url, depth: s.depth }));
    try {
      localStorage.setItem(MASTER_URLS_KEY, JSON.stringify(toSave));
      setMasterUrlList(scannedURLs);
    } catch (_) {
      setError('Could not save to browser storage.');
      return;
    }
    const blob = new Blob([toSave.map((u) => u.url).join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `workday-scanner-urls-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    setError(null);
  };

  const handleLoadUrls = (file: File | null, pastedText?: string) => {
    const parse = (text: string): ScannedUrl[] => {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const urls: ScannedUrl[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          urls.push({ url: normalizeUrlForCompare(trimmed), depth: 0, status: 'pending' });
        }
      }
      try {
        const asJson = JSON.parse(text);
        if (Array.isArray(asJson)) {
          for (const item of asJson) {
            const url = typeof item === 'string' ? item : item?.url;
            if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
              urls.push({
                url: normalizeUrlForCompare(url),
                depth: typeof item?.depth === 'number' ? item.depth : 0,
                status: 'pending',
              });
            }
          }
          return urls;
        }
      } catch (_) {}
      return urls;
    };

    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = (reader.result as string) || '';
        const parsed = parse(text);
        if (parsed.length === 0) {
          setError('No valid URLs found in the file.');
          return;
        }
        setScannedURLs((prev) => mergeUrlLists(prev, parsed));
        setMasterUrlList((prev) => mergeUrlLists(prev, parsed));
        setError(null);
        setUploadInputKey((k) => k + 1);
      };
      reader.readAsText(file);
    } else if (pastedText?.trim()) {
      const parsed = parse(pastedText);
      if (parsed.length === 0) {
        setError('No valid URLs found in the pasted text.');
        return;
      }
      setScannedURLs((prev) => mergeUrlLists(prev, parsed));
      setMasterUrlList((prev) => mergeUrlLists(prev, parsed));
      setError(null);
    }
  };

  const handleAnalyze = async () => {
    if (scannedURLs.length === 0) {
      setError('Please run a scan or load URLs first.');
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    const keywordList = keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
    const workStreamList = workStreamAreas.split(/[,;]/).map((w) => w.trim()).filter(Boolean);
    const urlList = scannedURLs.map((s) => s.url);

    try {
      const response = await fetch('/api/website/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: urlList,
          keywords: keywordList,
          workStreamAreas: workStreamList,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Analysis failed');
      }

      const data = await response.json();
      if (!data.success || !data.results) throw new Error('Invalid analysis response');

      setScannedURLs((prev) =>
        prev.map((scanned) => {
          const result = data.results.find((r: { url: string }) => r.url === scanned.url);
          if (result) {
            return {
              ...scanned,
              status: 'analyzed' as const,
              analysis: {
                url: result.url,
                pageTitle: result.pageTitle,
                hasLegacyReferences: result.hasLegacyReferences,
                findings: result.findings || [],
              },
            };
          }
          return scanned;
        })
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const urlsWithFindings = scannedURLs.filter(
    (s) => s.analysis?.hasLegacyReferences && (s.analysis.findings?.length ?? 0) > 0
  );

  const reportData = () => ({
    generatedAt: new Date().toISOString(),
    startUrl: baseUrl,
    keywords: keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean),
    workStreamAreas: workStreamAreas.split(/[,;]/).map((w) => w.trim()).filter(Boolean),
    totalUrlsScanned: scannedURLs.length,
    urlsWithLegacyReferences: urlsWithFindings.length,
    urlList: scannedURLs.map((s) => ({ url: s.url, depth: s.depth })),
    recommendedUpdates: urlsWithFindings.map((s) => ({
      url: s.url,
      pageTitle: s.analysis?.pageTitle,
      findings: s.analysis?.findings?.map((f) => ({
        current: f.html_context,
        proposed: f.proposed_replacement,
        audience: f.primary_audience,
        taskCategory: f.task_category,
        workdayFeature: f.workday_feature,
        suggestedKeywords: f.suggested_keywords,
        confidence: f.confidence,
        notes: f.notes,
      })),
    })),
  });

  const exportReport = () => {
    const report = reportData();
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `workday-scanner-report-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const exportReportAsWord = async () => {
    const report = reportData();
    const date = new Date().toISOString().slice(0, 10);
    try {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
      const children: Paragraph[] = [
        new Paragraph({
          text: 'Workday Website Scanner Report',
          heading: HeadingLevel.TITLE,
          spacing: { after: 200 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Generated: ', bold: true }),
            new TextRun(report.generatedAt),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Start URL: ', bold: true }),
            new TextRun(report.startUrl || '—'),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Keywords: ', bold: true }),
            new TextRun((report.keywords as string[]).length ? (report.keywords as string[]).join(', ') : '—'),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Work stream areas: ', bold: true }),
            new TextRun((report.workStreamAreas as string[]).length ? (report.workStreamAreas as string[]).join(', ') : '—'),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Summary: ', bold: true }),
            new TextRun(` ${report.totalUrlsScanned} URL(s) scanned, ${report.urlsWithLegacyReferences} with CougarWeb/Colleague references.`),
          ],
          spacing: { after: 200 },
        }),
        new Paragraph({ text: 'Full URL list', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 120 } }),
      ];
      for (const item of report.urlList as Array<{ url: string; depth: number }>) {
        children.push(new Paragraph({ text: `• ${item.url} (depth ${item.depth})`, spacing: { after: 60 } }));
      }
      children.push(new Paragraph({ text: 'Recommended updates', heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } }));
      for (const rec of report.recommendedUpdates as Array<{
        url: string;
        pageTitle?: string;
        findings?: Array<{ current: string; proposed: string; audience: string; taskCategory: string; workdayFeature: string; suggestedKeywords: string[]; confidence: string; notes?: string }>;
      }>) {
        children.push(new Paragraph({ children: [new TextRun({ text: rec.url, bold: true })], spacing: { before: 200, after: 60 } }));
        if (rec.pageTitle) {
          children.push(new Paragraph({ text: `Page: ${rec.pageTitle}`, spacing: { after: 60 } }));
        }
        if (rec.findings?.length) {
          for (let i = 0; i < rec.findings.length; i++) {
            const f = rec.findings[i];
            children.push(new Paragraph({ text: `Finding ${i + 1}`, heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 60 } }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Audience: ', bold: true }), new TextRun(f.audience)] }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Task: ', bold: true }), new TextRun(f.taskCategory)] }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Workday feature: ', bold: true }), new TextRun(f.workdayFeature)] }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Confidence: ', bold: true }), new TextRun(f.confidence)] }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Current copy: ', bold: true }), new TextRun(f.current)] }));
            children.push(new Paragraph({ children: [new TextRun({ text: 'Proposed Workday copy: ', bold: true }), new TextRun(f.proposed)] }));
            if (f.suggestedKeywords?.length) {
              children.push(new Paragraph({ children: [new TextRun({ text: 'Suggested keywords: ', bold: true }), new TextRun(f.suggestedKeywords.join(', '))] }));
            }
            if (f.notes) {
              children.push(new Paragraph({ children: [new TextRun({ text: 'Notes: ', bold: true }), new TextRun(f.notes)] }));
            }
          }
        }
      }
      const doc = new Document({
        sections: [{ properties: {}, children }],
      });
      const blob = await Packer.toBlob(doc);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `workday-scanner-report-${date}.docx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('Word export failed:', err);
      setError('Could not generate Word document. Try exporting as JSON instead.');
    }
  };

  const getConfidenceColor = (c: string) => {
    switch (c) {
      case 'high': return 'bg-green-100 text-green-800 border-green-300';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Website Scanner</h2>
        <p className="text-gray-600">
          Enter a starting URL and optional keywords/work stream areas. The scanner will crawl up to {MAX_DEPTH} layers deep to find pages that mention CougarWeb or Colleague, then analyze them for Workday-based messaging updates.
        </p>
      </div>

      {/* Keywords */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
        <label className="block text-sm font-semibold text-gray-700 mb-2">Keywords to look for</label>
        <input
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="e.g. CougarWeb, Colleague (optional — scanner always looks for these)"
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
        />
        <p className="text-xs text-gray-500 mt-1">Hint: The scanner always searches for &quot;CougarWeb&quot; and &quot;Colleague&quot; (in a system context). Add more terms if needed.</p>
      </div>

      {/* Work stream areas */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
        <label className="block text-sm font-semibold text-gray-700 mb-2">Work stream areas (optional)</label>
        <input
          type="text"
          value={workStreamAreas}
          onChange={(e) => setWorkStreamAreas(e.target.value)}
          placeholder="e.g. Registration, Financial Aid, HR, Payroll (comma- or semicolon-separated)"
          className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black focus:border-transparent"
        />
        <p className="text-xs text-gray-500 mt-1">Work stream areas from the college to consider when classifying and recommending updates.</p>
      </div>

      {/* Starting URL + Scan */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-6">
        <label className="block text-sm font-semibold text-gray-700 mb-3">Starting URL</label>
        <p className="text-xs text-gray-500 mb-2">
          New scans exclude URLs already in your saved list so you can pick up where you left off.
        </p>
        <div className="flex gap-3">
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://example.edu or example.edu"
            className="flex-1 px-4 py-3 border-2 border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent"
            onKeyDown={(e) => e.key === 'Enter' && !isScanning && handleScan()}
          />
          <button
            type="button"
            onClick={handleScan}
            disabled={isScanning || !baseUrl.trim()}
            className="px-8 py-3 bg-black text-white rounded-xl font-semibold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isScanning ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Scanning…</span>
              </>
            ) : (
              <span>Scan ({MAX_DEPTH} layers)</span>
            )}
          </button>
        </div>
      </div>

      {/* Load / Upload URLs */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-6">
        <label className="block text-sm font-semibold text-gray-700 mb-2">Load URLs</label>
        <p className="text-xs text-gray-500 mb-3">
          Upload a .txt file (one URL per line) or .json array of URLs to add to your list and run analysis.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <input
            key={uploadInputKey}
            type="file"
            accept=".txt,.json,text/plain,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleLoadUrls(file);
            }}
            className="block w-full max-w-xs text-sm text-gray-600 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-black file:text-white file:font-semibold"
          />
          <div className="flex-1 min-w-[200px] flex gap-2">
            <textarea
              value={pastedUrls}
              onChange={(e) => setPastedUrls(e.target.value)}
              placeholder="Paste URLs (one per line) then click Add"
              rows={2}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-transparent"
            />
            <button
              type="button"
              onClick={() => {
                if (pastedUrls.trim()) {
                  handleLoadUrls(null, pastedUrls);
                  setPastedUrls('');
                }
              }}
              className="px-4 py-2 bg-black text-white rounded-lg font-semibold hover:bg-gray-800 shrink-0"
            >
              Add these URLs
            </button>
          </div>
        </div>
      </div>

      {scanProgress && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-blue-800 truncate mr-2">{scanProgress.currentUrl}</span>
            <span className="text-sm text-blue-600 shrink-0">{scanProgress.current} / {scanProgress.total}</span>
          </div>
          {scanProgress.total > 0 && (
            <div className="w-full bg-blue-200 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all"
                style={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {scannedURLs.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 bg-white border-2 border-gray-200 rounded-xl p-4">
            <div>
              <p className="font-semibold text-gray-700">{scannedURLs.length} URL(s) in list</p>
              <p className="text-sm text-gray-500">
                {scannedURLs.filter((s) => s.status === 'analyzed').length} analyzed · {urlsWithFindings.length} with CougarWeb/Colleague references
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleSaveUrls}
                className="px-6 py-2 bg-gray-700 text-white rounded-lg font-semibold hover:bg-gray-800"
              >
                Save URLs
              </button>
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={isAnalyzing || scannedURLs.length === 0}
                className="px-6 py-2 bg-black text-white rounded-lg font-semibold hover:bg-gray-800 disabled:opacity-50"
              >
                {isAnalyzing ? 'Analyzing…' : 'Analyze for Workday updates'}
              </button>
              {urlsWithFindings.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={exportReport}
                    className="px-6 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                  >
                    Export report (JSON)
                  </button>
                  <button
                    type="button"
                    onClick={exportReportAsWord}
                    className="px-6 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700"
                  >
                    Export report (Word)
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-xl font-bold text-gray-800">URL list &amp; recommended updates</h3>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto">
              {scannedURLs.map((scanned, idx) => (
                <div key={scanned.url + idx} className="bg-white border-2 border-gray-200 rounded-xl p-6">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <a
                      href={scanned.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 font-medium break-all"
                    >
                      {scanned.url}
                    </a>
                    <span className="text-xs text-gray-500 shrink-0">Depth {scanned.depth}</span>
                  </div>
                  {scanned.analysis?.pageTitle && (
                    <p className="text-sm text-gray-600 mb-3">Page: {scanned.analysis.pageTitle}</p>
                  )}
                  {scanned.status === 'analyzed' && !scanned.analysis?.hasLegacyReferences && (
                    <p className="text-sm text-gray-500 italic">No CougarWeb/Colleague references found on this page.</p>
                  )}
                  {scanned.analysis?.findings?.map((f, fidx) => (
                    <div key={fidx} className="mt-4 p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <span className={`px-2 py-1 rounded text-xs font-semibold border ${getConfidenceColor(f.confidence)}`}>
                          {f.confidence} confidence
                        </span>
                        <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-800">{f.primary_audience}</span>
                        <span className="px-2 py-1 rounded text-xs bg-purple-100 text-purple-800">{f.task_category}</span>
                        <span className="px-2 py-1 rounded text-xs bg-gray-200 text-gray-800">{f.workday_feature}</span>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">Current copy</p>
                        <p className="text-sm text-gray-800 bg-red-50 p-2 rounded border border-red-100 line-through">{f.html_context}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">Proposed Workday copy</p>
                        <p className="text-sm text-gray-800 bg-green-50 p-2 rounded border border-green-200">{f.proposed_replacement}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-gray-600 mb-1">Suggested keywords</p>
                        <div className="flex flex-wrap gap-1">
                          {f.suggested_keywords.map((kw, kidx) => (
                            <span key={kidx} className="px-2 py-0.5 bg-white border border-gray-300 rounded text-xs">{kw}</span>
                          ))}
                        </div>
                      </div>
                      {f.notes && (
                        <p className="text-xs text-gray-500 italic">Note: {f.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {error && (
        <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 text-red-800 font-medium">
          {error}
        </div>
      )}
    </div>
  );
}
