const PLATFORMS = [
	{ label: "Off", value: "off" },
	{ label: "Desktop (Windows)", value: "desktop" },
	{ label: "Web / Browser (Chrome)", value: "web" },
	{ label: "Meta Quest / VR (VR: Online)", value: "meta" },
	{ label: "Console", value: "console" },
];

var SPOOF = {
	desktop: {
		os: "Windows", browser: "Discord Client", device: "",
		release_channel: "stable", client_version: "1.0.9187", os_version: "10.0.19045",
		browser_user_agent: "", browser_version: "",
	},
	web: {
		os: "Linux", browser: "Chrome", device: "",
		release_channel: "stable", client_version: "9999", os_version: "",
		browser_user_agent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
		browser_version: "124.0.0.0",
	},
	meta: {
		os: "Android", browser: "Discord VR", device: "Meta Quest",
		release_channel: "stable", client_version: "1.0.0", os_version: "12",
		browser_user_agent: "", browser_version: "",
	},
	console: {
		os: "Playstation", browser: "Discord Embedded", device: "PlayStation",
		release_channel: "stable", client_version: "1.0.0", os_version: "",
		browser_user_agent: "", browser_version: "",
	},
};

var storage = revenge.jsonStorage.getJsonStorage(
	revenge.jsonStorage.pluginStoragePathFor("k1ngop.platform-spoof"),
	{ default: { platform: "off" }, load: true }
);

function getPlatform() {
	return storage.cache?.platform ?? "off";
}
function setPlatform(value) {
	storage.set({ platform: value });
}
function getSpoof() {
	return SPOOF[getPlatform()] || null;
}

var IDENTIFY = 2;
var MIN_RECONNECT_INTERVAL_MS = 3000;

var socketModule = null;
var patchedSocket = null;
var origSend = null;
var origHandleIdentify = null;
var patchedTransports = new WeakMap();
var activeIntervals = [];
var pendingRetryTimeout = null;
var lastIdentifyAt = null;
var identifyListeners = [];

function getSocket() {
	return socketModule?.getSocket() ?? null;
}

function trackInterval(id) {
	activeIntervals.push(id);
	return id;
}

function untrackInterval(id) {
	var idx = activeIntervals.indexOf(id);
	if (idx !== -1) activeIntervals.splice(idx, 1);
}

function patchTransport(socket) {
	var ws = socket?.webSocket;
	if (!ws || typeof ws.send !== "function") return;
	if (patchedTransports.has(ws)) return;

	var origWsSend = ws.send.bind(ws);
	patchedTransports.set(ws, origWsSend);

	ws.send = function (data) {
		try {
			if (typeof data === "string") {
				var parsed = JSON.parse(data);
				if (parsed?.op === IDENTIFY && parsed.d?.properties) {
					var spoof = getSpoof();
					if (spoof) {
						Object.assign(parsed.d.properties, spoof);
						data = JSON.stringify(parsed);
					}
				}
			}
		} catch (e) {}
		return origWsSend(data);
	};
}

function unpatchTransport(socket) {
	var ws = socket?.webSocket;
	if (ws && patchedTransports.has(ws)) {
		ws.send = patchedTransports.get(ws);
		patchedTransports.delete(ws);
	}
}

function patchSocket(socket) {
	if (!socket) return;
	patchTransport(socket);
	if (socket.__psPatched) return;

	origSend = socket.send.bind(socket);
	socket.send = function (op, data, flag) {
		if (op === IDENTIFY && data?.properties) {
			var spoof = getSpoof();
			if (spoof) Object.assign(data.properties, spoof);
		}
		return origSend.call(this, op, data, flag);
	};

	if (typeof socket.handleIdentify === "function") {
		origHandleIdentify = socket.handleIdentify.bind(socket);
		socket.handleIdentify = function () {
			var result = origHandleIdentify.apply(this, arguments);
			patchTransport(socket);
			return result;
		};
	}

	socket.__psPatched = true;
	patchedSocket = socket;
}

function teardown() {
	activeIntervals.forEach(clearInterval);
	activeIntervals = [];
	if (pendingRetryTimeout) {
		clearTimeout(pendingRetryTimeout);
		pendingRetryTimeout = null;
	}
	if (patchedSocket) {
		unpatchTransport(patchedSocket);
		if (origSend) patchedSocket.send = origSend;
		if (origHandleIdentify) patchedSocket.handleIdentify = origHandleIdentify;
		delete patchedSocket.__psPatched;
	}
	origSend = origHandleIdentify = patchedSocket = null;
}

function watchForQuickFailure(ws, socket) {
	if (typeof ws.addEventListener !== "function") return;
	var connectedAt = Date.now();
	try {
		ws.addEventListener("close", function (evt) {
			var elapsed = Date.now() - connectedAt;
			if (elapsed < 3000 && !socket.sessionId) log("reconnect closed after " + elapsed + "ms, code:", evt?.code);
		}, { once: true });
	} catch (e) {}
}

function watchForNewTransport(socket, previousWs) {
	var attempts = 0;
	var id = setInterval(function () {
		attempts++;
		var current = socket.webSocket;
		if (current) {
			patchTransport(socket);
			if (current !== previousWs) {
				clearInterval(id);
				untrackInterval(id);
				watchForQuickFailure(current, socket);
				return;
			}
		}
		if (attempts > 40) {
			clearInterval(id);
			untrackInterval(id);
		}
	}, 200);
	trackInterval(id);
}

function forceIdentify() {
	var now = Date.now();
	if (lastIdentifyAt && now - lastIdentifyAt < MIN_RECONNECT_INTERVAL_MS) {
		if (!pendingRetryTimeout) {
			var wait = MIN_RECONNECT_INTERVAL_MS - (now - lastIdentifyAt) + 50;
			pendingRetryTimeout = setTimeout(function () {
				pendingRetryTimeout = null;
				forceIdentify();
			}, wait);
		}
		return;
	}

	var socket = getSocket();
	if (!socket) return;

	try {
		if (!socket.__psPatched) {
			teardown();
			patchSocket(socket);
		} else {
			patchTransport(socket);
		}

		lastIdentifyAt = Date.now();
		identifyListeners.forEach(function (fn) {
			try { fn(); } catch (e) {}
		});

		socket.sessionId = null;
		socket.seq = 0;

		var ws = socket.webSocket;

		function pollBeforeConnect(afterMs, attempt) {
			setTimeout(function () {
				var fresh = socket.webSocket;
				if (fresh && fresh !== ws && (fresh.readyState === 0 || fresh.readyState === 1)) {
					watchForNewTransport(socket, ws);
					return;
				}
				if (attempt < 5) {
					pollBeforeConnect(100, attempt + 1);
					return;
				}
				try {
					socket.connect();
				} catch (e) {
					log("forced connect() threw:", e?.message);
				}
				watchForNewTransport(socket, ws);
			}, afterMs);
		}

		if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
			ws.close();
			pollBeforeConnect(300, 0);
		} else if (!ws) {
			socket.close();
			pollBeforeConnect(500, 0);
		} else {
			pollBeforeConnect(300, 0);
		}
	} catch (e) {
		log("forceIdentify failed:", e?.message);
	}
}

var ICONS = {
	off: { name: "PSMobileIcon", w: 32, h: 32, data: "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" },
	web: { name: "PSGlobeIcon", w: 64, h: 64, data: "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" },
	meta: { name: "PSVrIcon", w: 32, h: 32, data: "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" },
	console: { name: "PSConsoleIcon", w: 32, h: 32, data: "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" },
};

function registerIcons() {
	if (registerIcons.done) return;
	for (var key in ICONS) {
		var icon = ICONS[key];
		try {
			icon.id = revenge.assets.registerAsset({ name: icon.name, type: "png", uri: "data:image/png;base64," + icon.data, width: icon.w, height: icon.h });
		} catch (e) {}
	}
	registerIcons.done = true;
}

function getRowIcon(value, fallback) {
	var icon = ICONS[value];
	if (!icon || icon.id === undefined) return fallback;
	return icon.id;
}

function SettingsComponent() {
	var React = revenge.react.React;
	var RN = revenge.react.ReactNative;
	var View = RN.View;
	var Text = RN.Text;
	var Pressable = RN.Pressable;
	var Image = RN.Image;
	var TableRowAssetIcon = revenge.components.TableRowAssetIcon;

	var fallbackIcon = revenge.assets.getAssetIdByName("LaptopPhoneIcon") || null;
	var ACCENT = "#5865F2";

	var state = React.useState(getPlatform());
	var current = state[0], setCurrent = state[1];
	var statusState = React.useState("");
	var status = statusState[0], setStatus = statusState[1];

	React.useEffect(function () {
		var actual = getPlatform();
		if (actual !== current) setCurrent(actual);
	}, []);

	React.useEffect(function () {
		var interval = null;

		function track() {
			if (interval) clearInterval(interval);
			setStatus("Updating\u2026");
			var start = Date.now();
			interval = setInterval(function () {
				var socket = getSocket();
				var ws = socket?.webSocket;
				var elapsed = Date.now() - start;
				if (ws?.readyState === 1 && socket?.sessionId) {
					setStatus("Updated in " + (elapsed / 1000).toFixed(1) + "s");
					clearInterval(interval);
					interval = null;
				} else if (elapsed > 20000) {
					setStatus("Still reconnecting\u2026");
					clearInterval(interval);
					interval = null;
				}
			}, 300);
		}

		identifyListeners.push(track);
		if (lastIdentifyAt) track();

		return function () {
			identifyListeners = identifyListeners.filter(function (fn) { return fn !== track; });
			if (interval) clearInterval(interval);
		};
	}, []);

	function select(value) {
		if (value === current) return;
		setCurrent(value);
		setPlatform(value);
		forceIdentify();
	}

	var warning = React.createElement(
		View,
		{ style: { borderWidth: 1, borderColor: "#F0B232", backgroundColor: "rgba(240,178,50,0.08)", borderRadius: 12, padding: 14, marginHorizontal: 16, marginTop: 12, marginBottom: 18 } },
		React.createElement(Text, { style: { fontSize: 15, fontWeight: "700", color: "#F0B232", marginBottom: 6 } }, "Use at your own risk"),
		React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,235,205,0.85)", lineHeight: 18 } },
			"This spoofs your Discord gateway IDENTIFY payload, which is against Discord's Terms of Service. Your account could be actioned for using this.")
	);

	var rows = React.createElement(
		View,
		{ style: { marginHorizontal: 16, borderRadius: 12, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.04)" } },
		PLATFORMS.map(function (opt, i) {
			var selected = current === opt.value;
			var isLast = i === PLATFORMS.length - 1;
			var rowIcon = getRowIcon(opt.value, fallbackIcon);
			return React.createElement(
				Pressable,
				{
					key: opt.value,
					onPress: function () { select(opt.value); },
					style: function (s) {
						return {
							flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 14,
							backgroundColor: s.pressed ? "rgba(255,255,255,0.06)" : selected ? "rgba(88,101,242,0.14)" : "transparent",
							borderBottomWidth: isLast ? 0 : 1, borderBottomColor: "rgba(255,255,255,0.06)",
						};
					},
				},
				rowIcon
					? React.createElement(
							View,
							{ style: { marginRight: 12 } },
							TableRowAssetIcon
								? React.createElement(TableRowAssetIcon, { source: rowIcon })
								: React.createElement(Image, { source: rowIcon, style: { width: 20, height: 20, tintColor: selected ? ACCENT : "rgba(255,255,255,0.7)" }, resizeMode: "contain" })
						)
					: null,
				React.createElement(Text, { style: { flex: 1, fontSize: 16, color: "#fff", fontWeight: selected ? "600" : "400" } }, opt.label),
				React.createElement(
					View,
					{ style: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: selected ? ACCENT : "rgba(255,255,255,0.35)", alignItems: "center", justifyContent: "center" } },
					selected ? React.createElement(View, { style: { width: 12, height: 12, borderRadius: 6, backgroundColor: ACCENT } }) : null
				)
			);
		})
	);

	return React.createElement(
		revenge.components.Page,
		null,
		warning,
		React.createElement(Text, { style: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.45)", letterSpacing: 0.5, textTransform: "uppercase", marginHorizontal: 16, marginBottom: 8 } }, "Spoofed Platform"),
		rows,
		status ? React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,255,255,0.5)", marginHorizontal: 16, marginTop: 10 } }, status) : null,
		React.createElement(View, { style: { height: 24 } })
	);
}

var DEBUG = false;
function log() {
	if (DEBUG) console.log.apply(console, ["[PlatformSpoof]"].concat([].slice.call(arguments)));
}

function waitForSocketAndPatch() {
	var attempts = 0;
	var id = setInterval(function () {
		attempts++;
		var socket = getSocket();
		if (socket) {
			clearInterval(id);
			untrackInterval(id);
			patchSocket(socket);
			if (getPlatform() !== "off") forceIdentify();
			return;
		}
		if (attempts > 150) {
			clearInterval(id);
			untrackInterval(id);
			log("gave up waiting for socket after", attempts, "attempts");
		}
	}, 50);
	trackInterval(id);
}

export default plugin({
	start: async function (ctx) {
		var cleanup = ctx.cleanup;

		registerIcons();
		await storage.get();

		cleanup(
			revenge.modules.finders.getModules(
				revenge.modules.finders.filters.withProps("getSocket", "isConnected"),
				function (mod) {
					socketModule = mod;
					var socket = getSocket();
					if (!socket) {
						waitForSocketAndPatch();
						return;
					}
					patchSocket(socket);
					if (getPlatform() !== "off") forceIdentify();
				}
			)
		);

		window.__ps = {
			status: function () {
				var s = getSocket();
				var out = { patched: !!s?.__psPatched, platform: getPlatform(), session: s?.sessionId, wsReadyState: s?.webSocket?.readyState };
				console.log("[PlatformSpoof]", JSON.stringify(out));
				return out;
			},
			reconnect: function () {
				forceIdentify();
				return "reconnect requested (rate-limited to 1 per 3s)";
			},
			debug: function (on) {
				DEBUG = on !== false;
				return DEBUG;
			},
			sessions: function () {
				var mod = null;
				try {
					var result = revenge.modules.finders.lookupModule(
						revenge.modules.finders.filters.withProps("getSessions")
					);
					mod = result?.[0];
				} catch (e) {
					console.log("[PlatformSpoof] sessions lookup threw:", e?.message);
				}
				var sessions = mod?.getSessions?.();
				if (!sessions) {
					console.log("[PlatformSpoof] no session module/data found, modFound=" + !!mod);
					return null;
				}
				var out = Object.values(sessions).map(function (s) {
					return { id: s.sessionId?.slice(0, 8), status: s.status, client: s.clientInfo?.client, os: s.clientInfo?.os, version: s.clientInfo?.version };
				});
				console.log("[PlatformSpoof] sessions", JSON.stringify(out));
				return out;
			},
		};

		cleanup(function () {
			teardown();
			socketModule = null;
			delete window.__ps;
		});
	},
	stop: function () {
		teardown();
		socketModule = null;
		delete window.__ps;
	},
	SettingsComponent: SettingsComponent,
});