import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import canonicalize from 'canonicalize';
import type { Command } from './generated/command.js';
import type { SetupRequest } from './generated/setup-request.js';
import type { CommandReceipt } from './generated/command-receipt.js';
import type { ExecutionEvidence } from './generated/execution-evidence.js';
import { SCHEMA_DIGESTS } from './generated/schema-digests.js';
import { failure, strictJson, WIRE_LIMITS } from './wire.js';
import type { WireFailure } from './wire.js';

export { strictJson, parseRevision, formatRevision, WIRE_LIMITS } from './wire.js';
export type { WireErrorCode, WireFailure } from './wire.js';
export type { Command, SetupRequest, CommandReceipt, ExecutionEvidence };

export type DeepReadonly<T> = T extends object
  ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export type SyntaxResult<T> = WireFailure | Readonly<{
  ok: true;
  validation: 'syntax_only';
  value: DeepReadonly<T>;
  canonical: string;
  digest: string;
}>;

// Only locally bundled, developer-controlled schemas. No caller-supplied schemas or remote refs.
const ajv = new Ajv2020({
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  allErrors: false,
  validateFormats: true,
  unicodeRegExp: true,
});

function validator<T>(basename: keyof typeof SCHEMA_DIGESTS): ValidateFunction<T> {
  // This module runs from dist/contracts/src. Schemas remain bundled project source for I1-P01.
  const path = new URL(`../../../packages/contracts/schema/${basename}.schema.json`, import.meta.url);
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== SCHEMA_DIGESTS[basename]) {
    throw new Error(`Bundled schema hash mismatch with generated declarations: ${basename}`);
  }
  const schema: object = JSON.parse(bytes.toString('utf8')) as object;
  return ajv.compile<T>(schema);
}

const commandValidator = validator<Command>('command');
const setupValidator = validator<SetupRequest>('setup-request');
const receiptValidator = validator<CommandReceipt>('command-receipt');
const evidenceValidator = validator<ExecutionEvidence>('execution-evidence');

function hasOversizeText(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const limit = key === 'raw_text' ? WIRE_LIMITS.rawTextBytes
        : key === 'comment' ? WIRE_LIMITS.commentBytes : undefined;
      if (limit !== undefined && Buffer.byteLength(child, 'utf8') > limit) return true;
    }
    if (hasOversizeText(child)) return true;
  }
  return false;
}

function freezeTree<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function decode<T>(input: Uint8Array, validate: ValidateFunction<T>): SyntaxResult<T> {
  const parsed = strictJson(input);
  if (!parsed.ok) return parsed;
  if (!validate(parsed.value)) return failure('SCHEMA_INVALID');
  if (hasOversizeText(parsed.value)) return failure('TEXT_BYTE_LIMIT');
  // Schema and Unicode checks precede fingerprints. This is content identity, never authority.
  const canonical = canonicalize(parsed.value);
  if (typeof canonical !== 'string') throw new Error('Bundled schema admitted non-JSON data');
  return Object.freeze({
    ok: true,
    validation: 'syntax_only' as const,
    value: freezeTree(parsed.value),
    canonical,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  });
}

export const decodeCommand = (input: Uint8Array): SyntaxResult<Command> => decode(input, commandValidator);
export const decodeSetup = (input: Uint8Array): SyntaxResult<SetupRequest> => decode(input, setupValidator);
/** Checks serialized receipt shape only; cannot mint a persistent ledger receipt. */
export const decodeReceipt = (input: Uint8Array): SyntaxResult<CommandReceipt> => decode(input, receiptValidator);
/** Observations require later trusted reference/route verification; this grants no retry permission. */
export const decodeExecutionEvidence = (input: Uint8Array): SyntaxResult<ExecutionEvidence> => decode(input, evidenceValidator);
