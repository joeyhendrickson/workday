'use client';

import { useState } from 'react';

const MAX_DEPTH = 5;
const MAX_URLS = 200;

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

export default function WebsiteScanner() {
  const [baseUrl, setBaseUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [workStreamAreas, setWorkStreamAreas] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [scannedURLs, setScannedURLs] = useState<ScannedUrl[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    current: number;
    total: number;
    currentUrl: string;
  } | null>(null);

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
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
    setScannedURLs([]);
    setScanProgress({ current: 0, total: 0, currentUrl: 'Starting scan...' });

    try {
      const keywordList = keywords
        .split(/[,;]/)
        .map((k) => k.trim())
        .filter(Boolean);
      const workStreamList = workStreamAreas
        .split(/[,;]/)
        .map((w) => w.trim())
        .filter(Boolean);

      const response = await fetch('/api/website/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlToScan,
          maxUrls: MAX_URLS,
          maxDepth: MAX_DEPTH,
          keywords: keywordList,
          workStreamAreas: workStreamList,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to scan website');
      }

      const data = await response.json();
      if (data.success && data.urls) {
        const urls: ScannedUrl[] = data.urls.map((u: { url: string; depth: number }) => ({
          url: u.url,
          depth: u.depth,
          status: 'pending' as const,
        }));
        setScannedURLs(urls);
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

  const handleAnalyze = async () => {
    if (scannedURLs.length === 0) {
      setError('Please run a scan first');
      return;
    }

    setIsAnalyzing(true);
    setError(null);

    const keywordList = keywords.split(/[,;]/).map((k) => k.trim()).filter(Boolean);
    const workStreamList = workStreamAreas.split(/[,;]/).map((w) => w.trim()).filter(Boolean);

    try {
      const response = await fetch('/api/website/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: scannedURLs.map((s) => s.url),
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

  const exportReport = () => {
    const report = {
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
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `workday-scanner-report-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
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

      {/* Starting URL */}
      <div className="bg-white border-2 border-gray-200 rounded-xl p-6">
        <label className="block text-sm font-semibold text-gray-700 mb-3">Starting URL</label>
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
              <>
                <span>Scan ({MAX_DEPTH} layers)</span>
              </>
            )}
          </button>
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
              <p className="font-semibold text-gray-700">{scannedURLs.length} URL(s) found (up to {MAX_DEPTH} layers)</p>
              <p className="text-sm text-gray-500">
                {scannedURLs.filter((s) => s.status === 'analyzed').length} analyzed · {urlsWithFindings.length} with CougarWeb/Colleague references
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={isAnalyzing || scannedURLs.length === 0}
                className="px-6 py-2 bg-black text-white rounded-lg font-semibold hover:bg-gray-800 disabled:opacity-50"
              >
                {isAnalyzing ? 'Analyzing…' : 'Analyze for Workday updates'}
              </button>
              {urlsWithFindings.length > 0 && (
                <button
                  type="button"
                  onClick={exportReport}
                  className="px-6 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700"
                >
                  Export report
                </button>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-xl font-bold text-gray-800">Scanned URLs &amp; recommended updates</h3>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto">
              {scannedURLs.map((scanned, idx) => (
                <div key={idx} className="bg-white border-2 border-gray-200 rounded-xl p-6">
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
