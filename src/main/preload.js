const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('batteryHub', {
  // devices
  listLiveDevices: () => ipcRenderer.invoke('devices:list-live'),
  listSavedDevices: () => ipcRenderer.invoke('devices:list-saved'),
  addDevice: (payload) => ipcRenderer.invoke('devices:add', payload),
  removeDevice: (id) => ipcRenderer.invoke('devices:remove', id),
  renameDevice: (id, name) => ipcRenderer.invoke('devices:rename', { id, name }),
  setDeviceIcon: (id, icon) => ipcRenderer.invoke('devices:set-icon', { id, icon }),
  setDeviceAlert: (id, threshold) => ipcRenderer.invoke('devices:set-alert', { id, threshold }),
  setDeviceHidden: (id, hidden) => ipcRenderer.invoke('devices:set-hidden', { id, hidden }),
  reorderDevices: (ids) => ipcRenderer.invoke('devices:reorder', ids),
  capture: (id) => ipcRenderer.invoke('devices:capture', id),
  pollNow: () => ipcRenderer.invoke('devices:poll-now'),
  onBatteryUpdate: (cb) => {
    const listener = (evt, data) => cb(data);
    ipcRenderer.on('battery-update', listener);
    return () => ipcRenderer.removeListener('battery-update', listener);
  },

  onDevicesChanged: (cb) => ipcRenderer.on('devices-changed', () => cb()),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // updates / app info
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateEvent: (cb) => {
    const listener = (evt, data) => cb(data);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  runSupportCheck: () => ipcRenderer.invoke('support:run'),
  deviceReport: (request) => ipcRenderer.invoke('support:device-report', request),
  worksReport: (id) => ipcRenderer.invoke('support:works-report', id),
  markReported: (hardware) => ipcRenderer.invoke('support:mark-reported', hardware),

  localTools: () => ipcRenderer.invoke('local-tools:list'),
  runLocalTool: (id) => ipcRenderer.send('local-tools:run', id),

  // tray flyout
  getFlyoutData: () => ipcRenderer.invoke('flyout:data'),
  onFlyoutData: (cb) => ipcRenderer.on('flyout-data', (evt, data) => cb(data)),
  onFlyoutOpen: (cb) => ipcRenderer.on('flyout-open', (evt, animated) => cb(animated)),
  onFlyoutClose: (cb) => ipcRenderer.on('flyout-close', () => cb()),
  hideFlyout: () => ipcRenderer.send('flyout:hide'),
  openApp: () => ipcRenderer.send('flyout:open-app'),

  // window / app
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  quitApp: () => ipcRenderer.send('app:quit'),
});

// CYL Audio Hub: audio, profiles, microphone and binds. One named call per action; the main
// process validates every argument (src/main/cyl.js).
const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
contextBridge.exposeInMainWorld('cyl', {
  snapshot: call('cyl:snapshot'),
  apoStatus: call('cyl:apo-status'),
  apoApply: call('cyl:apo-apply'),
  apoExclusive: call('cyl:apo-exclusive'),
  apoRemove: call('cyl:apo-remove'),
  apoConfigurator: call('cyl:apo-configurator'),
  setEqEnabled: call('cyl:eq-enabled'),
  activateProfile: call('cyl:profile-activate'),
  saveProfile: call('cyl:profile-save'),
  createProfile: call('cyl:profile-create'),
  deleteProfile: call('cyl:profile-delete'),
  resetProfile: call('cyl:profile-reset'),
  orderProfiles: call('cyl:profile-order'),
  exportProfiles: call('cyl:profile-export'),
  importProfiles: call('cyl:profile-import'),
  setTargets: call('cyl:targets'),
  setVolume: call('cyl:volume'),
  setMute: call('cyl:mute'),
  setDefault: call('cyl:default'),
  toggleMic: call('cyl:mic-toggle'),
  audioSettings: call('cyl:audio-settings'),
  processes: call('cyl:procs'),
  binds: call('cyl:binds'),
  setBinds: call('cyl:binds-set'),
  resetBinds: call('cyl:binds-reset'),
  checkBind: call('cyl:binds-check'),
  suspendBinds: call('cyl:binds-suspend'),
  diag: call('cyl:diag'),
  diagReport: call('cyl:diag-report'),
  diagExport: call('cyl:diag-export'),
  onChanged: (cb) => {
    const l = () => cb();
    ipcRenderer.on('cyl-changed', l);
    return () => ipcRenderer.removeListener('cyl-changed', l);
  },
  onNavigate: (cb) => ipcRenderer.on('cyl-navigate', (evt, view) => cb(view)),
});
