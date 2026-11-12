/**
 * Knowledge Converter — SSE-streaming document-to-Markdown pipeline
 *
 * Replaces OntoMind Java FileUploadController + Python agent-service chain.
 * Uses multi-format-parser.js for extraction and AI Harbor LLM routes for structuring.
 *
 * Endpoint:
 *   POST /api/knowledge/documents/convert-stream
 *     Accepts: multipart/form-data with file(s) + optional model param
 *     Returns: SSE event stream with conversion progress and results
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { parseFile, getFileType } = require('../tools/multi-format-parser');
const { WikiEngine } = require('../tools/llm-wiki-engine');
const { API_ROUTES, DEFAULT_CHAT_MODEL } = require('../config/api-keys');

// ── Stream helpers ──

function sseEvent(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (e) { /* connection closed */ }
}

// ── Main handler ──

function handleConvertStream(req, res) {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  const formidable = require('formidable');
  const tmpDir = path.join(__dirname, '../wiki-raw/convert-temp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const form = new formidable.IncomingForm({
    uploadDir: tmpDir,
    keepExtensions: true,
    maxFileSize: 100 * 1024 * 1024, // 100MB
    multiples: true,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      sseEvent(res, 'error', { message: 'Upload parse failed: ' + err.message });
      res.end();
      return;
    }

    try {
      const uploadedFiles = [].concat(files.files || files.file || []);
      if (!uploadedFiles.length || !uploadedFiles[0].originalFilename) {
        sseEvent(res, 'error', { message: 'No files received' });
        res.end();
        return;
      }

      const model = (fields.model || DEFAULT_CHAT_MODEL).toString();
      const persistProject = String(fields.persistProject || '').trim();
      const routeConfig = API_ROUTES[model] || API_ROUTES[DEFAULT_CHAT_MODEL];
      const llmApiKey = routeConfig ? routeConfig.apiKey || (routeConfig.getKey && routeConfig.getKey()) : null;

      sseEvent(res, 'start', {
        total: uploadedFiles.length,
        model: model,
        message: 'Starting conversion of ' + uploadedFiles.length + ' file(s) with ' + model,
      });

      let combinedMarkdown = '';

      for (let i = 0; i < uploadedFiles.length; i++) {
        const file = uploadedFiles[i];
        const fileName = file.originalFilename || 'file_' + i;
        const filePath = file.filepath || file.path;

        // ── Phase 1: Extract raw text ──
        sseEvent(res, 'phase', {
          file: fileName,
          index: i,
          total: uploadedFiles.length,
          stage: 'extract',
          message: '[' + (i + 1) + '/' + uploadedFiles.length + '] Extracting: ' + fileName,
        });

        let extracted;
        try {
          extracted = await parseFile(filePath, {});
        } catch (parseErr) {
          sseEvent(res, 'warning', {
            file: fileName,
            message: 'Parse warning: ' + parseErr.message + ' — treating as raw text',
          });
          try {
            extracted = { text: fs.readFileSync(filePath, 'utf-8'), images: [], tables: [] };
          } catch (readErr) {
            sseEvent(res, 'error', { file: fileName, message: 'Cannot read file: ' + readErr.message });
            continue;
          }
        }

        const rawText = (extracted.text || '').slice(0, 50000); // 50K char limit

        if (!rawText.trim()) {
          sseEvent(res, 'warning', { file: fileName, message: 'No extractable text content' });
          continue;
        }

        sseEvent(res, 'phase', {
          file: fileName,
          index: i,
          total: uploadedFiles.length,
          stage: 'extract_done',
          message: 'Extracted ' + rawText.length + ' chars from ' + fileName,
          preview: rawText.slice(0, 300),
        });

        // ── Phase 2: LLM structure to Markdown ──
        sseEvent(res, 'phase', {
          file: fileName,
          index: i,
          total: uploadedFiles.length,
          stage: 'structure',
          message: 'Structuring with LLM...',
        });

        let structuredMarkdown;
        if (llmApiKey && routeConfig) {
          try {
            structuredMarkdown = await structureWithLLM(rawText, fileName, routeConfig, llmApiKey, model);
          } catch (llmErr) {
            sseEvent(res, 'warning', {
              file: fileName,
              message: 'LLM structuring failed: ' + llmErr.message + ' — using raw text',
            });
            structuredMarkdown = wrapRawAsMarkdown(rawText, fileName);
          }
        } else {
          // No LLM available — wrap raw text as basic markdown
          structuredMarkdown = wrapRawAsMarkdown(rawText, fileName);
        }

        combinedMarkdown += '\n\n---\n\n' + structuredMarkdown;

        // Stream chunk to client
        sseEvent(res, 'chunk', {
          file: fileName,
          index: i,
          content: structuredMarkdown,
        });
      }

      // ── Phase 2.5: Persist to wiki (optional, only when persistProject provided) ──
      if (persistProject && combinedMarkdown.trim()) {
        // Same slug rule as llm-wiki-engine WikiEngine.slugify
        const slug = persistProject.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '');
        if (slug) {
          sseEvent(res, 'phase', { stage: 'persist', message: 'Persisting to wiki project "' + slug + '"...' });
          try {
            const uploadDir = path.join(__dirname, '../wiki-raw/uploaded');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            const persistedPath = path.join(uploadDir, slug + '-' + Date.now() + '.md');
            fs.writeFileSync(persistedPath, combinedMarkdown, 'utf-8');
            const engine = new WikiEngine({ chatRoute: routeConfig, chatApiKey: llmApiKey, chatModel: model });
            const results = await engine.ingest(persistedPath, { projectName: slug, recursive: false });
            sseEvent(res, 'persisted', {
              project: slug,
              sourcePath: persistedPath,
              wikiDir: 'wiki/' + slug,
              processed: results.processed,
              failed: results.failed,
              errors: results.errors || [],
            });
          } catch (persistErr) {
            sseEvent(res, 'warning', { stage: 'persist', message: 'Persist failed: ' + persistErr.message });
          }
        }
      }

      // ── Phase 3: Done ──
      sseEvent(res, 'done', {
        message: 'Conversion complete — ' + uploadedFiles.length + ' file(s) processed',
        totalChars: combinedMarkdown.length,
        markdown: combinedMarkdown,
      });

      // Clean up temp files
      for (const f of uploadedFiles) {
        try { fs.unlinkSync(f.filepath || f.path); } catch (e) { /* ignore */ }
      }

      res.end();
    } catch (e) {
      sseEvent(res, 'error', { message: 'Fatal error: ' + e.message });
      res.end();
    }
  });

  // Handle client abort during upload（请求体上传完成时 req 的 'close' 也会触发，
  // 用 'aborted' 只监听真正的客户端中断，避免 SSE 流被过早掐断）
  req.on('aborted', () => {
    try { res.end(); } catch (e) { /* already ended */ }
  });
}

// ── LLM structuring ──

async function structureWithLLM(rawText, fileName, routeConfig, apiKey, model) {
  const systemPrompt = [
    'You are a document structuring assistant. Convert the following extracted text into clean, well-organized Markdown.',
    '',
    'Rules:',
    '1. Preserve ALL factual information from the source.',
    '2. Add proper headings (##, ###) based on document structure.',
    '3. Format tables using Markdown table syntax.',
    '4. Use **bold** for key terms and *italic* for emphasis.',
    '5. Add a level-1 heading (#) with the document title at the top.',
    '6. If the document contains numerical data, format it clearly.',
    '7. Keep the original language. Do NOT translate.',
    '8. Add a "## Source" section at the bottom with the filename.',
    '',
    'Output ONLY the formatted Markdown, no explanations.',
  ].join('\n');

  const userPrompt = 'File: ' + fileName + '\n\n' + rawText;

  const postData = JSON.stringify({
    model: routeConfig.model || model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 8192,
    temperature: 0.3,
  });

  return new Promise((resolve, reject) => {
    const https = require('https');
    const options = {
      hostname: routeConfig.host,
      port: 443,
      path: routeConfig.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 60000,
    };

    const r = https.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (content) resolve(content);
          else if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else reject(new Error('Empty LLM response'));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    });

    r.on('error', e => reject(new Error('Request failed: ' + e.message)));
    r.on('timeout', () => { r.destroy(); reject(new Error('LLM request timed out')); });

    r.write(postData);
    r.end();
  });
}

function wrapRawAsMarkdown(rawText, fileName) {
  return '# ' + fileName.replace(/\.[^.]+$/, '') + '\n\n' + rawText;
}

module.exports = { handleConvertStream };
