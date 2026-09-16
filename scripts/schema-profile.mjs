/** Trusted build-time subset guard. This is not a JSON Schema compiler. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const END = "(?![\\s\\S])";
const PATTERNS = new Set([
  `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
  `^[1-9][0-9]{0,17}${END}`,
  `^[0-9a-f]{64}${END}`,
  `^[A-Za-z0-9_-]{32,256}${END}`,
  // USD: at most nine whole and nine fractional digits, closed input boundary.
  `^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,9})?${END}`,
]);
const ANNOTATIONS = ["title", "description"];
const ROOT_KEYS = ["$schema", "$id", "$defs"];
const DANGEROUS_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export class SchemaProfileError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "SchemaProfileError";
    this.path = path;
  }
}

/** Reject unknown syntax before the existing generator or Ajv can interpret it. */
export function assertSchemaProfile(schema) {
  const fail = (path, message) => { throw new SchemaProfileError(path, message); };
  if (!plain(schema)) fail("#", "schema must be an object");
  if (schema.$schema !== SCHEMA_DIALECT) fail("#/$schema", "unsupported dialect");
  if (typeof schema.title !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(schema.title)) {
    fail("#/title", "root requires an exported type name");
  }
  if (typeof schema.$id !== "string" || !/^urn:orgmanage:i1-p01:[A-Za-z0-9]+:0\.1$/.test(schema.$id)) {
    fail("#/$id", "unsupported bundled schema identity");
  }
  const definitions = schema.$defs ?? {};
  if (!plain(definitions)) fail("#/$defs", "definitions must be an object");
  for (const key of Object.keys(definitions)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || DANGEROUS_NAMES.has(key)) fail("#/$defs", "invalid definition name");
  }
  let visited = 0;
  const refs = [];
  const active = new Set();
  function visit(node, path, root = false, depth = 0) {
    if (++visited > 4096 || depth > 64) fail(path, "schema complexity exceeds profile");
    if (!plain(node)) fail(path, "boolean and non-object schemas are unsupported");
    if (active.has(node)) fail(path, "cyclic schema objects are unsupported");
    active.add(node);
    const shapeKeys = own(node, "$ref") ? ["$ref"]
      : own(node, "oneOf") ? ["oneOf"]
      : own(node, "anyOf") ? ["anyOf"]
      : node.type === "object" ? ["type", "properties", "required", "additionalProperties"]
      : node.type === "array" ? ["type", "items", "minItems", "maxItems"]
      : ["type", "enum", "const", "pattern", "minLength", "maxLength"];
    const allowed = new Set([...ANNOTATIONS, ...(root ? ROOT_KEYS : []), ...shapeKeys]);
    for (const key of Object.keys(node)) if (!allowed.has(key)) fail(`${path}/${key}`, "unsupported keyword or mixed schema shape");
    for (const key of ANNOTATIONS) if (own(node, key) && typeof node[key] !== "string") fail(`${path}/${key}`, "annotation must be text");
    if (own(node, "$ref")) {
      if (typeof node.$ref !== "string" || !/^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/.test(node.$ref)) {
        fail(`${path}/$ref`, "only direct in-document definitions are supported");
      }
      const name = node.$ref.slice("#/$defs/".length);
      if (!own(definitions, name)) fail(`${path}/$ref`, "unresolved local reference");
      refs.push({ from: path, name });
    } else if (own(node, "oneOf") || own(node, "anyOf")) {
      const key = own(node, "oneOf") ? "oneOf" : "anyOf";
      if (!Array.isArray(node[key]) || node[key].length < 2 || node[key].length > 32) fail(`${path}/${key}`, "union must contain 2 to 32 branches");
      node[key].forEach((child, index) => visit(child, `${path}/${key}/${index}`, false, depth + 1));
    } else if (node.type === "object") {
      if (node.additionalProperties !== false) fail(path, "all objects must be closed");
      if (!plain(node.properties) || !Array.isArray(node.required)) fail(path, "properties and required are mandatory");
      const keys = Object.keys(node.properties);
      if (node.required.length !== keys.length || new Set(node.required).size !== keys.length
        || node.required.some((key) => typeof key !== "string" || !own(node.properties, key))) {
        fail(`${path}/required`, "every declared property must be required exactly once");
      }
      for (const key of keys) {
        if (!/^[a-z][a-z0-9_]*$/.test(key) || DANGEROUS_NAMES.has(key)) fail(`${path}/properties`, "unsupported property name");
        visit(node.properties[key], `${path}/properties/${key}`, false, depth + 1);
      }
    } else if (node.type === "array") {
      if (!Number.isSafeInteger(node.minItems) || !Number.isSafeInteger(node.maxItems)
        || node.minItems < 0 || node.maxItems < node.minItems || node.maxItems > 32) fail(path, "array requires explicit bounds within 0 to 32");
      visit(node.items, `${path}/items`, false, depth + 1);
    } else {
      const nullableText = Array.isArray(node.type) && node.type.length === 2 && node.type[0] === "string" && node.type[1] === "null";
      if (!["string", "integer", "null"].includes(node.type) && !nullableText) fail(`${path}/type`, "unsupported scalar type syntax");
      const isText = node.type === "string" || nullableText;
      if (!isText && ["pattern", "minLength", "maxLength"].some((key) => own(node, key))) fail(path, "text keywords on a non-text type");
      if (node.type === "integer" && node.const !== 1) fail(path, "only protocol integer constant 1 is supported; revisions use strings");
      if (own(node, "enum") && own(node, "const")) fail(path, "enum and const cannot be mixed in this profile");
      const scalarFits = (value) => node.type === "string" ? typeof value === "string"
        : node.type === "integer" ? value === 1 : node.type === "null" ? value === null
        : typeof value === "string" || value === null;
      if (own(node, "const") && !scalarFits(node.const)) fail(`${path}/const`, "constant does not match scalar type");
      if (own(node, "enum") && (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 32
        || node.enum.some((value) => !scalarFits(value)) || new Set(node.enum).size !== node.enum.length)) fail(`${path}/enum`, "invalid scalar enum");
      if (own(node, "pattern") && !PATTERNS.has(node.pattern)) fail(`${path}/pattern`, "pattern is not in the reviewed bundled allowlist");
      for (const key of ["minLength", "maxLength"]) {
        if (own(node, key) && (!Number.isSafeInteger(node[key]) || node[key] < 0 || node[key] > 65536)) fail(`${path}/${key}`, "invalid text bound");
      }
      if (own(node, "minLength") && own(node, "maxLength") && node.minLength > node.maxLength) fail(path, "reversed text bounds");
      if (isText && !own(node, "maxLength") && !own(node, "enum") && !own(node, "const")) fail(path, "text must have a finite bound or literal choices");
    }
    if (root) for (const [key, value] of Object.entries(definitions)) visit(value, `#/$defs/${key}`, false, depth + 1);
    active.delete(node);
  }
  visit(schema, "#", true);
  const edges = new Map(Object.keys(definitions).map((name) => [name, []]));
  for (const { from, name } of refs) {
    const origin = /^#\/\$defs\/([^/]+)/.exec(from)?.[1];
    if (origin !== undefined) edges.get(origin).push(name);
  }
  const resolved = new Set();
  const resolving = new Set();
  function resolve(name) {
    if (resolving.has(name)) fail(`#/$defs/${name}`, "recursive references are unsupported");
    if (resolved.has(name)) return;
    resolving.add(name);
    for (const target of edges.get(name)) resolve(target);
    resolving.delete(name);
    resolved.add(name);
  }
  for (const name of edges.keys()) resolve(name);
  return schema;
}
