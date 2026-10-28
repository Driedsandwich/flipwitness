import { rewriteImports } from '../core/runner.browser.imports.mjs';

// Supplied docs snapshot: https://docs.tokenfactory.nebius.com/ai-models-inference/json.md
export function responseFormat(schema, schemaStyle = process.env.PW_SCHEMA_STYLE ?? 'openai') {
  switch (schemaStyle) {
    case 'nebius_doc': return { type: 'json_schema', json_schema: schema };
    case 'openai': return { type: 'json_schema', json_schema: { name: 'patchwitness', schema, strict: true } };
    case 'json_object': return { type: 'json_object' };
    case 'none': return undefined;
    default: throw new Error('Invalid schema style');
  }
}

export function parseJSON(content) {
  const source = content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '').trim();
  try { return JSON.parse(source); } catch { /* Try a fenced answer or a balanced object. */ }
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* Fall through. */ } }
  const start = source.indexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('Invalid JSON object');
}

export function validate(value, schema, path = '$') {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) {
    return [`${path}: expected ${types.join('|')}`];
  }
  if (type === 'number' && !Number.isFinite(value)) errors.push(`${path}: nonfinite number`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum`);
  if (type === 'string' && value.length > schema.maxLength) errors.push(`${path}: maxLength ${schema.maxLength}`);
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${path}: item count`);
    value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validate(value[key], schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: additional property`);
    }
  }
  return errors;
}

export function staticGate(source) {
  const reasons = [];
  if (typeof source !== 'string') return ['tests_source must be a string'];
  if (new TextEncoder().encode(source).length > 8192) reasons.push('tests_source exceeds 8 KB');
  for (const [label, regex] of [
    ['process', /\bprocess\b/], ['require', /\brequire\b/], ['fetch', /\bfetch\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/], ['WebSocket', /\bWebSocket\b/],
    ['importScripts', /\bimportScripts\b/], ['import(', /\bimport\s*(?:\/\*[\s\S]*?\*\/\s*)?\(/],
    ['eval', /\beval\b/], ['Function(', /\bFunction\s*\(/], ['globalThis', /\bglobalThis\b/],
    ['self.', /\bself\s*\./], ['postMessage', /\bpostMessage\b/],
    // Mirror the browser runner's disabled globals, plus the usual route back to Function.
    ['EventSource', /\bEventSource\b/], ['Worker', /\b(?:Shared)?Worker\b/],
    ['WebTransport', /\bWebTransport\b/], ['constructor', /\bconstructor\b/],
  ]) if (regex.test(source)) reasons.push(`Forbidden token: ${label}`);
  try {
    rewriteImports(source, specifier => {
      if (!['@entry', '@patchwitness/harness'].includes(specifier)) throw new Error('imports must use @entry or @patchwitness/harness');
      return specifier;
    });
  } catch (error) { reasons.push(`Unsupported import or syntax: ${error.message || 'imports must use @entry or @patchwitness/harness'}`); }
  // Conservative lexical check: comments/strings are removed for registration detection.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' ');
  if (!/\btest\s*\(/.test(code)) reasons.push('No test( calls');
  return reasons;
}

export class OutputError extends Error {
  constructor(errors) { super('Model output failed validation'); this.code = 'upstream_error'; this.errors = errors; }
}
export async function structuredComplete(client, request, schema, { schemaStyle, gate = () => [] } = {}) {
  let messages = request.messages;
  let errors;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.complete({ ...request, messages, responseFormat: responseFormat(schema, schemaStyle) });
    let value;
    try { value = parseJSON(result.content); errors = validate(value, schema); }
    catch { errors = ['Return a valid JSON object']; }
    if (!errors.length) errors = gate(value);
    if (!errors.length) return { data: value, model: result.model, rateHeaders: result.rateHeaders };
    // Do not echo raw provider content into errors, logs, or repair prompts.
    messages = [...request.messages, { role: 'user', content: `Repair your answer. Return the entire JSON object. Errors: ${errors.join('; ')}` }];
  }
  throw new OutputError(errors);
}
