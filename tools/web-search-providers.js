'use strict';

// Bootstrap global-agent for proxy support (reads HTTP_PROXY/HTTPS_PROXY)
try { require('global-agent').bootstrap(); } catch (e) {}

const http = require('http');
const https = require('https');
const { API_ROUTES } = require('../config/api-keys');

// ✅ 优先使用 Qwen 联网搜索（dev key 已配置），其次是免费/已配置的提供商
const DEFAULT_PROVIDERS = ['baidu', 'duckduckgo', 'gdelt'];

function searchWeb(query, options) {
  options = options || {};
  var maxResults = options.maxResults || 5;
  var providers = normalizeProviders(options.providers || process.env.WEB_SEARCH_PROVIDERS);
  return tryProviders(providers, query, maxResults, options).then(function(result) {
    if (result && result.results && result.results.length > 0) return result;
    return { query: query, results: [], provider: 'none', source: 'web', errors: result && result.errors || [] };
  });
}

function normalizeProviders(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(function(p) { return p.trim().toLowerCase(); }).filter(Boolean);
  }
  return DEFAULT_PROVIDERS.slice();
}

function tryProviders(providers, query, maxResults, options) {
  var errors = [];
  var i = 0;

  function next() {
    if (i >= providers.length) return Promise.resolve({ query: query, results: [], errors: errors });
    var provider = providers[i++];
    var fn = PROVIDERS[provider];
    if (!fn) {
      errors.push(provider + ': unknown provider');
      return next();
    }
    return fn(query, maxResults, options).then(function(result) {
      var normalized = normalizeSearchResult(query, provider, result, maxResults);
      if (normalized.results.length > 0) return normalized;
      errors.push(provider + ': empty');
      return next();
    }).catch(function(err) {
      errors.push(provider + ': ' + (err && err.message || String(err)));
      return next();
    });
  }

  return next().then(function(result) {
    if (errors.length > 0 && result) result.errors = errors;
    return result;
  });
}

function normalizeSearchResult(query, provider, result, maxResults) {
  var rows = Array.isArray(result) ? result : (result && result.results || []);
  var seen = {};
  var normalized = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var url = clean(r.url || r.link || r.href);
    var title = clean(r.title || r.name || r.heading);
    var snippet = clean(r.snippet || r.content || r.text || r.description || r.summary);
    if (!title && !snippet) continue;
    var key = (url || title).toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    normalized.push({
      title: title || url || query,
      snippet: snippet || '',
      url: url || '',
      provider: r.provider || provider,
      source: 'web',
      publishedAt: r.publishedAt || r.age || r.date || null,
    });
    if (normalized.length >= maxResults) break;
  }
  return { query: query, provider: provider, source: 'web', results: normalized };
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

const PROVIDERS = {
  baidu: searchBaidu,
  duckduckgo: searchDuckDuckGo,
  gdelt: searchGdelt,
};

// ── Baidu Search (free, no API key, works in China) ────────────────────────
function searchBaidu(query, maxResults) {
  var url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query) + '&rn=' + encodeURIComponent(Math.min(maxResults + 5, 20));
  return new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve([]); }, 12000);
    try {
      fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(10000),
      }).then(function(resp) {
        if (resp.status !== 200) { clearTimeout(timer); resolve([]); return; }
        return resp.text();
      }).then(function(html) {
        clearTimeout(timer);
        if (!html) { resolve([]); return; }
        var results = [];
        try {
          var cheerio = require('cheerio');
          var $ = cheerio.load(html);
          // Primary: .result container (Baidu's standard search result block)
          $('.result').each(function(i, el) {
            if (results.length >= maxResults) return false;
            var $h3 = $(el).find('h3 a, h3.t a').first();
            var title = $h3.text().replace(/\s+/g, ' ').trim();
            var url = $h3.attr('href') || '';
            // Try to extract real URL from Baidu redirect
            var dataUrl = $(el).find('[data-url]').attr('data-url') || '';
            if (dataUrl) url = dataUrl;
            var snippet = (
              $(el).find('.c-abstract').first().text() ||
              $(el).find('.c-span-last').first().text() ||
              $(el).find('.c-font-normal').first().text() ||
              $(el).find('[class*=\"content\"]').first().text() || ''
            ).replace(/\s+/g, ' ').trim();
            var source = $(el).find('.c-showurl, .c-color-gray').first().text().replace(/\s+/g, ' ').trim();
            if (title && url) {
              results.push({ title: title, url: url.substring(0, 500), snippet: snippet.substring(0, 400), source: source, provider: 'baidu' });
            }
          });
          // Fallback: #content_left > div
          if (results.length === 0) {
            $('#content_left > div, #results > div').each(function(i, el) {
              if (results.length >= maxResults) return false;
              var $a = $(el).find('a').first();
              var title = $a.text().replace(/\s+/g, ' ').trim();
              var url = $a.attr('href') || '';
              if (title && url && url.indexOf('javascript:') !== 0) {
                results.push({ title: title, url: url, snippet: '', source: '', provider: 'baidu' });
              }
            });
          }
        } catch(e) { /* parse error, return empty */ }
        resolve(results);
      }).catch(function() { clearTimeout(timer); resolve([]); });
    } catch(e) { clearTimeout(timer); resolve([]); }
  });
}

function searchBing(query, maxResults) {
  // Bing CN — free, no API key, works reliably through proxy in China
  var path = '/search?q=' + encodeURIComponent(query) + '&count=' + encodeURIComponent(Math.min(maxResults, 10)) +
    '&setlang=zh-Hans&mkt=zh-CN';
  var opts = {
    hostname: 'cn.bing.com',
    path: path,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
  return new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve([]); }, 12000);
    var req = https.get(opts, function(resp) {
      if (resp.statusCode !== 200) { clearTimeout(timer); resolve([]); return; }
      var data = '';
      resp.on('data', function(c) { data += c.toString(); if (data.length > 100000) resp.destroy(); });
      resp.on('end', function() {
        clearTimeout(timer);
        var results = [];
        // Parse Bing HTML: <li class=\"b_algo\">
        var blocks = data.split(/<li[^>]*class=\"[^\"]*b_algo[^\"]*\"/i);
        for (var i = 1; i < Math.min(blocks.length, maxResults + 2); i++) {
          var b = blocks[i];
          var h2 = b.match(/<h2[^>]*><a[^>]*href=\"([^\"]*)\"[^>]*>([\s\S]*?)<\/a><\/h2>/i) || [];
          var snippet = '';
          var pm = b.match(/<p[^>]*class=\"[^\"]*b_lineclamp[^\"]*\"[^>]*>([\s\S]*?)<\/p>/i) || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [];
          snippet = decodeHtmlEntities((pm[1] || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
          if (h2[1]) {
            results.push({
              title: decodeHtmlEntities(h2[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(),
              url: h2[1],
              snippet: snippet.substring(0, 300),
              provider: 'bing',
            });
          }
        }
        resolve(results);
      });
    });
    req.on('error', function() { clearTimeout(timer); resolve([]); });
  });
}

function searchDuckDuckGo(query, maxResults) {
  // DuckDuckGo Instant Answer API — free, no API key needed
  var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) +
    '&format=json&no_html=1&skip_disambig=1&t=ai-harbor';
  return requestJson('GET', url).then(function(json) {
    var results = [];
    // Extract from RelatedTopics
    var topics = json.RelatedTopics || [];
    for (var i = 0; i < topics.length; i++) {
      var t = topics[i];
      if (!t.Text || !t.FirstURL) continue;
      // Split "title — snippet" format
      var parts = t.Text.split(' - ');
      var title = parts[0] || '';
      var snippet = parts.slice(1).join(' - ') || t.Text;
      results.push({
        title: title.trim(),
        url: t.FirstURL,
        snippet: snippet.trim(),
        provider: 'duckduckgo',
      });
    }
    // Also check Abstract (main result)
    if (json.Abstract && json.AbstractURL) {
      results.unshift({
        title: json.Heading || query,
        url: json.AbstractURL,
        snippet: json.Abstract,
        provider: 'duckduckgo',
      });
    }
    return results;
  }).catch(function() { return []; });
}

function searchGdelt(query, maxResults) {
  var url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(query) +
    '&mode=ArtList&format=json&maxrecords=' + encodeURIComponent(Math.min(Math.max(maxResults * 3, 10), 50)) +
    '&sort=HybridRel';
  return requestJson('GET', url).catch(function(err) {
    if (String(err && err.message || '').indexOf('HTTP 429') >= 0) {
      return delay(6000).then(function() { return requestJson('GET', url); });
    }
    throw err;
  }).then(function(json) {
    return (json.articles || []).map(function(r) {
      return {
        title: r.title,
        url: r.url,
        snippet: [r.domain, r.sourcecountry, r.language].filter(Boolean).join(' | '),
        publishedAt: r.seendate,
        provider: 'gdelt',
      };
    });
  });
}

function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function searchSearxng(query, maxResults) {
  var base = process.env.SEARXNG_URL || process.env.SEARXNG_BASE_URL;
  if (!base) return Promise.resolve([]);
  var sep = base.indexOf('?') >= 0 ? '&' : '?';
  var url = base.replace(/\/$/, '') + '/search' + sep + 'q=' + encodeURIComponent(query) + '&format=json&language=zh-CN';
  return requestJson('GET', url).then(function(json) {
    return (json.results || []).map(function(r) {
      return { title: r.title, url: r.url, snippet: r.content || r.snippet, provider: 'searxng' };
    });
  });
}

function searchBrave(query, maxResults) {
  var key = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (!key) return Promise.resolve([]);
  var url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + encodeURIComponent(maxResults);
  return requestJson('GET', url, null, {
    'Accept': 'application/json',
    'X-Subscription-Token': key,
  }).then(function(json) {
    var rows = json.web && json.web.results || [];
    return rows.map(function(r) {
      return { title: r.title, url: r.url, snippet: r.description || r.extra_snippets && r.extra_snippets.join(' '), provider: 'brave' };
    });
  });
}

function searchJina(query, maxResults) {
  var headers = { 'Accept': 'application/json' };
  if (process.env.JINA_API_KEY) headers.Authorization = 'Bearer ' + process.env.JINA_API_KEY;
  var url = 'https://s.jina.ai/?q=' + encodeURIComponent(query);
  return requestJson('GET', url, null, headers).then(function(json) {
    var rows = Array.isArray(json.data) ? json.data : (Array.isArray(json.results) ? json.results : []);
    return rows.map(function(r) {
      return { title: r.title, url: r.url, snippet: r.content || r.description || r.text, provider: 'jina' };
    });
  }).catch(function() {
    return requestText('GET', 'https://s.jina.ai/' + encodeURIComponent(query), null, headers).then(function(text) {
      return parseJinaText(text).slice(0, maxResults);
    });
  });
}

function parseJinaText(text) {
  var rows = [];
  var blocks = String(text || '').split(/\n(?=Title:|\d+\.\s+)/);
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var title = matchLine(block, /Title:\s*(.+)/i) || matchLine(block, /^\d+\.\s*(.+)/m);
    var url = matchLine(block, /URL Source:\s*(.+)/i) || matchLine(block, /URL:\s*(.+)/i);
    var snippet = block.replace(/Title:.*|URL Source:.*|URL:.*/gi, '').trim().slice(0, 500);
    if (title || url || snippet) rows.push({ title: title, url: url, snippet: snippet, provider: 'jina' });
  }
  return rows;
}

function matchLine(text, regex) {
  var m = String(text || '').match(regex);
  return m ? m[1].trim() : '';
}

function searchTavily(query, maxResults) {
  var key = process.env.TAVILY_API_KEY;
  if (!key) return Promise.resolve([]);
  return requestJson('POST', 'https://api.tavily.com/search', {
    api_key: key,
    query: query,
    search_depth: 'basic',
    max_results: maxResults,
    include_answer: false,
  }).then(function(json) {
    return (json.results || []).map(function(r) {
      return { title: r.title, url: r.url, snippet: r.content || r.snippet, provider: 'tavily' };
    });
  });
}

function searchExa(query, maxResults) {
  var key = process.env.EXA_API_KEY;
  if (!key) return Promise.resolve([]);
  return requestJson('POST', 'https://api.exa.ai/search', {
    query: query,
    numResults: maxResults,
    type: 'auto',
    contents: { text: { maxCharacters: 600 } },
  }, {
    'x-api-key': key,
  }).then(function(json) {
    return (json.results || []).map(function(r) {
      return { title: r.title, url: r.url, snippet: r.text || r.highlight || r.summary, provider: 'exa' };
    });
  });
}

function searchSerper(query, maxResults) {
  var key = process.env.SERPER_API_KEY;
  if (!key) return Promise.resolve([]);
  return requestJson('POST', 'https://google.serper.dev/search', {
    q: query,
    num: maxResults,
  }, {
    'X-API-KEY': key,
  }).then(function(json) {
    return (json.organic || []).map(function(r) {
      return { title: r.title, url: r.link, snippet: r.snippet, provider: 'serper' };
    });
  });
}

function searchLlmAssist(query, maxResults) {
  var route = API_ROUTES && API_ROUTES['qwen-plus'];
  var apiKey = process.env.QWEN_KEY || (route && route.getKey && route.getKey());
  if (!apiKey) return Promise.resolve([]);
  var body = {
    model: 'qwen-plus',
    input: {
      messages: [
        { role: 'system', content: '你是企业公开信息搜索助手。联网搜索后返回标题、摘要、来源链接。' },
        { role: 'user', content: '请联网搜索：' + query },
      ],
    },
    parameters: { enable_search: true, result_format: 'message', max_tokens: 2000, temperature: 0.1 },
  };
  return requestJson('POST', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', body, {
    'Authorization': 'Bearer ' + apiKey,
  }).then(function(json) {
    var output = json.output || {};
    var searchInfo = output.search_info || {};
    var rawResults = searchInfo.search_results || [];
    // Map Qwen search result fields robustly — field names vary by API version
    var rows = rawResults.map(function(r) {
      var title = r.title || r.name || r.heading || r.Title || '';
      var url = r.link || r.url || r.href || r.Url || r.Link || '';
      var snippet = r.text || r.snippet || r.body || r.content || r.description || r.summary || r.Snippet || '';
      // If title is missing but we have a URL, extract domain as title fallback
      if (!title.trim() && url) {
        try {
          var hostname = (new (require('url').URL)(url)).hostname || '';
          title = hostname.replace(/^www\./, '');
        } catch(e) { title = url.substring(0, 60); }
      }
      return { title: title, snippet: snippet, url: url, provider: 'qwen' };
    }).filter(function(r) { return r.url; });
    if (rows.length > 0) return rows.slice(0, maxResults);
    // Fallback: extract from text response
    var text = output.text || (output.choices && output.choices[0] && output.choices[0].message && output.choices[0].message.content) || '';
    var parsed = parseQwenSearchText(text);
    return parsed.length > 0 ? parsed.slice(0, maxResults) : [];
  });
}

function parseQwenSearchText(text) {
  text = String(text || '');
  var rows = [];
  var blocks = text.split(/\n(?=\s*\d+\.\s|\s*[-*]\s+\*\*标题|\s*标题[:：])/);
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var url = matchLine(block, /(?:来源链接|链接|URL|url)[:：]\s*(https?:\/\/\S+)/i);
    if (!url) {
      var urls = block.match(/https?:\/\/[^\s)）\]]+/g);
      url = urls && urls[0] || '';
    }
    if (!url) continue;
    var title = matchLine(block, /(?:标题)[:：]\s*(.+)/i)
      || matchLine(block, /\*\*标题\*\*[:：]?\s*(.+)/i)
      || matchLine(block, /^\s*\d+\.\s+\*\*(.+?)\*\*/m)
      || url;
    var snippet = matchLine(block, /(?:摘要|简介|内容)[:：]\s*(.+)/i) || block.replace(url, '').trim();
    rows.push({
      title: title.replace(/\*\*/g, '').trim(),
      url: url.replace(/[，。,.]+$/, ''),
      snippet: snippet.replace(/\*\*/g, '').trim().slice(0, 700),
      provider: 'llm_search_assist',
    });
  }
  return rows;
}

function requestJson(method, targetUrl, body, headers) {
  headers = headers || {};
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  return requestText(method, targetUrl, body ? JSON.stringify(body) : null, headers).then(function(text) {
    return JSON.parse(text);
  });
}

function requestText(method, targetUrl, body, headers) {
  return new Promise(function(resolve, reject) {
    var u = new URL(targetUrl);
    var mod = u.protocol === 'https:' ? https : http;
    headers = headers || {};
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    var req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 160)));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, function() {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  DEFAULT_PROVIDERS: DEFAULT_PROVIDERS,
  normalizeProviders: normalizeProviders,
  normalizeSearchResult: normalizeSearchResult,
  searchWeb: searchWeb,
};
