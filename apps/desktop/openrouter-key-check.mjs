import {checkOpenRouterKey} from '../../dist/host/src/openrouter-key-check.js';
/** Runs in the same Electron userData context that encrypted the credential. */
export function checkSavedOpenRouterKey(vault,stop){
 return checkOpenRouterKey({withKey:use=>vault.withKey('openrouter',use)},undefined,undefined,stop);
}
