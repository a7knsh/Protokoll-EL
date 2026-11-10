'use strict';
// Schmale, explizite Brücke zwischen Oberfläche und Hauptprozess.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getProfile: call('profile:get'),
  setProfile: call('profile:set'),
  listTemplates: call('templates:list'),
  saveTemplate: call('templates:save'),
  deleteTemplate: call('templates:delete'),
  setDirty: call('dirty:set'),
  startFile: call('app:startFile'),
  openDoc: call('doc:open'),
  saveDoc: call('doc:save'),
  pickImages: call('file:pickImages'),
  pickText: call('file:pickText'),
  exportHtml: call('export:html'),
  exportPdf: call('export:pdf'),
  showFile: call('shell:showFile'),
  kicadImport: call('kicad:import'),
});
