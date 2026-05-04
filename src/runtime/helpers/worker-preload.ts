/**
 * Worker preload — inline sandbox helper source
 *
 * Generates the JavaScript source string that is written to a temp file
 * and passed via WorkerOptions.preloadHelpers[] so the Deno worker evaluates
 * it before any user code runs.  Injects compact/summarize/delta/budget/findTool
 * onto the mcp global.
 *
 * @module runtime/helpers/worker-preload
 */

export interface PreloadOptions {
  /** Registry tools to seed findTool (server/tool/description triples) */
  tools?: Array<{ server: string; tool: string; description: string }>;
}

/**
 * Build a self-contained JS source string for the Deno worker preload.
 * The string is plain JavaScript — no TypeScript-only syntax — because
 * it runs inside the Deno subprocess at runtime.
 */
export function buildHelperPreloadSource(options: PreloadOptions = {}): string {
  const toolsJson = JSON.stringify(options.tools ?? []);

  const compactSrc = `
(function injectCompact() {
  function buildSelectorTree(fields) {
    var tree = {};
    for (var i = 0; i < fields.length; i++) {
      var parts = fields[i].split('.');
      var node = tree;
      for (var j = 0; j < parts.length; j++) {
        if (j === parts.length - 1) { node[parts[j]] = true; }
        else { if (typeof node[parts[j]] !== 'object') node[parts[j]] = {}; node = node[parts[j]]; }
      }
    }
    return tree;
  }
  function trimValue(value, selector, opts, depth) {
    var maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : Infinity;
    if (depth > maxDepth) return (typeof value === 'object' && value !== null) ? '[truncated]' : value;
    if (typeof value === 'string') {
      var max = opts.maxStringLength;
      return (max !== undefined && value.length > max) ? value.slice(0, max) + '…' : value;
    }
    if (Array.isArray(value)) {
      var arr = opts.maxItems !== undefined ? value.slice(0, opts.maxItems) : value;
      return arr.map(function(item) { return trimValue(item, selector, opts, depth + 1); });
    }
    if (typeof value === 'object' && value !== null) {
      var result = {};
      if (selector && Object.keys(selector).length > 0) {
        var keys = Object.keys(selector);
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            var cs = selector[key];
            result[key] = trimValue(value[key], cs === true ? null : cs, opts, depth + 1);
          }
        }
      } else {
        var objKeys = Object.keys(value);
        for (var ok = 0; ok < objKeys.length; ok++) result[objKeys[ok]] = trimValue(value[objKeys[ok]], null, opts, depth + 1);
      }
      return result;
    }
    return value;
  }
  globalThis.__mcp_compact = function compact(data, options) {
    options = options || {};
    var selector = (options.fields && options.fields.length > 0) ? buildSelectorTree(options.fields) : null;
    return trimValue(data, selector, options, 0);
  };
})();
`;

  const summarizeSrc = `
(function injectSummarize() {
  var CPT = 4;
  function clip(text, max) { return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'; }
  globalThis.__mcp_summarize = function summarize(data, options) {
    var maxChars = options.maxTokens * CPT;
    var style = options.style || 'list';
    if (style === 'json') { try { return clip(JSON.stringify(data, null, 2), maxChars); } catch(e) { return clip(String(data), maxChars); } }
    if (style === 'paragraph') {
      var text;
      if (typeof data === 'string') { text = data; }
      else if (Array.isArray(data)) {
        var prev = data.slice(0,3).map(function(x){return typeof x==='object'?JSON.stringify(x).slice(0,60):String(x).slice(0,60);}).join(', ');
        text = data.length + ' item' + (data.length!==1?'s':'') + ': ' + prev + (data.length>3?'...':'');
      } else if (typeof data === 'object' && data !== null) {
        var kk = Object.keys(data);
        text = 'Object with ' + kk.length + ' field' + (kk.length!==1?'s':'') + ': ' + kk.slice(0,5).map(function(k){return k+': '+JSON.stringify(data[k]).slice(0,30);}).join('; ');
      } else { text = String(data); }
      return clip(text, maxChars);
    }
    var lines = [];
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var item = data[i];
        if (typeof item === 'object' && item !== null) {
          lines.push('• ' + Object.entries(item).slice(0,4).map(function(e){return e[0]+'='+JSON.stringify(e[1]);}).join(', '));
        } else { lines.push('• ' + String(item)); }
      }
    } else if (typeof data === 'object' && data !== null) {
      Object.entries(data).forEach(function(e){lines.push(e[0]+': '+(typeof e[1]==='object'?JSON.stringify(e[1]):String(e[1])));});
    } else { lines.push(String(data)); }
    var result = '';
    for (var li = 0; li < lines.length; li++) {
      var candidate = result ? result + '\n' + lines[li] : lines[li];
      if (candidate.length > maxChars) { var rem = maxChars - result.length - 1; if (rem > 4) result += (result?'\n':'')+clip(lines[li],rem); break; }
      result = candidate;
    }
    return result || clip(String(data), maxChars);
  };
})();
`;

  const deltaSrc = `
(function injectDelta() {
  var __snapshots = new Map();
  globalThis.__mcp_delta = async function delta(server, tool, args, current) {
    var key = server + '::' + tool + '::' + JSON.stringify(args);
    var previous = __snapshots.get(key);
    __snapshots.set(key, current);
    if (previous === undefined) return { changed: true, delta: current };
    if (Array.isArray(current) && Array.isArray(previous)) {
      var changed = JSON.stringify(previous) !== JSON.stringify(current);
      return { changed: changed, delta: changed ? current : [], added: Math.max(0,current.length-previous.length), removed: Math.max(0,previous.length-current.length) };
    }
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
      var d = {}; var ck = [];
      var allKeys = new Set(Object.keys(previous||{}).concat(Object.keys(current)));
      allKeys.forEach(function(k){ if(JSON.stringify((previous||{})[k])!==JSON.stringify(current[k])){ d[k]=current[k]; ck.push(k); } });
      return { changed: ck.length > 0, delta: ck.length > 0 ? d : {}, changedKeys: ck };
    }
    var prim_changed = JSON.stringify(previous) !== JSON.stringify(current);
    return { changed: prim_changed, delta: prim_changed ? current : undefined };
  };
})();
`;

  const budgetSrc = `
(function injectBudget() {
  var CPT = 4;
  function est(data) { try { return Math.ceil((JSON.stringify(data)||String(data)).length/CPT); } catch(e) { return Math.ceil(String(data).length/CPT); } }
  function BudgetExceededError(estimated, max) {
    this.name = 'BudgetExceededError';
    this.message = 'Result exceeds token budget: '+estimated+' > '+max;
    this.estimatedTokens = estimated;
    this.maxTokens = max;
  }
  BudgetExceededError.prototype = Object.create(Error.prototype);
  function tryTrim(data, maxTokens) {
    if (Array.isArray(data)) {
      var mxList = [100, 50, 20, 10, 5, 1];
      for (var mi = 0; mi < mxList.length; mi++) {
        var t = globalThis.__mcp_compact(data, {maxItems: mxList[mi], maxStringLength: 200});
        if (est(t) <= maxTokens) return t;
      }
    }
    if (typeof data === 'object' && data !== null) {
      var mdList = [5, 3, 2, 1];
      for (var md = 0; md < mdList.length; md++) {
        var td = globalThis.__mcp_compact(data, {maxDepth: mdList[md], maxItems: 20, maxStringLength: 200});
        if (est(td) <= maxTokens) return td;
      }
    }
    var ls = globalThis.__mcp_summarize(data, {maxTokens: maxTokens, style: 'list'});
    if (est(ls) <= maxTokens) return ls;
    var ps = globalThis.__mcp_summarize(data, {maxTokens: maxTokens, style: 'paragraph'});
    if (est(ps) <= maxTokens) return ps;
    var raw = typeof data === 'string' ? data : JSON.stringify(data) || String(data);
    var cl = raw.slice(0, maxTokens * CPT - 1) + '…';
    if (est(cl) <= maxTokens) return cl;
    throw new BudgetExceededError(est(data), maxTokens);
  }
  globalThis.__mcp_budget = async function budget(maxTokens, fn) {
    var result = await fn();
    return est(result) <= maxTokens ? result : tryTrim(result, maxTokens);
  };
  globalThis.BudgetExceededError = BudgetExceededError;
})();
`;

  const findToolSrc = `
(function injectFindTool() {
  var EMBED_DIM = 256;
  function tokenise(text) { return text.toLowerCase().replace(/[^a-z0-9_.-]/g,' ').split(/\\s+/).filter(Boolean); }
  function hashBucket(s) { var h=5381; for(var i=0;i<s.length;i++){h=((h<<5)+h)^s.charCodeAt(i);h=h>>>0;} return h%EMBED_DIM; }
  function embed(text) {
    var vec = new Float32Array(EMBED_DIM);
    var tokens = tokenise(text);
    if (!tokens.length) return vec;
    for (var i=0;i<tokens.length;i++) vec[hashBucket(tokens[i])]+=1;
    for (var j=0;j<tokens.length-1;j++) vec[hashBucket(tokens[j]+'_'+tokens[j+1])]+=0.5;
    var norm=0; for(var k=0;k<EMBED_DIM;k++) norm+=vec[k]*vec[k]; norm=Math.sqrt(norm);
    if(norm>0) for(var n=0;n<EMBED_DIM;n++) vec[n]/=norm;
    return vec;
  }
  function cosine(a,b) { var d=0; for(var i=0;i<a.length;i++) d+=a[i]*b[i]; return d; }
  var __toolEntries = ${toolsJson}.map(function(e){return{server:e.server,tool:e.tool,description:e.description,vector:embed(e.tool+'\\n'+e.description)};});
  globalThis.__mcp_findTool = async function findTool(query, options) {
    options = options || {};
    var qv = embed(query);
    var topK = options.topK || 5;
    var filter = options.serverFilter;
    var candidates = filter ? __toolEntries.filter(function(e){return filter.includes(e.server);}) : __toolEntries;
    var scored = candidates.map(function(e){return{server:e.server,tool:e.tool,description:e.description,score:cosine(qv,e.vector)};});
    scored.sort(function(a,b){return b.score-a.score;});
    return scored.slice(0,topK);
  };
})();
`;

  const extendMcpSrc = `
if (typeof mcp !== 'undefined') {
  Object.defineProperty(mcp, 'compact',   { value: globalThis.__mcp_compact,   writable: false, configurable: true });
  Object.defineProperty(mcp, 'summarize', { value: globalThis.__mcp_summarize, writable: false, configurable: true });
  Object.defineProperty(mcp, 'delta',     { value: globalThis.__mcp_delta,     writable: false, configurable: true });
  Object.defineProperty(mcp, 'budget',    { value: globalThis.__mcp_budget,    writable: false, configurable: true });
  Object.defineProperty(mcp, 'findTool',  { value: globalThis.__mcp_findTool,  writable: false, configurable: true });
}
`;

  return [
    '// Phase 5 Sandbox Helpers — auto-injected into Deno worker via preloadHelpers[]',
    compactSrc,
    summarizeSrc,
    deltaSrc,
    budgetSrc,
    findToolSrc,
    extendMcpSrc,
  ].join('\n');
}
