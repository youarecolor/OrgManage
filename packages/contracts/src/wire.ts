import { createScanner, ScanError, SyntaxKind, visit } from 'jsonc-parser';

export const WIRE_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 16,
  rawTextBytes: 64 * 1024,
  commentBytes: 16 * 1024,
});

export type WireErrorCode =
  | 'INVALID_INPUT' | 'INVALID_UTF8' | 'INVALID_JSON' | 'DUPLICATE_KEY'
  | 'DEPTH_LIMIT' | 'BYTE_LIMIT' | 'INVALID_UNICODE'
  | 'SCHEMA_INVALID' | 'TEXT_BYTE_LIMIT';
export type WireFailure = Readonly<{ ok: false; error: Readonly<{ code: WireErrorCode }> }>;
export type ParseResult = Readonly<{ ok: true; value: unknown }> | WireFailure;

export function failure(code: WireErrorCode): WireFailure {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

/** Decode bytes before JSON parsing. No object-input shortcut or forgiving parser output. */
export function strictJson(input: Uint8Array): ParseResult {
  return parseBoundedJson(input, WIRE_LIMITS.maxBytes);
}

/** Public service metadata only. Command/IPC decoders continue using strictJson. */
export function strictMetadataJson(input: Uint8Array): ParseResult {
  return parseBoundedJson(input, 4 * 1024 * 1024);
}

function parseBoundedJson(input: Uint8Array, maxBytes: number): ParseResult {
  if (!(input instanceof Uint8Array)) return failure('INVALID_INPUT');
  if (input.byteLength > maxBytes) return failure('BYTE_LIMIT');
  // Shared memory is not a stable wire message. Transports must deliver a private snapshot.
  if (input.buffer instanceof SharedArrayBuffer) return failure('INVALID_INPUT');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return failure('INVALID_UTF8');
  }
  if (source.charCodeAt(0) === 0xfeff) return failure('INVALID_JSON');

  // The scanner is iterative: reject a depth bomb before the recursive visitor runs.
  // Root object/array has depth 1; scalars do not add a level.
  const scanner = createScanner(source, false);
  let depth = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (scanner.getTokenError() !== ScanError.None
        || token === SyntaxKind.Unknown
        || token === SyntaxKind.LineCommentTrivia
        || token === SyntaxKind.BlockCommentTrivia) return failure('INVALID_JSON');
    if (token === SyntaxKind.StringLiteral && !scanner.getTokenValue().isWellFormed()) {
      return failure('INVALID_UNICODE');
    }
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      if (++depth > WIRE_LIMITS.maxDepth) return failure('DEPTH_LIMIT');
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      if (--depth < 0) return failure('INVALID_JSON');
    }
  }
  if (depth !== 0 || scanner.getTokenError() !== ScanError.None) return failure('INVALID_JSON');

  let invalid = false;
  let duplicate = false;
  const objectKeys: Set<string>[] = [];
  visit(source, {
    onObjectBegin: () => { objectKeys.push(new Set()); },
    onObjectProperty: (key) => {
      const keys = objectKeys.at(-1);
      if (!keys) { invalid = true; return; }
      if (keys.has(key)) duplicate = true;
      keys.add(key);
    },
    onObjectEnd: () => { objectKeys.pop(); },
    onError: () => { invalid = true; },
    onLiteralValue: (value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) invalid = true;
    },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (invalid) return failure('INVALID_JSON');
  if (duplicate) return failure('DUPLICATE_KEY');
  try {
    // JSON.parse creates own data properties, including __proto__, without assignment setters.
    return Object.freeze({ ok: true, value: JSON.parse(source) as unknown });
  } catch {
    return failure('INVALID_JSON');
  }
}

const revisionPattern = /^[1-9][0-9]{0,17}(?![\s\S])/;
const revisionMaximum = 999999999999999999n;

/** Wire/DB integer boundary; never pass revisions through Number. */
export function parseRevision(value: string): bigint {
  if (typeof value !== 'string' || !revisionPattern.test(value)) {
    throw new RangeError('Revision must be a positive decimal string of 1 to 18 digits');
  }
  return BigInt(value);
}

export function formatRevision(value: bigint): string {
  if (typeof value !== 'bigint' || value < 1n || value > revisionMaximum) {
    throw new RangeError('Revision is outside the wire range');
  }
  return value.toString(10);
}
