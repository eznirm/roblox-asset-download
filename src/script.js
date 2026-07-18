/* ═══════════════════════════════════════════════════════════
   Asset Downloader — Renderer Logic
   ═══════════════════════════════════════════════════════════ */

// ─── State ──────────────────────────────────────────────────
let isDownloading = false;
let downloadCancelled = false;
let downloadIdCounter = 0;

// ─── DOM ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const cookieInput = $("cookie");
const rememberCheckbox = $("rememberCookie");
const placeIdInput = $("placeId");
const assetIdsInput = $("assetIds");
const downloadBtn = $("downloadBtn");
const downloadBtnText = $("downloadBtnText");
const downloadSection = $("downloadSection");
const downloadSummaryText = $("downloadSummaryText");
const overallProgress = $("overallProgress");
const downloadList = $("downloadList");
const historyList = $("historyList");
const toastContainer = $("toastContainer");
const statusText = $("statusText");

// ─── Utilities ──────────────────────────────────────────────
function parseIds(text) {
	return text
		.split(/[\n,\s]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => s.replace(/\D+/g, ""))
		.filter((s) => s.length > 0);
}

function formatSize(bytes) {
	if (!bytes || bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatTime(ts) {
	const d = new Date(ts);
	return d.toLocaleString();
}

function updateStatus(text) {
		statusText.textContent = text;
	}

	function debounce(fn, delay) {
		let timer;
		return function(...args) {
			clearTimeout(timer);
			timer = setTimeout(() => fn.apply(this, args), delay);
		};
	}

// ─── Toast ──────────────────────────────────────────────────
const toastIcons = {
	success: "\u2713",
	error: "\u2717",
	warning: "!",
	info: "i",
};

function showToast(type, message, duration = 4000) {
	const toast = document.createElement("div");
	toast.className = `toast toast-${type}`;
	toast.innerHTML = `<span class="toast-icon">${toastIcons[type] || ""}</span><span class="toast-msg">${message}</span>`;
	toastContainer.appendChild(toast);
	setTimeout(() => {
		toast.classList.add("toast-out");
		setTimeout(() => toast.remove(), 150);
	}, duration);
}

// ─── Tab Navigation ────────────────────────────────────────
document.querySelectorAll(".tab").forEach((btn) => {
	btn.addEventListener("click", () => {
		const page = btn.dataset.page;
		document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
		$(`page-${page}`).classList.add("active");
		if (page === "history") {
			loadHistory();
			updateStatus("History");
		} else if (page === "settings") {
			updateStatus("Settings");
		} else if (page === "explorer") {
			updateStatus(explorerData ? `Explorer: ${explorerAssetCount} assets` : "Explorer — waiting for data");
		} else {
			updateStatus(isDownloading ? "Downloading..." : "Ready");
		}
	});
});

// ─── Cookie Persistence ────────────────────────────────────
function initCookie() {
	const remember = localStorage.getItem("rememberCookie") === "true";
	const saved = localStorage.getItem("robloxCookie");
	if (remember && saved) {
		cookieInput.value = saved;
		rememberCheckbox.checked = true;
	}
}

rememberCheckbox.addEventListener("change", () => {
	if (rememberCheckbox.checked) {
		localStorage.setItem("rememberCookie", "true");
		localStorage.setItem("robloxCookie", cookieInput.value);
	} else {
		localStorage.setItem("rememberCookie", "false");
		localStorage.removeItem("robloxCookie");
	}
});

cookieInput.addEventListener("input", () => {
	if (rememberCheckbox.checked) {
		localStorage.setItem("robloxCookie", cookieInput.value);
	}
});

// ─── Settings ───────────────────────────────────────────────
let currentConcurrency = 3;

async function initSettings() {
	try {
		const settings = await window.electron.ipcRenderer.invoke("get-settings");
		$("downloadPath").value = settings.downloadPath || "";
	} catch (e) {
		console.error("Failed to load settings:", e);
	}
	currentConcurrency = parseInt(localStorage.getItem("concurrency")) || 3;
	$("concurrency").value = currentConcurrency;
}

$("browseBtn").addEventListener("click", async () => {
	const result = await window.electron.ipcRenderer.invoke("select-folder");
	if (!result.cancelled) {
		$("downloadPath").value = result.path;
		await window.electron.ipcRenderer.invoke("set-settings", { downloadPath: result.path });
		showToast("success", "Download folder updated");
	}
});

$("concurrency").addEventListener("change", () => {
	const val = Math.max(1, Math.min(10, parseInt($("concurrency").value) || 3));
	$("concurrency").value = val;
	currentConcurrency = val;
	localStorage.setItem("concurrency", val.toString());
});

// ─── Executor Bridge ───────────────────────────────────────
	const LUA_SCRIPT = `-- Roblox Asset Downloader — Executor Bridge v2
-- Paste this into your executor and execute
-- Scans game instances and sends tree + asset IDs to the app

local SCANNABLE_SERVICES = {
    "Workspace", "Players", "Lighting", "MaterialService",
    "NetworkClient", "ReplicatedFirst", "ReplicatedStorage",
    "StarterGui", "StarterPack", "StarterPlayer", "SoundService",
}

local ASSET_PROPS = {
    ["Sound"]           = { {"SoundId", "sound"} },
    ["Decal"]           = { {"Texture", "image"} },
    ["Texture"]         = { {"Texture", "image"} },
    ["ImageLabel"]      = { {"Image", "image"} },
    ["ImageButton"]     = { {"Image", "image"}, {"HoverImage", "image"}, {"PressedImage", "image"} },
    ["Shirt"]           = { {"ShirtTemplate", "image"} },
    ["Pants"]           = { {"PantsTemplate", "image"} },
    ["ShirtGraphic"]    = { {"Graphic", "image"} },
    ["Tool"]            = { {"TextureId", "image"} },
    ["Sky"]             = { {"SkyboxBk","image"},{"SkyboxDn","image"},{"SkyboxFt","image"},{"SkyboxLf","image"},{"SkyboxRt","image"},{"SkyboxUp","image"},{"SunTextureId","image"},{"MoonTextureId","image"} },
    ["ParticleEmitter"] = { {"Texture", "image"} },
    ["Beam"]            = { {"Texture", "image"} },
    ["Trail"]           = { {"Texture", "image"} },
    ["Animation"]       = { {"AnimationId", "animation"} },
}

local HttpService = game:GetService("HttpService")

local function extractAssetId(raw)
    if not raw or type(raw) ~= "string" then return nil end
    local id = raw:match("rbxassetid://(%d+)") or raw:match("^%s*(%d+)%s*$")
    if id and id ~= "0" then return id end
end

local function buildNode(obj)\n    local children = {}\n    local ok, childList = pcall(function() return obj:GetChildren() end)\n    if ok and childList then\n        for _, child in ipairs(childList) do\n            local cn = buildNode(child)\n            if cn then children[#children+1] = cn end\n        end\n    end\n    local assets = nil\n    local propList = ASSET_PROPS[obj.ClassName]\n    if propList then\n        for _, entry in ipairs(propList) do\n            local ok2, rawVal = pcall(function() return obj[entry[1]] end)\n            if ok2 then\n                local aid = extractAssetId(rawVal)\n                if aid then\n                    assets = assets or {}\n                    local ae = { prop = entry[1], id = aid, type = entry[2] }\n                    if entry[2] == \"sound\" then\n                        local okDur, dur = pcall(function() return obj.TimeLength end)\n                        if okDur and dur and dur > 0 then ae.duration = math.floor(dur * 100) / 100 end\n                    end\n                    assets[#assets+1] = ae\n                end\n            end\n        end\n    end\n    return { name = obj.Name, className = obj.ClassName, children = children, assets = assets }\nend

local placeId = tostring(game.PlaceId or "0")
local tree = {}
for _, svc in ipairs(SCANNABLE_SERVICES) do
    local ok, service = pcall(function() return game:GetService(svc) end)
    if ok and service then tree[#tree+1] = buildNode(service) end
end

local json = HttpService:JSONEncode({ placeId = placeId, tree = tree })

local req = request or http_request or (syn and syn.request) or (fluxus and fluxus.request)
local ok, response = pcall(req, {
    Url = "http://localhost:9876/game-instances",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json" },
    Body = json,
})

if ok and response and response.Success then
    print("[Asset Downloader] Instance data sent!")
else
    warn("[Asset Downloader] Failed to send data")
end`;

$("luaScript").textContent = LUA_SCRIPT;

async function initBridge() {
	try {
		const status = await window.electron.ipcRenderer.invoke("get-bridge-status");
		const toggle = $("bridgeToggle");
		toggle.checked = status.bridgeEnabled;
		applyBridgeState(status);
	} catch {
		applyBridgeState({ listening: false, bridgeEnabled: false });
	}
}

function applyBridgeState(status) {
	const info = $("bridgeInfo");
	const hint = $("bridgeHint");
	const wrapper = $("bridgeCodeWrapper");
	const dot = $("bridgeDot");
	const statusEl = $("bridgeStatus");
	const explorerTab = document.querySelector('.tab[data-page="explorer"]');

	if (!status.bridgeEnabled) {
		info.style.display = "none";
		hint.style.display = "none";
		wrapper.style.display = "none";
		dot.className = "bridge-dot";
		statusEl.textContent = "";
		explorerTab.style.display = "none";
		if (document.querySelector('.page.active') === $("page-explorer")) {
			document.querySelector('.tab[data-page="download"]').click();
		}
	} else if (status.listening) {
		info.style.display = "flex";
		hint.style.display = "";
		wrapper.style.display = "";
		dot.className = "bridge-dot online";
		statusEl.textContent = `Listening on localhost:${status.port}`;
		explorerTab.style.display = "";
	} else {
		info.style.display = "flex";
		hint.style.display = "";
		wrapper.style.display = "";
		dot.className = "bridge-dot offline";
		statusEl.textContent = "Not running";
		explorerTab.style.display = "";
	}
}

$("bridgeToggle").addEventListener("change", async () => {
	const enabled = $("bridgeToggle").checked;
	try {
		const status = await window.electron.ipcRenderer.invoke("set-bridge-enabled", enabled);
		applyBridgeState(status);
		showToast("info", enabled ? "Bridge enabled" : "Bridge disabled", 2000);
	} catch {
		// Revert checkbox on error
		$("bridgeToggle").checked = !enabled;
		showToast("error", "Failed to toggle bridge");
	}
});

$("copyLuaBtn").addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(LUA_SCRIPT);
		const btn = $("copyLuaBtn");
		const orig = btn.textContent;
		btn.textContent = "Copied!";
		btn.classList.add("copied");
		setTimeout(() => {
			btn.textContent = orig;
			btn.classList.remove("copied");
		}, 1500);
	} catch {
		showToast("error", "Failed to copy");
	}
});

// ─── Progress Event Listener ────────────────────────────────
window.electron.ipcRenderer.on("download-progress", ({ downloadId, received, total }) => {
	const item = document.querySelector(`[data-dl-id="${downloadId}"]`);
	if (!item) return;

	const fill = item.querySelector(".progress-fill");
	const sizeInfo = item.querySelector(".download-item-size");
	const pctInfo = item.querySelector(".download-item-percent");

		if (total > 0) {
			const pct = Math.round((received / total) * 100);
			fill.style.width = pct + "%";
			fill.classList.remove("indeterminate");
			sizeInfo.textContent = `${formatSize(received)} / ${formatSize(total)}`;
			pctInfo.textContent = pct + "%";
			item.dataset.totalSize = total;
	} else {
		fill.classList.add("indeterminate");
		sizeInfo.textContent = formatSize(received);
		pctInfo.textContent = "";
	}
});

// ─── Download Item UI ───────────────────────────────────────
function createDownloadItem(downloadId, assetId) {
	const div = document.createElement("div");
	div.className = "download-item";
	div.dataset.dlId = downloadId;
	div.innerHTML = `
		<div class="download-item-header">
			<span class="download-item-id">#${assetId}</span>
			<span class="download-item-status waiting">Waiting</span>
		</div>
		<div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>
		<div class="download-item-info">
			<span class="download-item-size">—</span>
			<span class="download-item-percent"></span>
		</div>
	`;
	downloadList.appendChild(div);
	return div;
}

function updateItemStatus(downloadId, status, message) {
	const item = document.querySelector(`[data-dl-id="${downloadId}"]`);
	if (!item) return;
	const statusEl = item.querySelector(".download-item-status");
	const fill = item.querySelector(".progress-fill");

	const labels = {
		waiting: "Waiting",
		downloading: "Downloading",
		done: "Done",
		error: "Failed",
		retrying: "Retrying",
		cancelled: "Cancelled",
	};

	statusEl.className = `download-item-status ${status}`;
	statusEl.textContent = message ? `${labels[status] || status} — ${message}` : (labels[status] || status);

		if (status === "done") {
				fill.classList.remove("indeterminate");
				fill.style.width = "100%";
				fill.classList.add("success");
				const pctEl = item.querySelector(".download-item-percent");
				if (pctEl) pctEl.textContent = "100%";
				const sizeEl = item.querySelector(".download-item-size");
				const total = parseInt(item.dataset.totalSize) || 0;
				if (sizeEl && total > 0) {
					sizeEl.textContent = `${formatSize(total)} / ${formatSize(total)}`;
				}
		} else if (status === "error") {
		fill.classList.remove("indeterminate");
		fill.classList.add("error");
	} else if (status === "downloading") {
		fill.classList.remove("indeterminate", "success", "error");
	}
}

function updateOverallProgress(completed, total) {
	const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
	overallProgress.style.width = pct + "%";
	downloadSummaryText.textContent = `${completed} / ${total} completed — ${pct}%`;
	updateStatus(`${completed} / ${total} — ${pct}%`);
}

// ─── Download Core ──────────────────────────────────────────
async function downloadOne(assetId, placeId, cookie, downloadId) {
	const url = `https://assetdelivery.roblox.com/v1/asset?id=${assetId}`;
	updateItemStatus(downloadId, "downloading");

	const result = await window.electron.ipcRenderer.invoke("download-request", {
		url,
		userAgent: "Roblox/WinInet",
		robloSecurity: cookie,
		robloxPlaceId: placeId,
		downloadId,
	});

	return result;
}

async function downloadWithRetry(assetId, placeIds, cookie, downloadId) {
	const places = placeIds.length > 0 ? placeIds : [""];
	let lastError = null;
	let isRateLimited = false;

	for (let attempt = 0; attempt < 5; attempt++) {
		if (downloadCancelled) return { success: false, error: { message: "Cancelled", code: "CANCELLED" } };

		if (attempt > 0) {
			if (isRateLimited) {
				updateItemStatus(downloadId, "retrying", `attempt ${attempt + 1}/5 — waiting 3s`);
				await new Promise((r) => setTimeout(r, 3000));
			} else {
				updateItemStatus(downloadId, "retrying", `attempt ${attempt + 1}/5`);
			}
		}

		isRateLimited = false;

		for (const placeId of places) {
			if (downloadCancelled) return { success: false, error: { message: "Cancelled", code: "CANCELLED" } };

			const result = await downloadOne(assetId, placeId, cookie, downloadId);

			if (result.success) return result;

			lastError = result.error;
			if (result.error?.status === 429) {
				isRateLimited = true;
			}
		}
	}

	return { success: false, error: lastError || { message: "Max retries exceeded" } };
}

async function downloadAll(assetIds, placeIds, cookie, concurrency) {
	const queue = [...assetIds];
	const total = assetIds.length;
	let completed = 0;
	let failed = [];

	downloadSection.style.display = "block";
	downloadList.innerHTML = "";
	overallProgress.style.width = "0%";
	overallProgress.classList.remove("success", "error");
	updateOverallProgress(0, total);

	async function worker() {
		while (queue.length > 0 && !downloadCancelled) {
			const assetId = queue.shift();
			const downloadId = `dl-${++downloadIdCounter}`;
			createDownloadItem(downloadId, assetId);

			const result = await downloadWithRetry(assetId, placeIds, cookie, downloadId);

			if (downloadCancelled) {
				updateItemStatus(downloadId, "cancelled");
				break;
			}

			if (result.success) {
				completed++;
				updateItemStatus(downloadId, "done");
				try {
					await window.electron.ipcRenderer.invoke("history-add", {
						assetId: result.assetId,
						fileName: result.fileName,
						filePath: result.filePath,
						fileSize: result.fileSize,
						timestamp: new Date().toISOString(),
					});
				} catch (e) {
					console.error("Failed to add history entry:", e);
				}
			} else {
				failed.push(assetId);
				const errMsg = result.error?.message || "Unknown error";
				updateItemStatus(downloadId, "error", errMsg);
			}

			updateOverallProgress(completed + failed.length, total);
		}
	}

	const workerCount = Math.min(concurrency, assetIds.length);
	const workers = Array(workerCount).fill(null).map(() => worker());
	await Promise.all(workers);

	return { completed, failed, cancelled: downloadCancelled };
}

// ─── Download Button ────────────────────────────────────────
downloadBtn.addEventListener("click", async () => {
	if (isDownloading) {
		downloadCancelled = true;
		return;
	}

	const cookie = cookieInput.value.trim();
	const assetIds = parseIds(assetIdsInput.value);
	const placeIds = parseIds(placeIdInput.value);

	if (assetIds.length === 0) {
		showToast("warning", "Please enter at least one Asset ID");
		return;
	}

	if (!cookie) {
		showToast("warning", "Please enter your Roblox cookie");
		return;
	}

	const uniqueIds = [...new Set(assetIds)];
	if (uniqueIds.length < assetIds.length) {
		showToast("info", `Removed ${assetIds.length - uniqueIds.length} duplicate ID(s)`);
	}

	isDownloading = true;
	downloadCancelled = false;
	downloadBtn.classList.add("downloading");
	downloadBtnText.textContent = "Stop";

	const concurrency = Math.max(1, Math.min(10, currentConcurrency));
	showToast("info", `Starting download of ${uniqueIds.length} asset(s) — ${concurrency} concurrent`);

	const { completed, failed, cancelled } = await downloadAll(uniqueIds, placeIds, cookie, concurrency);

	isDownloading = false;
	downloadBtn.classList.remove("downloading");
	downloadBtnText.textContent = "Download";

	if (cancelled) {
		updateStatus(`Stopped — ${completed} done, ${failed.length} failed`);
		showToast("warning", `Download stopped — ${completed} completed, ${failed.length} failed`);
	} else if (failed.length > 0) {
		updateStatus(`${completed} downloaded, ${failed.length} failed`);
		showToast("error", `${completed} downloaded, ${failed.length} failed`);
		try {
			const failedPath = await window.electron.ipcRenderer.invoke("save-failed-assets", {
				params: placeIdInput.value + assetIdsInput.value,
				content: failed.join("\n"),
			});
			showToast("warning", `Failed IDs saved to: ${failedPath}`, 6000);
		} catch (e) {
			console.error("Failed to save failed assets:", e);
		}
	} else {
			updateOverallProgress(uniqueIds.length, uniqueIds.length);
			overallProgress.classList.add("success");
			updateStatus(`All ${completed} asset(s) downloaded`);
			showToast("success", `All ${completed} asset(s) downloaded successfully`);
		}
});

// ─── History ────────────────────────────────────────────────
async function loadHistory() {
	try {
		const history = await window.electron.ipcRenderer.invoke("history-load");
		renderHistory(history);
	} catch (e) {
		console.error("Failed to load history:", e);
	}
}

function renderHistory(history) {
	if (!history || history.length === 0) {
		historyList.innerHTML = '<div class="empty-state">No downloads yet</div>';
		return;
	}

	historyList.innerHTML = history
		.map(
			(entry) => `
		<div class="history-item">
			<div class="history-item-info">
				<div class="history-item-id">#${entry.assetId}</div>
				<div class="history-item-meta">
					<span>${entry.fileName || "—"}</span>
					<span>${formatSize(entry.fileSize)}</span>
					<span>${formatTime(entry.timestamp)}</span>
				</div>
			</div>
			<div class="history-item-actions">
				<button class="history-open-btn" data-path="${entry.filePath}">Open</button>
			</div>
		</div>
	`
		)
		.join("");

	historyList.querySelectorAll(".history-open-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			window.electron.ipcRenderer.invoke("open-in-explorer", { filePath: btn.dataset.path });
		});
	});
}

$("clearHistoryBtn").addEventListener("click", async () => {
	await window.electron.ipcRenderer.invoke("history-clear");
	loadHistory();
	showToast("success", "History cleared");
});

// ─── Keyboard Shortcut ──────────────────────────────────────
assetIdsInput.addEventListener("keydown", (e) => {
	if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
		e.preventDefault();
		downloadBtn.click();
	}
});

// ═════════════════════════════════════════════════════════════
//    Instance Explorer  (no icons · green dot for assets · tree guide lines)
// ═════════════════════════════════════════════════════════════

let explorerData = null;
let explorerTreeData = [];       // raw tree from executor (never mutated)
let expandedPaths = new Set();   // paths of expanded nodes
let selectedNodePath = "";       // currently selected node path
let explorerAssetCount = 0;
let explorerInstanceCount = 0;
let activeFilters = new Set();   // active type filters: 'sound', 'image', 'animation'
let durationMin = 0;             // audio duration filter (seconds)
let durationMax = 0;
let flatNodeList = [];           // precomputed flat list for fast render
let pathToEntry = new Map();     // path → flat list entry (for O(1) lookups)
let renderGeneration = 0;        // increment to cancel stale renders
let wasSearching = false;        // track previous search/filter state for auto-locate

// ─── Audio preview state ───────────────────────────────────
const audioPreviewEl = $("audioPreview");
let audioState = {
	assetId: null,         // current asset ID loaded
	playing: false,
	currentTime: 0,
	duration: 0,
	loaded: false,
	loading: false,
	error: null,
};

const explorerTreeEl = $("explorerTree");
const explorerSearchEl = $("explorerSearch");
const explorerStatsEl = $("explorerStats");
const explorerPropsEl = $("explorerProps");

// ─── Event delegation (one listener, no per-node bindings) ────
	explorerTreeEl.addEventListener("click", (e) => {
		const expandEl = e.target.closest(".tree-expand");
		if (expandEl) {
			e.stopPropagation();
			toggleExpand(expandEl.dataset.path);
			return;
		}
		const nodeEl = e.target.closest(".tree-node");
		if (nodeEl && nodeEl.dataset.path) {
			selectNode(nodeEl.dataset.path);
		}
	});

	// ─── Audio preview events ─────────────────────────────────
	audioPreviewEl.addEventListener("loadedmetadata", () => {
		audioState.duration = audioPreviewEl.duration;
		audioState.loaded = true;
		audioState.loading = false;
		audioState.error = null;
		updateAudioUI();
	});
	audioPreviewEl.addEventListener("timeupdate", () => {
		audioState.currentTime = audioPreviewEl.currentTime;
		updateAudioProgress();
	});
	audioPreviewEl.addEventListener("ended", () => {
		audioState.playing = false;
		updateAudioUI();
	});
	audioPreviewEl.addEventListener("play", () => {
		audioState.playing = true;
		updateAudioUI();
	});
	audioPreviewEl.addEventListener("pause", () => {
		audioState.playing = false;
		updateAudioUI();
	});
	audioPreviewEl.addEventListener("error", () => {
		audioState.loaded = false;
		audioState.loading = false;
		audioState.playing = false;
		if (audioState.assetId) {
			audioState.error = 'Failed to load audio';
		}
		updateAudioUI();
	});

// ─── Utilities ──────────────────────────────────────────────
const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _escRe = /[&<>"']/g;
function escapeHtml(text) {
	return String(text ?? '').replace(_escRe, c => _escMap[c]);
}

function countAssets(nodes) {
	let count = 0;
	for (const node of nodes) {
		if (node.assets) count += node.assets.length;
		if (node.children) count += countAssets(node.children);
	}
	return count;
}

function countInstances(nodes) {
	let count = 0;
	for (const node of nodes) {
		count++;
		if (node.children) count += countInstances(node.children);
	}
	return count;
}

	// ─── Precompute flat list (runs once on data load) ──────────
	// Stores parentIdx (numeric) for O(1) ancestor walking — no string manipulation at render time.
	// Paths include child index for uniqueness: "0:Workspace/1:Model/0:Sound"
		function buildFlatList(nodes) {
			const list = [];
			function walk(nodes, depth, parentPath, parentDisplayPath, ancestorFlags, parentIdx) {
				for (let i = 0; i < nodes.length; i++) {
					const node = nodes[i];
					const isLastChild = (i === nodes.length - 1);
					const path = parentPath ? `${parentPath}/${i}:${node.name}` : `${i}:${node.name}`;
					const displayPath = parentDisplayPath ? `${parentDisplayPath}/${node.name}` : node.name;
					const hasChildren = node.children && node.children.length > 0;

				let hasSound = false, hasImage = false, hasAnimation = false;
				let soundDurMin = Infinity, soundDurMax = -Infinity;
				let assetIds = null;
				if (node.assets) {
					assetIds = [];
					for (const a of node.assets) {
						if (a.type === 'sound') {
							hasSound = true;
							if (a.duration != null && a.duration > 0) {
								if (a.duration < soundDurMin) soundDurMin = a.duration;
								if (a.duration > soundDurMax) soundDurMax = a.duration;
							}
						} else if (a.type === 'image') hasImage = true;
						else if (a.type === 'animation') hasAnimation = true;
						assetIds.push(a.id);
					}
				}

				const idx = list.length;
				list.push({
					node, depth, path, displayPath, parentIdx, isLastChild,
					ancestorFlags: ancestorFlags || [],
					hasChildren, hasSound, hasImage, hasAnimation,
					soundDurMin, soundDurMax,
					nameLower: node.name.toLowerCase(),
					classLower: node.className.toLowerCase(),
					assetIds,
				});

					if (hasChildren) {
						walk(node.children, depth + 1, path, displayPath, [...(ancestorFlags || []), isLastChild], idx);
					}
				}
			}
			walk(nodes, 0, '', '', [], -1);
			return list;
		}

	function buildPathMap(list) {
		const map = new Map();
		for (const e of list) map.set(e.path, e);
		return map;
	}

	// ─── Propagate asset types upward to ancestors (numeric parentIdx) ──
		function propagateAssetTypes(list) {
			for (let i = list.length - 1; i >= 0; i--) {
				const e = list[i];
				if (!e.hasSound && !e.hasImage && !e.hasAnimation) continue;
				let pi = e.parentIdx;
				while (pi !== -1) {
					const p = list[pi];
					let changed = false;
					if (!p.hasSound && e.hasSound) { p.hasSound = true; changed = true; }
					if (!p.hasImage && e.hasImage) { p.hasImage = true; changed = true; }
					if (!p.hasAnimation && e.hasAnimation) { p.hasAnimation = true; changed = true; }
					if (e.soundDurMin < p.soundDurMin) { p.soundDurMin = e.soundDurMin; changed = true; }
					if (e.soundDurMax > p.soundDurMax) { p.soundDurMax = e.soundDurMax; changed = true; }
					if (!changed) break;
					pi = p.parentIdx;
				}
			}
		}

	// ─── Get visible nodes (optimized: O(N) normal, O(N+M·D) search) ──
		// Uses numeric parentIdx — zero string manipulation, zero Map lookups at render time.
		function getVisibleNodes(query, filters) {
			const N = flatNodeList.length;
			if (N === 0) return [];

			const searching = query && query.length > 0;
			const filtering = filters && filters.size > 0;
			const normalMode = !searching && !filtering;

		const vis = new Uint8Array(N); // 0=hidden, 1=direct match, 2=ancestor context

		if (normalMode) {
			// Single O(N) pass: node is visible if parent is visible AND expanded
			for (let i = 0; i < N; i++) {
				const e = flatNodeList[i];
				if (e.parentIdx === -1) {
					vis[i] = 1;
				} else if (vis[e.parentIdx] && expandedPaths.has(flatNodeList[e.parentIdx].path)) {
					vis[i] = 1;
				}
			}
		} else {
			// Pre-extract filter flags for speed
			const fSound = filtering && filters.has('sound');
			const fImage = filtering && filters.has('image');
			const fAnim  = filtering && filters.has('animation');
			// Duration is a sub-filter of Sound — only active when Sound is on
			const durActive = fSound && (durationMin > 0 || durationMax > 0);
			const durMax = durationMax > 0 ? durationMax : Infinity;

				// Pass 1: mark direct matches
				for (let i = 0; i < N; i++) {
					const e = flatNodeList[i];

					if (filtering) {
						let typeOk = false;
						if (fSound && e.hasSound) {
							if (durActive) {
								if (e.soundDurMin <= durMax && e.soundDurMax >= durationMin) typeOk = true;
							} else {
								typeOk = true;
							}
						}
						if (!typeOk && fImage && e.hasImage) typeOk = true;
						if (!typeOk && fAnim && e.hasAnimation) typeOk = true;
						if (!typeOk) continue;
					}

					if (searching) {
						let match = e.nameLower.includes(query) || e.classLower.includes(query);
						if (!match && e.assetIds) {
							for (let j = 0; j < e.assetIds.length; j++) {
								if (e.assetIds[j].includes(query)) { match = true; break; }
							}
						}
					if (!match) continue;
				}

				vis[i] = 1;
			}

			// Pass 2: propagate to ancestors via numeric parentIdx (fast, early-break)
			for (let i = 0; i < N; i++) {
				if (vis[i] !== 1) continue;
				let pi = flatNodeList[i].parentIdx;
				while (pi !== -1) {
					if (vis[pi] !== 0) break; // already marked — ancestors above already done
					vis[pi] = 2;
					pi = flatNodeList[pi].parentIdx;
				}
			}
		}

		// Collect results
		const result = [];
		for (let i = 0; i < N; i++) {
			if (vis[i] === 0) continue;
			const e = flatNodeList[i];
			result.push({
				node: e.node,
				depth: e.depth,
				path: e.path,
				expanded: normalMode ? expandedPaths.has(e.path) : true,
				hasChildren: e.hasChildren,
				matched: vis[i] === 1,
				isLastChild: e.isLastChild,
				ancestorFlags: e.ancestorFlags,
			});
		}
		return result;
	}

	// ─── Render tree (optimized HTML build, auto-locate on exit) ──
		function renderExplorer() {
			const gen = ++renderGeneration;
			const query = explorerSearchEl.value.trim().toLowerCase();
			const filtering = activeFilters.size > 0;
			const isSearching = query.length > 0 || filtering;

			// Detect transition from search/filter → normal mode
			const exitingSearch = wasSearching && !isSearching;
			wasSearching = isSearching;

			// If exiting search/filter and a node is selected, expand its ancestors so it's visible
			if (exitingSearch && selectedNodePath) {
			const entry = pathToEntry.get(selectedNodePath);
			if (entry) {
				let pi = entry.parentIdx;
				while (pi !== -1) {
					expandedPaths.add(flatNodeList[pi].path);
					pi = flatNodeList[pi].parentIdx;
				}
			}
		}

			const visible = getVisibleNodes(query, activeFilters);
			if (gen !== renderGeneration) return;

		if (visible.length === 0) {
			explorerTreeEl.innerHTML = explorerTreeData.length === 0
				? '<div class="empty-state">No instance data yet. Execute the Lua script in your executor to scan the game.</div>'
				: '<div class="empty-state">No matching instances found</div>';
			return;
		}

		// Build HTML using Array.push + join (faster than string concat for large arrays)
		const parts = new Array(visible.length);
		for (let vi = 0; vi < visible.length; vi++) {
			const { node, depth, path, expanded, hasChildren, matched, isLastChild, ancestorFlags } = visible[vi];

			// Guide lines as a single string (one span, not many)
			let guides = '';
			for (let d = 0; d < depth; d++) {
				guides += ancestorFlags[d] ? '   ' : '│  ';
			}
			if (depth > 0) {
				guides += isLastChild ? '└─ ' : '├─ ';
			}

			const expandIcon = hasChildren
				? `<span class="tree-expand" data-path="${escapeHtml(path)}">${expanded ? '▼' : '▶'}</span>`
				: '<span class="tree-expand-placeholder"></span>';

			const hasAssets = node.assets && node.assets.length > 0;
			const dotHtml = hasAssets ? '<span class="tree-dot"></span>' : '';

			const selectedClass = path === selectedNodePath ? ' tree-node-selected' : '';
			const matchedClass = matched ? ' tree-node-matched' : '';

			parts[vi] = `<div class="tree-node${selectedClass}${matchedClass}" data-path="${escapeHtml(path)}">`
				+ `<span class="tree-guides">${guides}</span>`
				+ expandIcon + dotHtml
				+ `<span class="tree-name">${escapeHtml(node.name)}</span>`
				+ `<span class="tree-class">${escapeHtml(node.className)}</span>`
				+ '</div>';
		}

		explorerTreeEl.innerHTML = parts.join('');

		if (gen !== renderGeneration) return;

		// Auto-scroll to selected node when exiting search/filter mode
		if (exitingSearch && selectedNodePath) {
			const selEl = explorerTreeEl.querySelector('.tree-node-selected');
			if (selEl) {
				selEl.scrollIntoView({ block: 'center', behavior: 'instant' });
			}
		}
	}

	// ─── Expand / Collapse (instant) ───────────────────────────
	function toggleExpand(path) {
		if (expandedPaths.has(path)) {
			expandedPaths.delete(path);
		} else {
			expandedPaths.add(path);
		}
		renderExplorer();
	}

// ─── Node selection → properties panel ──────────────────────
function findNodeByPath(targetPath) {
	const entry = pathToEntry.get(targetPath);
	return entry ? entry.node : null;
}

	function selectNode(path) {
		// Stop any playing audio when switching nodes
		if (audioState.playing) {
			audioPreviewEl.pause();
		}
		selectedNodePath = path;
		renderExplorer();
		renderProps();
	}

	// ─── Audio player controls ────────────────────────────────
	async function loadAudio(assetId) {
		if (audioState.assetId === assetId && (audioState.loaded || audioState.loading)) return;

		// Reset state
		audioState.assetId = assetId;
		audioState.loaded = false;
		audioState.loading = true;
		audioState.playing = false;
		audioState.currentTime = 0;
		audioState.duration = 0;
		audioState.error = null;
		updateAudioUI();

		const cookie = cookieInput.value.trim();
		const placeId = placeIdInput.value.trim();

		if (!cookie) {
			audioState.loading = false;
			audioState.error = 'Enter your Roblox cookie in the Download tab to preview audio';
			updateAudioUI();
			return;
		}

		try {
			const result = await window.electron.ipcRenderer.invoke('get-audio-preview', { assetId, cookie, placeId });
			if (audioState.assetId !== assetId) return; // stale response

			if (result.success && result.dataUrl) {
				audioPreviewEl.src = result.dataUrl;
				audioPreviewEl.load();
			} else {
				audioState.loading = false;
				audioState.error = result.error || 'Failed to load audio';
				updateAudioUI();
			}
		} catch (e) {
			if (audioState.assetId !== assetId) return;
			audioState.loading = false;
			audioState.error = 'Network error: ' + (e.message || 'unknown');
			updateAudioUI();
		}
	}

	function toggleAudioPlay() {
		if (!audioState.loaded) return;
		if (audioState.playing) {
			audioPreviewEl.pause();
		} else {
			audioPreviewEl.play().catch(() => {});
		}
	}

	function seekAudio(percent) {
		if (!audioState.loaded) return;
		audioPreviewEl.currentTime = (percent / 100) * audioState.duration;
	}

	function formatAudioTime(sec) {
		if (!sec || !isFinite(sec)) return '0:00';
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function updateAudioUI() {
		const btn = document.getElementById('audioPlayBtn');
		const progress = document.getElementById('audioProgress');
		const timeEl = document.getElementById('audioTime');
		const errorEl = document.getElementById('audioError');
		if (!btn) return; // audio player not in DOM

		if (audioState.loading) {
			btn.textContent = '⏳';
			btn.disabled = true;
			if (progress) progress.value = 0;
			if (timeEl) timeEl.textContent = 'Loading...';
			if (errorEl) errorEl.style.display = 'none';
			return;
		}

		btn.disabled = false;

		if (audioState.error) {
			btn.textContent = '▶';
			if (progress) progress.value = 0;
			if (timeEl) timeEl.textContent = '--:--';
			if (errorEl) {
				errorEl.textContent = '⚠ ' + audioState.error;
				errorEl.style.display = 'block';
			}
			return;
		}

		if (!audioState.loaded) {
			btn.textContent = '▶';
			if (progress) progress.value = 0;
			if (timeEl) timeEl.textContent = '--:--';
			if (errorEl) errorEl.style.display = 'none';
			return;
		}

		if (errorEl) errorEl.style.display = 'none';
		btn.textContent = audioState.playing ? '⏸' : '▶';
		if (timeEl) timeEl.textContent = `${formatAudioTime(audioState.currentTime)} / ${formatAudioTime(audioState.duration)}`;
	}

	function updateAudioProgress() {
		const progress = document.getElementById('audioProgress');
		if (!progress) return;
		if (audioState.duration > 0) {
			progress.value = (audioState.currentTime / audioState.duration) * 100;
		}
		const timeEl = document.getElementById('audioTime');
		if (timeEl) timeEl.textContent = `${formatAudioTime(audioState.currentTime)} / ${formatAudioTime(audioState.duration)}`;
	}

	function renderProps() {
		if (!selectedNodePath) {
			explorerPropsEl.innerHTML = '<div class="empty-state">Select an instance to view properties</div>';
			return;
		}

		const entry = pathToEntry.get(selectedNodePath);
		const node = entry ? entry.node : null;
		if (!node) {
			explorerPropsEl.innerHTML = '<div class="empty-state">Instance not found</div>';
			return;
		}

		const displayPath = entry.displayPath || selectedNodePath;

		let html = `<div class="prop-section">
			<div class="prop-header">
				<span class="prop-header-name">${escapeHtml(node.name)}</span>
			</div>
			<div class="prop-row"><span class="prop-label">Name</span><span class="prop-value">${escapeHtml(node.name)}</span></div>
			<div class="prop-row"><span class="prop-label">Class</span><span class="prop-value">${escapeHtml(node.className)}</span></div>
			<div class="prop-row"><span class="prop-label">Path</span><span class="prop-value prop-path">${escapeHtml(displayPath)}</span></div>`;

		if (node.children && node.children.length > 0) {
			html += `<div class="prop-row"><span class="prop-label">Children</span><span class="prop-value">${node.children.length}</span></div>`;
		}

		html += "</div>";

		// ─── Assets section ──────────────────────────────────────
			if (node.assets && node.assets.length > 0) {
				html += '<div class="prop-section"><div class="prop-section-title">Assets</div>';
				let hasAudioPlayer = false;
				for (const asset of node.assets) {
					const typeIcon = asset.type === 'sound' ? '🔊' : asset.type === 'image' ? '🖼️' : asset.type === 'animation' ? '🎬' : '📦';
					const durStr = asset.duration ? ` · ${asset.duration.toFixed(1)}s` : '';

					html += `<div class="prop-asset" data-asset-id="${escapeHtml(asset.id)}" data-asset-type="${escapeHtml(asset.type)}">
						<div class="prop-asset-info">
							<span class="prop-asset-icon">${typeIcon}</span>
							<div class="prop-asset-text">
								<span class="prop-asset-prop">${escapeHtml(asset.prop)}${durStr}</span>
								<span class="prop-asset-id">rbxassetid://${escapeHtml(asset.id)}</span>
								<span class="prop-asset-realname" id="assetName-${escapeHtml(asset.id)}">...</span>
							</div>
						</div>
						<button class="btn btn-secondary btn-sm prop-asset-download" data-asset-id="${escapeHtml(asset.id)}">Download</button>
					</div>`;

				// Audio player for Sound assets (only once)
				if (asset.type === 'sound' && !hasAudioPlayer) {
					hasAudioPlayer = true;
					html += `<div class="audio-player" id="audioPlayer">
						<div class="audio-controls">
							<button class="audio-play-btn" id="audioPlayBtn" onclick="toggleAudioPlay()">▶</button>
							<input type="range" class="audio-progress" id="audioProgress" min="0" max="100" value="0"
								oninput="seekAudio(this.value)" onchange="seekAudio(this.value)" />
							<span class="audio-time" id="audioTime">--:--</span>
						</div>
						<div class="audio-error" id="audioError" style="display:none;"></div>
					</div>`;
				}
			}
			html += "</div>";
		}

		explorerPropsEl.innerHTML = html;

		// ─── Post-render setup ───────────────────────────────────

		// Bind download buttons
		explorerPropsEl.querySelectorAll(".prop-asset-download").forEach((btn) => {
			btn.addEventListener("click", () => {
				downloadFromExplorer([btn.dataset.assetId]);
			});
		});

		// Fetch asset names asynchronously
		if (node.assets) {
			for (const asset of node.assets) {
				fetchAssetName(asset.id);
			}
		}

		// Load audio for first Sound asset
		if (node.assets) {
			const soundAsset = node.assets.find(a => a.type === 'sound');
			if (soundAsset) {
				loadAudio(soundAsset.id);
			}
		}
	}

		async function fetchAssetName(assetId) {
			const nameEl = document.getElementById(`assetName-${assetId}`);
			if (!nameEl) return;
			try {
				const result = await window.electron.ipcRenderer.invoke("get-asset-name", { assetId });
				if (result && result.name) {
					nameEl.textContent = result.name;
					nameEl.classList.add('loaded');
				} else {
					nameEl.textContent = '';
				}
			} catch {
				nameEl.textContent = '';
			}
		}

	// ─── Search (debounced 300ms) ──────────────────────────────
	const debouncedRender = debounce(renderExplorer, 300);

	explorerSearchEl.addEventListener("input", () => {
		if (!flatNodeList.length) return;
		debouncedRender();
	});

	// ─── Filter Buttons ─────────────────────────────────────────
	document.querySelectorAll(".filter-btn").forEach((btn) => {
		btn.addEventListener("click", () => {
			const type = btn.dataset.filter;
			if (activeFilters.has(type)) {
				activeFilters.delete(type);
				btn.classList.remove("active");
			} else {
				activeFilters.add(type);
				btn.classList.add("active");
			}
			// Duration filter is a sub-option of Sound — show/hide accordingly
			if (type === "sound") {
				const durEl = $("durationFilter");
				if (activeFilters.has("sound")) {
					durEl.classList.add("visible");
				} else {
					durEl.classList.remove("visible");
					durationMin = 0;
					durationMax = 0;
					$("durationMin").value = "";
					$("durationMax").value = "";
				}
			}
			renderExplorer();
		});
	});

	// ─── Duration Filter Inputs ────────────────────────────────
	$("durationMin").addEventListener("input", () => {
		durationMin = parseFloat($("durationMin").value) || 0;
		renderExplorer();
	});
	$("durationMax").addEventListener("input", () => {
		durationMax = parseFloat($("durationMax").value) || 0;
		renderExplorer();
	});

// ─── Download from Explorer ─────────────────────────────────
function downloadFromExplorer(assetIds) {
	if (!assetIds || assetIds.length === 0) {
		showToast("warning", "No assets to download");
		return;
	}

	const cookie = cookieInput.value.trim();
	if (!cookie) {
		showToast("warning", "Please enter your Roblox cookie first");
		document.querySelector('.tab[data-page="download"]').click();
		return;
	}

	assetIdsInput.value = assetIds.join("\n");

	if (explorerData && explorerData.placeId) {
		placeIdInput.value = explorerData.placeId;
	}

	document.querySelector('.tab[data-page="download"]').click();

	showToast("info", `Starting download of ${assetIds.length} asset(s) from Explorer`);
	downloadBtn.click();
}

	// ─── Receive instance data from executor ────────────────────
	window.electron.ipcRenderer.on("instances-received", (data) => {
		explorerData = data;
		explorerTreeData = data.tree || [];

		if (data.placeId) {
			placeIdInput.value = data.placeId;
		}

		// Default: all collapsed
		expandedPaths = new Set();
		activeFilters = new Set();
		durationMin = 0;
		durationMax = 0;
		$("durationMin").value = "";
		$("durationMax").value = "";
		$("durationFilter").classList.remove("visible");
		document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));

		selectedNodePath = "";
		explorerAssetCount = countAssets(explorerTreeData);
		explorerInstanceCount = countInstances(explorerTreeData);

		// Precompute flat list for fast rendering
		flatNodeList = buildFlatList(explorerTreeData);
		propagateAssetTypes(flatNodeList);
		pathToEntry = buildPathMap(flatNodeList);

		explorerStatsEl.textContent = `${explorerInstanceCount} instances · ${explorerAssetCount} assets found`;
		explorerSearchEl.value = "";
		wasSearching = false;

		renderExplorer();
		renderProps();

		showToast("success", `Instance tree received: ${explorerAssetCount} assets found`, 4000);
		updateStatus(`Explorer: ${explorerAssetCount} assets found`);

		document.querySelector('.tab[data-page="explorer"]').click();
	});

// ─── Init ───────────────────────────────────────────────────
initCookie();
initSettings();
initBridge();

// ─── Executor Bridge ────────────────────────────────────────
window.electron.ipcRenderer.on("place-id-received", ({ placeId }) => {
	placeIdInput.value = placeId;
	showToast("success", `Place ID auto-filled: ${placeId}`, 3000);
	updateStatus(`Place ID: ${placeId}`);
});
