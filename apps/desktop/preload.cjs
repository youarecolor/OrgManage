'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const MAX_BYTES = 262_144;

function serialize(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > MAX_BYTES) {
    throw new TypeError('Invalid Home request size');
  }
  return json;
}

if (process.isMainFrame && process.contextIsolated && process.sandboxed) {
  contextBridge.exposeInMainWorld('orgmanageCredentials',Object.freeze({
    status:()=>ipcRenderer.invoke('orgmanage:credentials',{action:'status',key:'',consent:false}),
    check:()=>ipcRenderer.invoke('orgmanage:credentials',{action:'check',key:'',consent:true}),
    save:key=>typeof key==='string'&&key.length<=512?ipcRenderer.invoke('orgmanage:credentials',{action:'save',key,consent:true}):Promise.resolve({ok:false,code:'INVALID_REQUEST'}),
    remove:()=>ipcRenderer.invoke('orgmanage:credentials',{action:'remove',key:'',consent:true}),
  }));
  contextBridge.exposeInMainWorld('orgmanage', Object.freeze({
    snapshot: () => ipcRenderer.invoke('orgmanage:snapshot'),
    setup: value => ipcRenderer.invoke('orgmanage:setup', serialize(value)),
    command: value => ipcRenderer.invoke('orgmanage:command', serialize(value)),
  }));
}
