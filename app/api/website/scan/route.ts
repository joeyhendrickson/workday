import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

export const maxDuration = 300; // 5 minutes

interface URLData {
  url: string;
  depth: number;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ADA Compliance Scanner)',
      },
      maxRedirects: 5,
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

function extractLinks(html: string, baseUrl: string, currentDepth: number, maxDepth: number): string[] {
  const links: string[] = [];
  const baseUrlObj = new URL(baseUrl);
  const baseDomain = baseUrlObj.hostname;

  // Extract href attributes from anchor tags
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    let link = match[1];

    // Skip javascript:, mailto:, tel:, etc.
    if (link.startsWith('javascript:') || link.startsWith('mailto:') || link.startsWith('tel:') || link.startsWith('#')) {
      continue;
    }

    try {
      // Convert relative URLs to absolute
      if (link.startsWith('/')) {
        link = `${baseUrlObj.protocol}//${baseUrlObj.hostname}${link}`;
      } else if (!link.startsWith('http')) {
        link = new URL(link, baseUrl).href;
      }

      const linkUrl = new URL(link);

      // Only include links from the same domain
      if (linkUrl.hostname === baseDomain || linkUrl.hostname.endsWith(`.${baseDomain}`)) {
        // Normalize URL (remove fragments, trailing slashes)
        linkUrl.hash = '';
        const normalizedUrl = linkUrl.href.replace(/\/$/, '');
        
        if (!links.includes(normalizedUrl)) {
          links.push(normalizedUrl);
        }
      }
    } catch (e) {
      // Invalid URL, skip
      continue;
    }
  }

  return links;
}

function normalizeUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    urlObj.hash = '';
    return urlObj.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function crawlWebsite(
  startUrl: string,
  maxUrls: number,
  maxDepth: number,
  excludeUrls: string[] = []
): Promise<URLData[]> {
  const visited = new Set<string>();
  const urls: URLData[] = [];
  const excludeSet = new Set<string>();
  for (const u of excludeUrls) {
    const n = normalizeUrl(u.startsWith('http') ? u : `https://${u}`);
    if (n) excludeSet.add(n);
  }

  const startNormalized = normalizeUrl(startUrl.startsWith('http') ? startUrl : `https://${startUrl}`);
  if (!startNormalized) return [];
  const queue: Array<{ url: string; depth: number }> = [{ url: startNormalized, depth: 0 }];

  while (queue.length > 0 && urls.length < maxUrls) {
    const { url, depth } = queue.shift()!;

    let normalizedUrl: string | null;
    try {
      const urlObj = new URL(url);
      urlObj.hash = '';
      normalizedUrl = urlObj.href.replace(/\/$/, '');
    } catch {
      continue;
    }
    if (!normalizedUrl) continue;

    if (visited.has(normalizedUrl) || depth > maxDepth || excludeSet.has(normalizedUrl)) {
      continue;
    }

    visited.add(normalizedUrl);
    urls.push({ url: normalizedUrl, depth });

    if (depth < maxDepth && urls.length < maxUrls) {
      const html = await fetchPage(normalizedUrl);
      if (html) {
        const links = extractLinks(html, normalizedUrl, depth, maxDepth);
        for (const link of links) {
          const norm = normalizeUrl(link);
          if (norm && !visited.has(norm) && !excludeSet.has(norm) && urls.length < maxUrls) {
            queue.push({ url: norm, depth: depth + 1 });
          }
        }
      }
    }
  }

  return urls;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, maxUrls = 200, maxDepth = 5, keywords, workStreamAreas, excludeUrls = [] } = body;

    if (!url) {
      return NextResponse.json(
        { success: false, error: 'URL is required' },
        { status: 400 }
      );
    }

    // Validate URL
    let validatedUrl: string;
    try {
      validatedUrl = url.startsWith('http') ? url : `https://${url}`;
      new URL(validatedUrl);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid URL format' },
        { status: 400 }
      );
    }

    if (maxUrls > 300) {
      return NextResponse.json(
        { success: false, error: 'Maximum 300 URLs allowed' },
        { status: 400 }
      );
    }

    if (maxDepth > 5) {
      return NextResponse.json(
        { success: false, error: 'Maximum depth is 5 layers' },
        { status: 400 }
      );
    }

    const excludeList = Array.isArray(excludeUrls) ? excludeUrls : [];
    const urls = await crawlWebsite(validatedUrl, maxUrls, maxDepth, excludeList);

    return NextResponse.json({
      success: true,
      urls,
      count: urls.length,
      keywords: keywords || [],
      workStreamAreas: workStreamAreas || [],
    });
  } catch (error) {
    console.error('Website scan error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to scan website',
      },
      { status: 500 }
    );
  }
}
