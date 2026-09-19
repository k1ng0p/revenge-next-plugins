const PLATFORMS = [
	{ label: "Off", value: "off", description: "Default mobile status" },
	{ label: "Desktop (Windows)", value: "desktop", description: "Shows Desktop client icon" },
	{ label: "Web / Browser (Chrome)", value: "web", description: "Shows Browser icon" },
	{ label: "Meta Quest / VR", value: "meta", description: "Shows VR Icon" },
	{ label: "Console (PlayStation)", value: "console", description: "Shows PlayStation Icon" },
];

const SPOOF = {
	desktop: { browser: "Discord Client" },
	web: { browser: "Chrome" },
	meta: { browser: "Discord VR" },
	console: { browser: "Discord Embedded" },
};

const storage = revenge.jsonStorage.getJsonStorage(
	revenge.jsonStorage.pluginStoragePathFor("k1ngop.platform-spoof"),
	{ default: { platform: "off" }, load: true }
);

const getPlatform = () => storage.cache?.platform ?? "off";
const setPlatform = (value) => storage.set({ platform: value });

function getSpoof() {
	return SPOOF[getPlatform()] || null;
}

const IDENTIFY = 2;
const MIN_RECONNECT_INTERVAL_MS = 3000;

let socketModule = null;
let patchedSocket = null;
let origSend = null;
let origHandleIdentify = null;
let lastIdentifyAt = null;
let pendingRetryTimeout = null;
let identifyListeners = [];
let activeIntervals = [];
const patchedTransports = new WeakMap();

let epoch = 0;

const getSocket = () => socketModule?.getSocket() ?? null;

function trackInterval(id) {
	activeIntervals.push(id);
	return id;
}
function untrackInterval(id) {
	const i = activeIntervals.indexOf(id);
	if (i !== -1) activeIntervals.splice(i, 1);
}

function patchTransport(socket) {
	const ws = socket?.webSocket;
	if (!ws || typeof ws.send !== "function" || patchedTransports.has(ws)) return;

	const origWsSend = ws.send.bind(ws);
	patchedTransports.set(ws, origWsSend);

	ws.send = function (data) {
		try {
			if (typeof data === "string") {
				const parsed = JSON.parse(data);
				if (parsed?.op === IDENTIFY && parsed.d?.properties) {
					const spoof = getSpoof();
					if (spoof) {
						Object.assign(parsed.d.properties, spoof);
						data = JSON.stringify(parsed);
					}
				}
			}
		} catch (e) {
		}
		return origWsSend(data);
	};
}

function unpatchTransport(socket) {
	const ws = socket?.webSocket;
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
			const spoof = getSpoof();
			if (spoof) Object.assign(data.properties, spoof);
		}
		return origSend.call(this, op, data, flag);
	};

	socket.__psPatched = true;
	patchedSocket = socket;

	if (typeof socket.handleIdentify === "function") {
		origHandleIdentify = socket.handleIdentify.bind(socket);
		socket.handleIdentify = function () {
			const result = origHandleIdentify.apply(this, arguments);
			patchTransport(socket);
			return result;
		};
	}
}

function teardown() {
	epoch++;
	activeIntervals.forEach(clearInterval);
	activeIntervals = [];
	if (pendingRetryTimeout) {
		clearTimeout(pendingRetryTimeout);
		pendingRetryTimeout = null;
	}
	lastIdentifyAt = null;
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
	const connectedAt = Date.now();
	try {
		ws.addEventListener("close", (evt) => {
			const elapsed = Date.now() - connectedAt;
			if (elapsed < 3000 && !socket.sessionId) log("reconnect closed after " + elapsed + "ms, code:", evt?.code);
		}, { once: true });
	} catch (e) {}
}

function retargetToLiveSocket(staleSocket, forEpoch) {
	const live = getSocket();
	if (!live || live === staleSocket) return false;
	log("socket instance changed under us, retargeting");
	if (!live.__psPatched) patchSocket(live);
	const ws = live.webSocket;
	if (ws) {
		patchTransport(live);
		watchForQuickFailure(ws, live);
	} else {
		watchForNewTransport(live, null, forEpoch);
	}
	return true;
}

function watchForNewTransport(socket, previousWs, forEpoch) {
	let attempts = 0;
	const id = setInterval(() => {
		if (forEpoch !== epoch) {
			clearInterval(id);
			untrackInterval(id);
			return;
		}
		attempts++;
		if (retargetToLiveSocket(socket, forEpoch)) {
			clearInterval(id);
			untrackInterval(id);
			return;
		}
		const current = socket.webSocket;
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
	const now = Date.now();
	if (lastIdentifyAt && now - lastIdentifyAt < MIN_RECONNECT_INTERVAL_MS) {
		if (!pendingRetryTimeout) {
			const wait = MIN_RECONNECT_INTERVAL_MS - (now - lastIdentifyAt) + 50;
			pendingRetryTimeout = setTimeout(() => {
				pendingRetryTimeout = null;
				forceIdentify();
			}, wait);
		}
		return;
	}

	const socket = getSocket();
	if (!socket) return;

	let forEpoch = epoch;

	try {
		if (!socket.__psPatched) {
			teardown();
			forEpoch = epoch;
			patchSocket(socket);
		} else {
			patchTransport(socket);
		}

		lastIdentifyAt = Date.now();
		identifyListeners.forEach((fn) => { try { fn(); } catch (e) {} });

		socket.sessionId = null;
		socket.seq = 0;

		const ws = socket.webSocket;

		function pollBeforeConnect(afterMs, attempt) {
			setTimeout(() => {
				if (forEpoch !== epoch) return;
				if (retargetToLiveSocket(socket, forEpoch)) return;

				const fresh = socket.webSocket;
				if (fresh && fresh !== ws && (fresh.readyState === 0 || fresh.readyState === 1)) {
					watchForNewTransport(socket, ws, forEpoch);
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
				watchForNewTransport(socket, ws, forEpoch);
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

const ICONS = {
	off: "MobilePhoneIcon",
	desktop: "ScreenIcon",
	web: "GlobeEarthIcon",
	meta: "VrHeadsetIcon",
	console: "ic_playstation_device_ps5_32px",
};

function getRowIcon(value) {
	const name = ICONS[value];
	if (!name) return undefined;
	try {
		return revenge.assets.getAssetIdByName(name, "png");
	} catch (e) {
		return undefined;
	}
}

function SettingsComponent() {
	const React = revenge.react.React;
	const { View, Text, Image, Pressable } = revenge.react.ReactNative;
	let { TableRowAssetIcon, Card, TableRadioGroup, TableRadioRow } = revenge.components;

	if (!TableRadioGroup || !TableRadioRow) {
		try {
			const found = revenge.modules.finders.lookupModule(
				revenge.modules.finders.filters.withProps("TableRadioGroup", "TableRadioRow")
			)?.[0];
			if (found) {
				TableRadioGroup = TableRadioGroup || found.TableRadioGroup;
				TableRadioRow = TableRadioRow || found.TableRadioRow;
			}
		} catch (e) {}
	}

	const ACCENT = "#5865F2";

	const [current, setCurrent] = React.useState(getPlatform());
	const [status, setStatus] = React.useState("");

	React.useEffect(() => {
		const actual = getPlatform();
		if (actual !== current) setCurrent(actual);
	}, []);

	React.useEffect(() => {
		let interval = null;

		function track() {
			if (interval) clearInterval(interval);
			setStatus("Updating\u2026");
			const start = Date.now();
			interval = setInterval(() => {
				const socket = getSocket();
				const ws = socket?.webSocket;
				const elapsed = Date.now() - start;
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

		return () => {
			identifyListeners = identifyListeners.filter((fn) => fn !== track);
			if (interval) clearInterval(interval);
		};
	}, []);

	function select(value) {
		if (value === current) return;
		setCurrent(value);
		setPlatform(value);
		forceIdentify();
	}

	const warning = Card
		? React.createElement(
				Card,
				{ style: { marginHorizontal: 16, marginTop: 12, marginBottom: 0 } },
				React.createElement(Text, { style: { fontSize: 15, fontWeight: "700", color: "#F0B232", marginBottom: 6 } }, "Use at your own risk"),
				React.createElement(Text, { style: { fontSize: 13, lineHeight: 18 } },
					"This spoofs your Discord gateway IDENTIFY payload, which is against Discord's Terms of Service. Your account could be actioned for using this.")
			)
		: React.createElement(
				View,
				{ style: { borderWidth: 1, borderColor: "#F0B232", backgroundColor: "rgba(240,178,50,0.08)", borderRadius: 12, padding: 14, marginHorizontal: 16, marginTop: 12, marginBottom: 0 } },
				React.createElement(Text, { style: { fontSize: 15, fontWeight: "700", color: "#F0B232", marginBottom: 6 } }, "Use at your own risk"),
				React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,235,205,0.85)", lineHeight: 18 } },
					"This spoofs your Discord gateway IDENTIFY payload, which is against Discord's Terms of Service. Your account could be actioned for using this.")
			);

	const usingNativeGroup = !!(TableRadioGroup && TableRadioRow);
	const rows = usingNativeGroup
		? React.createElement(
				TableRadioGroup,
				{ title: "select a platform to spoof", titleStyle: { marginLeft: 4 }, value: current, onChange: select },
				PLATFORMS.map((opt) => {
					const rowIcon = getRowIcon(opt.value);
					return React.createElement(TableRadioRow, {
						key: opt.value,
						label: opt.label,
						subLabel: opt.description,
						value: opt.value,
						selected: current === opt.value,
						icon: rowIcon != null ? React.createElement(TableRowAssetIcon || Image, { source: rowIcon }) : undefined,
						onPress: () => select(opt.value),
					});
				})
			)
		: React.createElement(
				View,
				{ style: { marginHorizontal: 16, borderRadius: 12, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.04)" } },
				PLATFORMS.map((opt, i) => {
					const selected = current === opt.value;
					const rowIcon = getRowIcon(opt.value);
					return React.createElement(
						Pressable,
						{
							key: opt.value,
							onPress: () => select(opt.value),
							style: (s) => ({
								flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 14,
								backgroundColor: s.pressed ? "rgba(255,255,255,0.06)" : selected ? "rgba(88,101,242,0.14)" : "transparent",
								borderBottomWidth: i === PLATFORMS.length - 1 ? 0 : 1, borderBottomColor: "rgba(255,255,255,0.06)",
							}),
						},
						rowIcon != null
							? React.createElement(
									View,
									{ style: { marginRight: 12 } },
									TableRowAssetIcon
										? React.createElement(TableRowAssetIcon, { source: rowIcon })
										: React.createElement(Image, { source: rowIcon, style: { width: 20, height: 20, tintColor: selected ? ACCENT : "rgba(255,255,255,0.7)" }, resizeMode: "contain" })
								)
							: null,
						React.createElement(
							View,
							{ style: { flex: 1 } },
							React.createElement(Text, { style: { fontSize: 16, color: "#fff", fontWeight: selected ? "600" : "400" } }, opt.label),
							opt.description
								? React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,255,255,0.5)", marginTop: 2 } }, opt.description)
								: null
						),
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
		usingNativeGroup
			? null
			: React.createElement(Text, { style: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.45)", letterSpacing: 0.5, textTransform: "uppercase", marginHorizontal: 16, marginBottom: 8 } }, "Select a platform to spoof"),
		rows,
		status ? React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,255,255,0.5)", marginHorizontal: 16, marginTop: 10 } }, status) : null,
		React.createElement(View, { style: { height: 24 } })
	);
}

let DEBUG = false;
function log(...args) {
	if (DEBUG) console.log("[PlatformSpoof]", ...args);
}

function waitForSocketAndPatch() {
	let attempts = 0;
	const forEpoch = epoch;
	const id = setInterval(() => {
		if (forEpoch !== epoch) {
			clearInterval(id);
			untrackInterval(id);
			return;
		}
		attempts++;
		const socket = getSocket();
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

function startBootWatchdog() {
	let elapsed = 0;
	let lastSeen = getSocket();
	const id = setInterval(() => {
		elapsed += 500;
		const live = getSocket();
		if (live && live !== lastSeen) {
			lastSeen = live;
			log("boot watchdog caught socket swap at", elapsed, "ms");
			if (!live.__psPatched) patchSocket(live);
			if (getPlatform() !== "off") forceIdentify();
		}
		if (elapsed >= 15000) {
			clearInterval(id);
			untrackInterval(id);
		}
	}, 500);
	trackInterval(id);
}

export default plugin({
	start: async function (ctx) {
		await storage.get();

		ctx.cleanup(
			revenge.modules.finders.getModules(
				revenge.modules.finders.filters.withProps("getSocket", "isConnected"),
				(mod) => {
					socketModule = mod;
					const socket = getSocket();
					if (!socket) {
						waitForSocketAndPatch();
						return;
					}
					patchSocket(socket);
					if (getPlatform() !== "off") forceIdentify();
				}
			)
		);

		startBootWatchdog();

		window.__ps = {
			status: () => {
				const s = getSocket();
				const out = { patched: !!s?.__psPatched, platform: getPlatform(), session: s?.sessionId, wsReadyState: s?.webSocket?.readyState };
				console.log("[PlatformSpoof]", JSON.stringify(out));
				return out;
			},
			reconnect: () => {
				forceIdentify();
				return "reconnect requested (rate-limited to 1 per 3s)";
			},
			debug: (on) => (DEBUG = on !== false),
			sessions: () => {
				let mod = null;
				try {
					mod = revenge.modules.finders.lookupModule(
						revenge.modules.finders.filters.withProps("getSessions")
					)?.[0];
				} catch (e) {
					console.log("[PlatformSpoof] sessions lookup threw:", e?.message);
				}
				const sessions = mod?.getSessions?.();
				if (!sessions) {
					console.log("[PlatformSpoof] no session module/data found, modFound=" + !!mod);
					return null;
				}
				const out = Object.values(sessions).map((s) => ({
					id: s.sessionId?.slice(0, 8), status: s.status, client: s.clientInfo?.client, os: s.clientInfo?.os, version: s.clientInfo?.version,
				}));
				console.log("[PlatformSpoof] sessions", JSON.stringify(out));
				return out;
			},
		};

		ctx.cleanup(() => {
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
	SettingsComponent,
});
