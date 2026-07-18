const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const FileType = require("file-type");

const LISTEN_PORT = 9876;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
}

let mainWindow;
let server;

app.on("second-instance", () => {
	if (mainWindow) {
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	}
});

// ─── Bridge Server ──────────────────────────────────────────
function startBridgeServer() {
  if (server) return;

  server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/place-id") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          const placeId = String(data.placeId || "").trim();
          if (placeId && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("place-id-received", { placeId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Invalid placeId" }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/game-instances") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("instances-received", data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "Window not available" }));
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${LISTEN_PORT} is already in use.`);
    } else {
      console.error("HTTP server error:", e);
    }
  });

  server.listen(LISTEN_PORT, "127.0.0.1", () => {
    console.log(`Executor bridge listening on http://localhost:${LISTEN_PORT}`);
  });
}

function stopBridgeServer() {
  if (server) {
    server.close();
    server = null;
    console.log("Executor bridge stopped");
  }
}

const settingsPath = path.join(app.getPath("userData"), "settings.json");
const historyPath = path.join(app.getPath("userData"), "history.json");

// ─── Settings ───────────────────────────────────────────────
function loadSettings() {
	try {
		const data = fs.readFileSync(settingsPath, "utf-8");
		return JSON.parse(data);
	} catch {
		return { downloadPath: app.getPath("downloads"), bridgeEnabled: false };
	}
}

function saveSettings(settings) {
	try {
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	} catch (e) {
		console.error("Failed to save settings:", e);
	}
}

// ─── History ────────────────────────────────────────────────
function loadHistory() {
	try {
		const data = fs.readFileSync(historyPath, "utf-8");
		return JSON.parse(data);
	} catch {
		return [];
	}
}

function saveHistory(history) {
	try {
		if (history.length > 200) history = history.slice(0, 200);
		fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
	} catch (e) {
		console.error("Failed to save history:", e);
	}
}

// ─── Window ─────────────────────────────────────────────────
app.on("ready", () => {
	mainWindow = new BrowserWindow({
		width: 820,
		height: 560,
		minWidth: 700,
		minHeight: 440,
		frame: true,
		backgroundColor: "#f0f0f0",
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			webSecurity: false,
			preload: path.join(__dirname, "src/preload.js"),
		},
	});

	Menu.setApplicationMenu(null);

	mainWindow.loadFile("src/index.html");

		// ─── Local HTTP Server for executor communication ─────────
		const settings = loadSettings();
		if (settings.bridgeEnabled !== false) {
			startBridgeServer();
		}
});

// Window controls
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
	if (mainWindow?.isMaximized()) mainWindow.unmaximize();
	else mainWindow?.maximize();
});
ipcMain.on("window-close", () => mainWindow?.close());

// ─── Bridge Status IPC ──────────────────────────────────────
ipcMain.handle("get-bridge-status", () => {
	const settings = loadSettings();
	return {
		port: LISTEN_PORT,
		listening: !!server,
		bridgeEnabled: settings.bridgeEnabled !== false,
	};
});

ipcMain.handle("set-bridge-enabled", (event, enabled) => {
	const settings = loadSettings();
	settings.bridgeEnabled = enabled;
	saveSettings(settings);
	if (enabled) {
		startBridgeServer();
	} else {
		stopBridgeServer();
	}
	return { bridgeEnabled: enabled, listening: !!server, port: LISTEN_PORT };
});

// ─── Settings IPC ───────────────────────────────────────────
ipcMain.handle("get-settings", () => loadSettings());

ipcMain.handle("set-settings", (event, settings) => {
	const current = loadSettings();
	const updated = { ...current, ...settings };
	saveSettings(updated);
	return updated;
});

ipcMain.handle("select-folder", async () => {
	const result = await dialog.showOpenDialog(mainWindow, {
		properties: ["openDirectory"],
	});
	if (result.canceled) return { cancelled: true };
	return { path: result.filePaths[0] };
});

// ─── History IPC ────────────────────────────────────────────
ipcMain.handle("history-load", () => loadHistory());

ipcMain.handle("history-add", (event, entry) => {
	const history = loadHistory();
	history.unshift(entry);
	saveHistory(history);
	return true;
});

ipcMain.handle("history-clear", () => {
		saveHistory([]);
		return true;
	});

// ─── Asset Name Lookup ─────────────────────────────────────
const assetNameCache = new Map();

ipcMain.handle("get-asset-name", async (_event, { assetId }) => {
	if (assetNameCache.has(assetId)) {
		return { name: assetNameCache.get(assetId) };
	}
	try {
		const res = await fetch(
			`https://economy.roblox.com/v2/assets/${assetId}/details`,
			{ headers: { "User-Agent": "Roblox" } }
		);
		if (res.ok) {
			const data = await res.json();
			const name = data.Name || null;
			if (name) assetNameCache.set(assetId, name);
			return { name };
		}
	} catch (e) {
		console.error("Failed to fetch asset name:", e);
	}
	return { name: null };
});

// ─── Audio Preview (fetch with auth in main process) ────────
ipcMain.handle("get-audio-preview", async (_event, { assetId, cookie, placeId }) => {
	try {
		const url = `https://assetdelivery.roblox.com/v1/asset?id=${assetId}`;
		const response = await fetch(url, {
			headers: {
				"User-Agent": "Roblox/WinInet",
				Cookie: ".ROBLOSECURITY=" + (cookie || ""),
				"Roblox-Place-Id": placeId || "",
			},
		});

		if (!response.ok) {
			return { success: false, error: `HTTP ${response.status}` };
		}

		const buffer = Buffer.from(await response.arrayBuffer());

		// Detect MIME type
		let mime = "audio/ogg";
		try {
			const type = await FileType.fromBuffer(buffer);
			if (type) mime = type.mime;
		} catch {}

		// Check if it's actually audio (not a model/wrapper)
		const magicStr = buffer.slice(0, 7).toString();
		if (magicStr === "<roblox" || magicStr.startsWith("<?xml")) {
			return { success: false, error: "Asset is not direct audio (may be wrapped)" };
		}

		const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
		return { success: true, dataUrl };
	} catch (error) {
		console.error("Audio preview error:", error);
		return { success: false, error: error.message };
	}
});

ipcMain.handle("open-in-explorer", (event, { filePath }) => {
	shell.showItemInFolder(filePath);
	return true;
});

// ─── Download IPC ───────────────────────────────────────────
ipcMain.handle(
	"download-request",
	async (event, { url, userAgent, robloSecurity, robloxPlaceId, downloadId }) => {
		try {
			const settings = loadSettings();
			const downloadsPath = settings.downloadPath || app.getPath("downloads");
			const assetId = url.split("=").pop();

			const response = await fetch(url, {
				headers: {
					"User-Agent": userAgent,
					Cookie: ".ROBLOSECURITY=" + robloSecurity,
					"Roblox-Place-Id": robloxPlaceId,
				},
			});

			if (!response.ok) {
				let errorData;
				try {
					const body = JSON.parse(await response.text());
					errorData = {
						status: response.status,
						message: body.errors?.[0]?.message || "Unknown error",
						code: body.errors?.[0]?.customErrorCode ?? body.errors?.[0]?.code ?? "UNKNOWN",
					};
				} catch {
					errorData = {
						status: response.status,
						message: response.statusText,
						code: "UNKNOWN",
					};
				}
				return { success: false, error: errorData };
			}

			// Stream download with progress
			const contentLength = parseInt(response.headers.get("content-length") || "0");
			let receivedLength = 0;
			let buffer;

			if (response.body && typeof response.body.getReader === "function") {
				const reader = response.body.getReader();
				const chunks = [];
				let lastProgressSent = 0;

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(Buffer.from(value));
					receivedLength += value.length;

					// Throttle progress events to every 100ms
					const now = Date.now();
					if (now - lastProgressSent > 100 || receivedLength === contentLength) {
						try {
							event.sender.send("download-progress", {
								downloadId,
								received: receivedLength,
								total: contentLength,
							});
						} catch {}
						lastProgressSent = now;
					}
				}
				buffer = Buffer.concat(chunks);
			} else {
				// Fallback
				buffer = Buffer.from(await response.arrayBuffer());
				try {
					event.sender.send("download-progress", {
						downloadId,
						received: buffer.length,
						total: buffer.length,
					});
				} catch {}
			}

			// Detect file type
			const magicBytes = buffer.slice(0, 8).toString();
			let extension;

			if (magicBytes === "<roblox!") {
				extension = "rbxm";
			} else if (magicBytes.startsWith("<roblox")) {
				extension = "rbxmx";
			} else {
				const type = await FileType.fromBuffer(buffer);
				extension = type ? type.ext : "bin";
			}

			const fileName = `${assetId}.${extension}`;
			const filePath = path.join(downloadsPath, fileName);
			await fs.promises.writeFile(filePath, buffer);

			return {
				success: true,
				filePath,
				fileName,
				fileSize: buffer.length,
				assetId,
			};
		} catch (error) {
			console.error("Download error:", error);
			return {
				success: false,
				error: {
					status: 0,
					message: error.message,
					code: "EXCEPTION",
				},
			};
		}
	}
);

// ─── Save Failed Assets ─────────────────────────────────────
ipcMain.handle("save-failed-assets", async (event, { params, content }) => {
	try {
		const settings = loadSettings();
		const downloadsPath = settings.downloadPath || app.getPath("downloads");
		let crc;
		try {
			crc = zlib.crc32(params).toString(16);
		} catch {
			crc = Math.random().toString(16).slice(2, 10);
		}
		const fileName = `FailedAssets_${crc}.txt`;
		const filePath = path.join(downloadsPath, fileName);
		await fs.promises.writeFile(filePath, content);
		return filePath;
	} catch (error) {
		console.error("Save error:", error);
		throw error;
	}
});

app.on("window-all-closed", () => {
	if (server) server.close();
	app.quit();
});
