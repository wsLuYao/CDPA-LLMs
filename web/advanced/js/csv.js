(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionCSV = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parse(text, options = {}) {
    const input = String(text || "").replace(/^\uFEFF/, "");
    const omitted = new Set(options.omit || []);
    const internPool = options.intern ? new Map() : null;
    const internLimit = Number.isFinite(options.internLimit) ? options.internLimit : 4096;
    const records = [];
    let headers = null;
    let headerRow = [];
    let record = null;
    let columnIndex = 0;
    let field = "";
    let fieldStarted = false;
    let quoted = false;
    let rowHasValue = false;

    function capturesCurrentField() {
      return !headers || !omitted.has(headers[columnIndex]);
    }

    function intern(value) {
      if (!internPool || value.length > internLimit) return value;
      if (internPool.has(value)) return internPool.get(value);
      internPool.set(value, value);
      return value;
    }

    function append(value) {
      if (value !== "") rowHasValue = true;
      fieldStarted = true;
      if (capturesCurrentField()) field += value;
    }

    function finishField() {
      if (!headers) {
        headerRow.push(field);
      } else if (columnIndex < headers.length && !omitted.has(headers[columnIndex])) {
        if (!record) record = { __row: records.length + 2 };
        record[headers[columnIndex]] = intern(field);
      }
      columnIndex += 1;
      field = "";
      fieldStarted = false;
    }

    function finishRow() {
      finishField();
      if (rowHasValue) {
        if (!headers) {
          headers = headerRow.map((header, index) => {
            const cleaned = String(header || "").replace(/^\uFEFF/, "").trim();
            return cleaned || `column_${index + 1}`;
          });
        } else {
          if (!record) record = { __row: records.length + 2 };
          for (let index = columnIndex; index < headers.length; index += 1) {
            if (!omitted.has(headers[index])) record[headers[index]] = "";
          }
          records.push(record);
        }
      }
      headerRow = [];
      record = null;
      columnIndex = 0;
      field = "";
      fieldStarted = false;
      rowHasValue = false;
    }

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"') {
          if (input[i + 1] === '"') {
            append('"');
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          append(ch);
        }
        continue;
      }

      if (ch === '"' && !fieldStarted) {
        quoted = true;
        fieldStarted = true;
      } else if (ch === ",") {
        finishField();
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && input[i + 1] === "\n") i += 1;
        finishRow();
      } else {
        append(ch);
      }
    }
    if (field.length || columnIndex || rowHasValue) finishRow();
    return records;
  }

  function chunkParser(options = {}) {
    const omitted = new Set(options.omit || []);
    const internPool = options.intern ? new Map() : null;
    const internLimit = Number.isFinite(options.internLimit) ? options.internLimit : 4096;
    const records = [];
    let headerValues = [];
    let headerRow = [];
    let record = null;
    let columnIndex = 0;
    let field = "";
    let fieldStarted = false;
    let quoted = false;
    let pendingQuotedQuote = false;
    let rowHasValue = false;

    function capturesCurrentField() {
      return !headerValues.length || !omitted.has(headerValues[columnIndex]);
    }
    function intern(value) {
      if (!internPool || value.length > internLimit) return value;
      if (internPool.has(value)) return internPool.get(value);
      internPool.set(value, value);
      return value;
    }
    function append(value) {
      if (value !== "") rowHasValue = true;
      fieldStarted = true;
      if (capturesCurrentField()) field += value;
    }
    function finishField() {
      if (!headerValues.length) headerRow.push(field);
      else if (columnIndex < headerValues.length && !omitted.has(headerValues[columnIndex])) {
        if (!record) record = { __row: records.length + 2 };
        record[headerValues[columnIndex]] = intern(field);
      }
      columnIndex += 1;
      field = "";
      fieldStarted = false;
    }
    function finishRow() {
      finishField();
      if (rowHasValue) {
        if (!headerValues.length) {
          headerValues = headerRow.map((header, index) => {
            const cleaned = String(header || "").replace(/^\uFEFF/, "").trim();
            return cleaned || `column_${index + 1}`;
          });
        } else {
          if (!record) record = { __row: records.length + 2 };
          for (let index = columnIndex; index < headerValues.length; index += 1) {
            if (!omitted.has(headerValues[index])) record[headerValues[index]] = "";
          }
          records.push(record);
        }
      }
      headerRow = [];
      record = null;
      columnIndex = 0;
      field = "";
      fieldStarted = false;
      rowHasValue = false;
    }
    function processChunk(chunk) {
      const input = String(chunk || "");
      let index = 0;
      if (pendingQuotedQuote) {
        if (input[0] === '"') { append('"'); index = 1; }
        else quoted = false;
        pendingQuotedQuote = false;
      }
      for (; index < input.length; index += 1) {
        const ch = input[index];
        if (quoted) {
          if (ch === '"') {
            if (index + 1 < input.length) {
              if (input[index + 1] === '"') { append('"'); index += 1; }
              else quoted = false;
            } else pendingQuotedQuote = true;
          } else append(ch);
          continue;
        }
        if (ch === '"' && !fieldStarted) { quoted = true; fieldStarted = true; }
        else if (ch === ",") finishField();
        else if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && input[index + 1] === "\n") index += 1;
          finishRow();
        } else append(ch);
      }
    }
    function finish() {
      if (pendingQuotedQuote) { quoted = false; pendingQuotedQuote = false; }
      if (field.length || columnIndex || rowHasValue) finishRow();
      return records;
    }
    return { processChunk, finish, get headers() { return headerValues.slice(); } };
  }

  async function parseBlob(blob, options = {}) {
    if (!blob || typeof blob.slice !== "function" || typeof blob.stream !== "function") throw new Error("当前浏览器不支持CSV分块读取");
    const probeBytes = await blob.slice(0, Math.min(blob.size || 65536, 65536)).arrayBuffer();
    const probe = decodeBuffer(probeBytes);
    const headerValues = headers(probe.text);
    const type = classifyHeaders(headerValues);
    const omit = typeof options.omitForType === "function" ? options.omitForType(type) : options.omit;
    const parser = chunkParser({ ...options, omit });
    const encoding = probe.encoding === "utf-8-lossy" ? "utf-8" : probe.encoding;
    const decoder = new TextDecoder(encoding);
    const reader = blob.stream().getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.processChunk(decoder.decode(value, { stream: true }));
    }
    parser.processChunk(decoder.decode());
    return { rows: parser.finish(), headers: headerValues, type, encoding: probe.encoding };
  }

  function headers(text) {
    const input = String(text || "").replace(/^\uFEFF/, "");
    const values = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"') {
          if (input[i + 1] === '"') { field += '"'; i += 1; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"' && field.length === 0) quoted = true;
      else if (ch === ",") { values.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") { values.push(field); break; }
      else field += ch;
    }
    if (!values.length && field) values.push(field);
    return values.map((header, index) => {
      const cleaned = String(header || "").replace(/^\uFEFF/, "").trim();
      return cleaned || `column_${index + 1}`;
    });
  }

  function escape(value) {
    if (value == null) return "";
    const str = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function stringify(rows, columns) {
    if (!Array.isArray(rows) || rows.length === 0) return "";
    const keys = columns && columns.length ? columns : Array.from(rows.reduce((set, row) => {
      Object.keys(row || {}).filter((key) => !key.startsWith("__")).forEach((key) => set.add(key));
      return set;
    }, new Set()));
    const lines = [keys.map(escape).join(",")];
    rows.forEach((row) => lines.push(keys.map((key) => escape(row ? row[key] : "")).join(",")));
    return "\uFEFF" + lines.join("\r\n");
  }

  function looksBroken(text) {
    if (!text) return false;
    const replacement = (text.match(/\uFFFD/g) || []).length;
    return replacement > Math.max(2, text.length * 0.001);
  }

  function decodeBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const attempts = ["utf-8", "gb18030"];
    let fallback = "";
    for (const encoding of attempts) {
      try {
        const text = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes);
        if (!looksBroken(text)) return { text, encoding };
        fallback = text;
      } catch (error) {
        void error;
      }
    }
    return { text: fallback || new TextDecoder("utf-8").decode(bytes), encoding: "utf-8-lossy" };
  }

  function classifyHeaders(headerValues) {
    const keys = new Set(headerValues || []);
    if (keys.has("TaskIndex") && keys.has("RunID") && (keys.has("Source_Context") || keys.size > 45)) return "complete";
    if (keys.has("Ranking") && keys.has("CanonicalRanking") && keys.has("FinalStatus")) return "ranking";
    if (keys.has("Context") && keys.has("ScoreFamily") && keys.has("ConditionStructure")) return "bank";
    return "unknown_csv";
  }

  function classifyCSV(rows) {
    return classifyHeaders(rows && rows[0] ? Object.keys(rows[0]).filter((key) => key !== "__row") : []);
  }

  function parseJSONL(text, transform) {
    const records = [];
    const errors = [];
    const input = String(text || "");
    let start = 0;
    let lineNumber = 1;
    for (let index = 0; index <= input.length; index += 1) {
      if (index < input.length && input[index] !== "\n") continue;
      const end = index > start && input[index - 1] === "\r" ? index - 1 : index;
      const line = input.slice(start, end);
      start = index + 1;
      if (!line.trim()) { lineNumber += 1; continue; }
      try {
        const parsed = JSON.parse(line);
        records.push(typeof transform === "function" ? transform(parsed) : parsed);
      } catch (error) {
        errors.push({ line: lineNumber, message: error.message });
      }
      lineNumber += 1;
    }
    return { records, errors };
  }

  return { parse, parseBlob, headers, stringify, decodeBuffer, classifyHeaders, classifyCSV, parseJSONL };
});
