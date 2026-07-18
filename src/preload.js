const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
	ipcRenderer: {
		invoke: (channel, data) => ipcRenderer.invoke(channel, data),
		on: (channel, callback) => {
			const handler = (event, ...args) => callback(...args);
			ipcRenderer.on(channel, handler);
			return () => ipcRenderer.removeListener(channel, handler);
		},
	},
});

contextBridge.exposeInMainWorld('windowControls', {
	minimize: () => ipcRenderer.send('window-minimize'),
	maximize: () => ipcRenderer.send('window-maximize'),
	close: () => ipcRenderer.send('window-close'),
});
