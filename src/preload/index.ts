import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceApi, WorkspaceEvent } from '../shared/types';

const api: WorkspaceApi = {
  snapshot: () => ipcRenderer.invoke('workspace:snapshot'),
  chooseRoot: () => ipcRenderer.invoke('workspace:choose-root'),
  setMainFile: (id, file) => ipcRenderer.invoke('workspace:main-file', id, file),
  files: (id) => ipcRenderer.invoke('workspace:files', id),
  read: (id, file) => ipcRenderer.invoke('workspace:read', id, file),
  save: (id, file, content, revision) => ipcRenderer.invoke('workspace:save', id, file, content, revision),
  discardDraft: (id, file) => ipcRenderer.invoke('workspace:discard-draft', id, file),
  importFiles: (id) => ipcRenderer.invoke('workspace:import', id),
  openExternal: (id, target) => ipcRenderer.invoke('workspace:external', id, target),
  send: (id, text) => ipcRenderer.invoke('workspace:send', id, text),
  stop: (id) => ipcRenderer.invoke('workspace:stop', id),
  newConversation: (id) => ipcRenderer.invoke('workspace:new', id),
  selectConversation: (id, conversation) => ipcRenderer.invoke('workspace:conversation', id, conversation),
  approve: (id, approval, option) => ipcRenderer.invoke('workspace:approve', id, approval, option),
  flushed: (requestId, success) => ipcRenderer.invoke('workspace:flushed', requestId, success),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceEvent) => callback(payload);
    ipcRenderer.on('workspace:event', listener);
    return () => { ipcRenderer.removeListener('workspace:event', listener); };
  },
};

contextBridge.exposeInMainWorld('workspace', api);
