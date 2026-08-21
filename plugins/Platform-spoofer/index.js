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

const IDENTIFY = 2; // gateway opcode, same across every client build
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

// bumps on teardown so a stale reconnect chain from a killed cycle
// notices and bails instead of writing into fresh state
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
			// probably not JSON, or just not an identify frame — whatever, let it through
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
	patchTransport(socket); // reconnect swaps the ws every time, so keep this unconditional
	if (socket.__psPatched) return; // but the send() override only needs doing once

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

// on cold boot the socket module sometimes swaps its internal instance mid-reconnect
// (not just the transport) — this catches that and retargets onto whatever's live now
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
			forEpoch = epoch; // teardown just bumped this, grab the current value
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
	off: { name: "PSMobileIcon", w: 64, h: 64, data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACRUlEQVR42u2bvW7TUBTHf0lDhESFQAIm2gdo+Rj6DkW8Aa/AzMIGTKg7qF0AsfEESMAzsCLBhlhApExFRYntMPhccbEyONfOcdL8/9JVZF/b5/h37ocjnQPSeqvX4rMuAJvAYME+Z8AJ8HtZIG4DR8AxMHVqx2Zzu+sRcBd4Gx2PLUKL1AAYRsd3gPddRP6mRWMCnAK54wjIzebEjm94v3wf+GKOeL74LBC5+dL3BLAbRX/acQs+7KTOpxTtAYW1oMLWAA8No4gHP/aAT14ArpoDRWVanO9gLSrM9jXPEdCb4cBH4A2wYfNyEQrPvheNwkY7WhsfLWOL/CvguVPUTw1A4ynX5sq56TjsW7PVJoDcEUC+jABWUgIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIwl6aOfk+XEcA5++0t8MV7FVuN1UaSVEiNewI8qHlPQZnmEuf6bcwRkIuR7T9dAwgaAlfWfREsarSQTf6UMuH6FnBg57Kaz2CZpsA8QMc2Uu5T5vsHPQS+Ac+ia87cNljYi42A1zP6XwK/7JrirAIA+EqZ4V1VZn2sAoA80VYG3AYuz+i/ZH1Zol+5J4AR/5Kk57U1AF7wf2Z5yDXuJ/gVstZHnrvHDukFE6HC5DvwCHgM/Kj0uRVMNJk6n0kvmZnUPFcXpnvJDJSFSk2KpnK7d5J4b1w0tdv02zpV+8C7yj7vXTa3D3zo8mtyC//CyZ/AIXC9rX9XbWhtS2elVdZfJ4hm30PcJXYAAAAASUVORK5CYII=" },
	desktop: { name: "PSDesktopIcon", w: 64, h: 64, data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAACqUlEQVR42u2bv4sTQRTHP+7thWBEThEOUcgVmtrGTkvBsxH/ArFR5PwHRAsrKy1s/ScsFOyFQ7E4EBHBSm3k0GuCHsmeu2uRN2SY7GX3kp0cs74vDLvZeTOz7ztv37z5EVAoFIr/GEf2eb4EXAAuAscC1/E38B74AKRVCqwBn4G8YekT0C2zgFXgO9AC/kpqAmJJCXAW+GkyIkfwiSg/kALtBijfFl0GotvT/SzgOPBDhKICckJHJikBTgN9YxoGHeCoMGV6PgEeAXtCVh6Qc8+BZXl/06mJ6NgxBNg4I4X+iLfMge0G9Py26JKKbrnoWugDXERThspQLCEqU7AMecAElL570xzdgaEEKAFKgBKgBCgBSoASoAQoAUqAEqAEKAFKgBKgBCgBSoAS4CL0ZfG5CMgIf1k8myYQlxCzAtwn7K2xlWmdHZdU1AIeN9kHxBVkBp7abjPee1z13E4l2JujPk9qpJKuMd6Gv2Ll+Wx7YnN00QTsyfVOQft3HZmFEBA5HtM3Erm+Ksh76cj4Hh0mCEgsx5d5jju6BXldz8FZJroBDIsEloB3YoJDz9//R+Ck1fYJRqe4Uo9+YCi6vbVJdiOly8AbxoekIg+9n8l9H3gmvzeAU1YeNVthxujEWxu4BGxOE76F/zN7acVndaebVWPlNeA2cEN6pg60GJ1Es3vF9ju2tfVrdIa/gBfAc+DrYU5IehWGWZPXW9REbBHTYTPknKsQfcaObMgTsQmityp86yZvK/Bp+ATuHSDKMzIbTVC8AzycIcQ1sg+kjiBxHdiZI743ZXakrqDQcyKweaI3c38+pFFgXcbxXSv+njV22JW6rh7Wgsgs+Mb4Txd1LHS0GP2RIxgsy6SjrhB2U+r0FqX5ImHdiupmxRfgtThFhUKhUNSJfzNF0udDQf1PAAAAAElFTkSuQmCC" },
	web: { name: "PSGlobeIcon", w: 64, h: 64, data: "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" },
	meta: { name: "PSVrIcon", w: 64, h: 64, data: "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" },
	console: { name: "PSConsoleIcon", w: 64, h: 64, data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEy0lEQVR42u2b3W7jRBTHf3Gcdj+6tLR0N7RCC1qxSCsk3oBH4ALBA3CD+LhCvABXXCLBU/AA8BbcIMQFQkDpfrTdpts0aZovx+GiM+rR4HHsxGciRI80suV4xvZv/nPmnHEM1/b/tlrAazWBexVccwjsAf1lAVsBVnNK3akTA98B0wrLPvBe6Id/CPxY4Oa+cup9XfHDy/JuqId/vcRNfSvqrQE9YAx8YdTTMCUuWWy9LeAH0+afiw6popW/Bz4EfgY+A05N3ak4ZwpEQMsUgB3gqdlfBzoVdcgj4FcgAbaBtva43wMmwPsl675lwPSBWxXe065Q3PYiDcUFz0tN7w4LArPquG+O7RvJVmWp2K+HANAz29Wcc24CnwCfmh7CQAM4MAr6zwKwc27D8/sN4BfggXM8MdvHjr9Y1CbAyDjVhQBEBc6ZCgA+YF+ahz93escCeFYxgFS0rQ4AYGC2Kxm/rRrZJ8bRZbX5vGLHnArQcQgA/RwAu6YkOe0dKQBIQgK4yAHwRoH2DxQVEGQIdERk59rdnLbssVbFACZCAY0QAGykdSfjt40C7VcdqSUiJlkLAeDMbF/KARB5gqfEzA5VK6BXoAMqA9AVAGol2xgo5O6pmJk2QvqALAWMMqIz14GOFHKUTkgA5+JiNQ+AvDA6UQBwlNMpagC2MgDMerinSlnq4TKGwE5GnfGMhOUPJQCtnJlJDcBmCQDW9pQAWGUttNBaNhLMCjxmKeCJEoAnIhSvawMYOqlvGQUcKQGwCdb9RaLBMgCst79dUgHHSgBORCi+og1gJMLZtZKzwAslAF2xf0sbQCIArHuGRzrDgVZtI+GbXg4B4MxzsYFH/nHBQGleG4sZ5lVtAKlQwGaOg5QWGzhaABLgd7P/IASArpP/FwmFj5XCYHtPf5v9t7UBSKfTLAAgFZ56gp7ZIfBOCADWB2yXyAa1AfwlOiXSBvDcMwvkKeAF1S6Hu2aHwCtcvphRBXAoko+aszrja0sbwJFwzBvaAFoi/45mALAKaKNrbZGqN7UBnIj8Oy6oAG0AfS5f1QO8pg2gLRTQ8ABInXZbygCmXP5PwCZFqgA6IhJczQCQN2w07SezfVMbgF2GXnE8rn1NFWW0exIAwG9m+3CeqbBMhYEn+5o4CyZZsYOm7Zvto3kWRsoAGIkxftsB0PO02wkAwE7Pu/MsjJQBkIp5d91xRANPu70AAKTK7mgCmHK1DrfhgOl7wuFhAAA9sehyVxvAM7O/5QDoeRQzDgBgKELipjaAQxF7y+NDD4AkAIAJV+uO9zQByGlt0wHQ9wCYBACQimiwqQ2g7QFw4ckDpoSxucPhsgDOxBCoZcwCaUb6HMKsE9wJBaDIsthxQAUceNYqKgfQFatCck0gawicBVRAy7NWUTmAcwFg1nzfDQjAXr+hDcBe6IZTN2sIXCwBQD0UgNip21syAPlP1kgTwEjUq2cMDWYc07Kx6BhVBYxFvdijgHQJChgJHxCFAODWPZ1xbigFRNoKODXjLQE+4nJlqCGSI6mMj81sYT94iisu9iOqm8DnXL3AVc9Av+HfX4qNzTCQZYLe53K+8kEIudkPIcdLeEBf6RoVlLZFvrnbFgFR3ZkVphW0XyYbfOzxQ9d2bTPsH+/Hw9Baj/yKAAAAAElFTkSuQmCC" },
};

function registerIcons() {
	if (registerIcons.done) return; // only need to do this once per session
	for (const key in ICONS) {
		const icon = ICONS[key];
		try {
			icon.id = revenge.assets.registerAsset({ name: icon.name, type: "png", uri: "data:image/png;base64," + icon.data, width: icon.w, height: icon.h });
		} catch (e) {
			// registerAsset can throw if the name's already taken from a previous load, not fatal
		}
	}
	registerIcons.done = true;
}

function getRowIcon(value) {
	return ICONS[value]?.id;
}

function SettingsComponent() {
	const React = revenge.react.React;
	const { View, Text, Image, Pressable } = revenge.react.ReactNative;
	let { TableRowAssetIcon, Card, TableRadioGroup, TableRadioRow } = revenge.components;

	// these can resolve late depending on when this screen first mounts —
	// take a second shot via lookupModule before falling back to hand-rolled UI
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

// backup for the boot-time patch in case it misses a socket swap outside its
// own polling window — checks twice a second for 15s then just gives up
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
		registerIcons();
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
			// quick console helpers for testing — __ps.status(), __ps.sessions(), etc
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