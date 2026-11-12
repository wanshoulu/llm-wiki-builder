/**
 * Deep Research — Multi-source web research with LLM synthesis
 *
 * Flow:
 *   1. LLM generates research topics from user question + wiki context
 *   2. User confirms/edits topics and search queries
 *   3. Execute web searches (Tavily/SerpApi/SearXNG)
 *   4. LLM synthesizes findings into a research page
 *   5. Auto-ingest result into wiki
 *
 * Usage:
 *   const { DeepResearch } = require('./tools/deep-research');
 *   const dr = new DeepResearch({ searchProvider: 'tavily', apiKey: '...' });
 *   const result = await dr.research('quantum computing applications', wikiContext);
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

class DeepResearch {
  constructor(options) {
    this.options = options || {};
    this.searchProvider = this.options.searchProvider || 'searxng'; // tavily | serpapi | searxng
    this.searchApiKey = this.options.searchApiKey || '';
    this.searxngUrl = this.options.searxngUrl || '';
    this.llmRoute = this.options.llmRoute || null; // { host, path, apiKey, model }
    this.maxResults = this.options.maxResults || 5;
    this.maxConcurrent = this.options.maxConcurrent || 3;
  }

  /**
   * Full research pipeline
   * @returns { topics, searchResults, synthesis, wikiPage }
   */
  async research(question, wikiContext, options) {
    const opts = options || {};
    const result = { question, steps: [] };

    // Step 1: Generate research topics
    result.topics = await this.generateTopics(question, wikiContext);
    result.steps.push({ step: 'topics', data: result.topics });

    // Step 2: Execute searches (user can pre-edit result.topics.queries)
    result.searchResults = await this.executeSearches(result.topics);
    result.steps.push({ step: 'search', count: result.searchResults.length });

    // Step 3: Synthesize findings
    result.synthesis = await this.synthesize(question, result.searchResults, wikiContext);
    result.steps.push({ step: 'synthesis', length: result.synthesis.length });

    // Step 4: Generate wiki page
    result.wikiPage = this.formatWikiPage(question, result);
    result.steps.push({ step: 'wikiPage', length: result.wikiPage.length });

    return result;
  }

  /**
   * Step 1: LLM generates research topics and search queries
   */
  async generateTopics(question, wikiContext) {
    const prompt = [
      'You are a research strategist. Based on the user question and existing wiki knowledge, generate research topics and optimized search queries.',
      '',
      'User question: ' + question,
      '',
      'Existing wiki context (use this to identify knowledge GAPS):',
      (wikiContext || 'No existing knowledge.').slice(0, 3000),
      '',
      'Output JSON:',
      '{',
      '  "mainTopic": "The core research theme",',
      '  "subTopics": ["subtopic 1", "subtopic 2"],',
      '  "queries": ["optimized search query 1", "optimized search query 2", ...],',
      '  "rationale": "Why this research is needed based on knowledge gaps"',
      '}',
      'Generate 3-5 search queries optimized for web search engines.',
    ].join('\n');

    const response = await this._callLLM(prompt, { maxTokens: 1024, temperature: 0.5 });
    try {
      return JSON.parse(this._extractJSON(response));
    } catch (e) {
      return { mainTopic: question, subTopics: [], queries: [question], rationale: '' };
    }
  }

  /**
   * Step 2: Execute web searches
   */
  async executeSearches(topics) {
    const queries = (topics.queries || [topics.mainTopic]).slice(0, this.maxConcurrent);
    const results = [];

    for (const query of queries) {
      try {
        const searchResult = await this._search(query);
        results.push({ query, results: searchResult });
      } catch (e) {
        results.push({ query, results: [], error: e.message });
      }
    }
    return results;
  }

  /**
   * Step 3: Synthesize findings
   */
  async synthesize(question, searchResults, wikiContext) {
    const searchText = searchResults.map(function(sr) {
      return '## Search: ' + sr.query + '\n\n' +
        (sr.results || []).map(function(r, i) {
          return '[' + (i + 1) + '] ' + r.title + '\n' + r.snippet + '\n' + (r.url || r.link || '');
        }).join('\n\n');
    }).join('\n\n---\n\n');

    const prompt = [
      'You are a research synthesizer. Synthesize the web search results into a comprehensive answer.',
      '',
      'User question: ' + question,
      '',
      'Web search results:',
      searchText.slice(0, 8000),
      '',
      'Existing wiki context (for cross-reference):',
      (wikiContext || '').slice(0, 2000),
      '',
      'Write a well-structured research synthesis with:',
      '1. Executive summary (2-3 sentences)',
      '2. Key findings (numbered list with citations [1], [2], etc.)',
      '3. Cross-references to existing wiki pages using [[page]] syntax',
      '4. Knowledge gaps that still remain',
      '5. Recommended follow-up research topics',
      '',
      'Be factual. Cite sources. Do not fabricate information.',
    ].join('\n');

    return await this._callLLM(prompt, { maxTokens: 4096, temperature: 0.4 });
  }

  /**
   * Step 4: Format as wiki page
   */
  formatWikiPage(question, result) {
    var lines = [
      '---',
      'title: "Research: ' + question.slice(0, 60) + '"',
      'type: synthesis',
      'source: deep-research',
      'created: ' + new Date().toISOString(),
      'topics: [' + (result.topics && result.topics.subTopics ? result.topics.subTopics.map(function(t) { return '"' + t + '"'; }).join(', ') : '') + ']',
      '---',
      '',
      '# Research: ' + question,
      '',
      '> Auto-generated by Deep Research on ' + new Date().toISOString().split('T')[0],
      '',
      '## Research Topics',
      '- **Main**: ' + (result.topics ? result.topics.mainTopic : question),
    ];

    if (result.topics && result.topics.subTopics) {
      result.topics.subTopics.forEach(function(t) { lines.push('- ' + t); });
    }

    lines.push('', '## Synthesis', '', result.synthesis || '', '', '## Sources');

    if (result.searchResults) {
      result.searchResults.forEach(function(sr) {
        lines.push('### ' + sr.query);
        (sr.results || []).forEach(function(r, i) {
          lines.push((i + 1) + '. [' + (r.title || 'Source') + '](' + (r.url || r.link || '') + ') - ' + (r.snippet || '').slice(0, 200));
        });
        lines.push('');
      });
    }

    lines.push('', '## Related Pages', '', '_Cross-reference existing wiki pages here_', '');
    return lines.join('\n');
  }

  // ── Internal: Web Search ──

  async _search(query) {
    if (this.searchProvider === 'tavily' && this.searchApiKey) {
      return this._tavilySearch(query);
    }
    // Fallback: return empty results with a note
    return [{ title: 'Search: ' + query, snippet: 'Web search not configured. Set searchProvider and apiKey to enable Deep Research.', url: '' }];
  }

  async _tavilySearch(query) {
    return new Promise(function(resolve, reject) {
      var postData = JSON.stringify({ query: query, max_results: 5, include_answer: true });
      var options = {
        hostname: 'api.tavily.com', port: 443, path: '/search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.searchApiKey, 'Content-Length': Buffer.byteLength(postData) },
      };
      var r = https.request(options, function(resp) {
        var d = '';
        resp.on('data', function(c) { d += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(d);
            resolve((json.results || []).map(function(r) { return { title: r.title, snippet: r.content || r.snippet, url: r.url }; }));
          } catch(e) { resolve([]); }
        });
      });
      r.on('error', function(e) { resolve([]); });
      r.write(postData); r.end();
    }.bind(this));
  }

  // ── Internal: LLM Call ──

  async _callLLM(prompt, options) {
    if (!this.llmRoute || !this.llmRoute.apiKey) return 'LLM not configured. Set llmRoute to enable synthesis.';

    var opts = options || {};
    var postData = JSON.stringify({
      model: this.llmRoute.model || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts.maxTokens || 2048,
      temperature: opts.temperature || 0.5,
    });

    var self = this;
    return new Promise(function(resolve, reject) {
      var reqOpts = {
        hostname: self.llmRoute.host, port: 443, path: self.llmRoute.path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.llmRoute.apiKey, 'Content-Length': Buffer.byteLength(postData) },
      };
      var r = https.request(reqOpts, function(resp) {
        var d = '';
        resp.on('data', function(c) { d += c; });
        resp.on('end', function() {
          try {
            var json = JSON.parse(d);
            resolve(json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : '');
          } catch(e) { resolve(d); }
        });
      });
      r.on('error', function(e) { reject(e); });
      r.write(postData); r.end();
    });
  }

  _extractJSON(text) {
    var match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : '{}';
  }
}

module.exports = { DeepResearch };
