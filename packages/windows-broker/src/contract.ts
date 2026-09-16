import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {strictJson} from '../../contracts/src/wire.js';

export const MAX_REQUEST_BYTES = 4096;
export interface RestartOperation {
  readonly kind: 'registered_service.restart';
  readonly resourceId: string;
  readonly configurationDigest: string;
}
export interface BrokerRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly permitId: string;
  readonly operation: RestartOperation;
  readonly timeoutMs: number;
}
export type DecodeResult = {ok: true; request: BrokerRequest; digest: string} | {ok: false; code: string};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
export function isId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
export function isDigest(value: unknown): value is string { return typeof value === 'string' && sha.test(value); }
export function contentDigest(value: object): string {
  return createHash('sha256').update(canonicalize(value)!).digest('hex');
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** Syntax/content identity only. No client field supplies an OS identity or authority. */
export function decodeBrokerRequest(bytes: Uint8Array): DecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REQUEST_BYTES) return {ok: false, code: 'INPUT_LIMIT'};
  const parsed = strictJson(bytes);
  if (!parsed.ok) return {ok: false, code: parsed.error.code};
  const value = parsed.value;
  if (!exact(value, ['version', 'requestId', 'permitId', 'operation', 'timeoutMs'])
    || value.version !== 1 || !isId(value.requestId) || !isId(value.permitId)
    || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 30_000
    || !exact(value.operation, ['kind', 'resourceId', 'configurationDigest'])
    || value.operation.kind !== 'registered_service.restart' || !isId(value.operation.resourceId)
    || !isDigest(value.operation.configurationDigest)) return {ok: false, code: 'SCHEMA_INVALID'};
  const request = Object.freeze({...value, operation: Object.freeze({...value.operation})}) as unknown as BrokerRequest;
  return {ok: true, request, digest: contentDigest(request)};
}
/** This digest is bound by both approvals; requestId/permitId are transport references. */
export function actionDigest(operation: RestartOperation, timeoutMs: number): string {
  return contentDigest({operation, timeoutMs});
}
