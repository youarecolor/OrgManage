export {decodeBrokerRequest, actionDigest, MAX_REQUEST_BYTES} from './contract.js';
export type {BrokerRequest, RestartOperation} from './contract.js';

export const WINDOWS_PRIVILEGES_ENABLED = false as const;
/** Production surface has no activation switch, transport, executor or enrollment API.
 * Simulation is a separate import and cannot be selected by input, environment or UI. */
export function createWindowsPrivilegePort() {
  return Object.freeze({
    enabled: WINDOWS_PRIVILEGES_ENABLED,
    request: (_input: Uint8Array) => Object.freeze({
      ok: false as const, code: 'WINDOWS_PRIVILEGES_DISABLED' as const, retry: 'none' as const,
    }),
  });
}
