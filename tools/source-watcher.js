/**
 * Source Watcher — Auto-detect new/modified files in raw/sources/
 *
 * Monitors the sources directory and auto-enqueues new files
 * into the ingest queue. Uses fs.watch with debouncing.
 *
 * Usage:
 *   const { SourceWatcher } = require('./tools/source-watcher');
 *   const watcher = new SourceWatcher(sourcesDir, queue);
 *   watcher.start();
 *   watcher.on('detected', fn); // files detected
 */

'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class SourceWatcher extends EventEmitter {
  constructor(sourcesDir, options) {
    super();
    this.sourcesDir = sourcesDir;
    this.options = options || {};
    this.debounceMs = this.options.debounceMs || 2000;
    this.watching = false;
    this.watcher = null;
    this.debounceTimer = null;
    this.pendingFiles = [];
  }

  start() {
    if (this.watching) return;
    if (!fs.existsSync(this.sourcesDir)) {
      fs.mkdirSync(this.sourcesDir, { recursive: true });
    }

    this.watching = true;

    try {
      this.watcher = fs.watch(this.sourcesDir, { recursive: true }, this._onChange.bind(this));
      this.emit('started');
    } catch (e) {
      // Fallback: polling every 5 seconds
      this.emit('warning', 'fs.watch failed, using polling: ' + e.message);
      this._pollInterval = setInterval(this._poll.bind(this), 5000);
    }

    // Initial scan
    this._scan();
  }

  stop() {
    this.watching = false;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.emit('stopped');
  }

  _onChange(eventType, filename) {
    if (!filename) return;
    const fullPath = path.join(this.sourcesDir, filename);
    // Debounce — wait for writes to settle
    this.pendingFiles.push(fullPath);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(this._flush.bind(this), this.debounceMs);
  }

  _poll() {
    if (!this.watching) return;
    this._scan();
  }

  _scan() {
    const scan = function(dir) {
      const results = [];
      if (!fs.existsSync(dir)) return results;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach(function(e) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { results.push.apply(results, scan(fp)); }
        else if (!e.name.startsWith('.') && !fp.endsWith('.ingest-queue.json')) {
          results.push({ fullPath: fp, name: e.name, size: fs.statSync(fp).size });
        }
      });
      return results;
    };

    const files = scan(this.sourcesDir);
    if (files.length) {
      this.emit('detected', files);
    }
  }

  _flush() {
    const files = this.pendingFiles;
    this.pendingFiles = [];
    if (!files.length) return;

    // Validate files exist and filter
    const valid = [];
    files.forEach(function(fp) {
      try {
        if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          valid.push({ fullPath: fp, name: path.basename(fp) });
        }
      } catch (e) { /* file disappeared */ }
    });

    if (valid.length) this.emit('detected', valid);
  }
}

module.exports = { SourceWatcher };
