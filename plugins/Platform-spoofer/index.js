const PLATFORMS = [
	{ label: "Off", value: "off", description: "Default mobile status" },
	{ label: "Desktop (Windows)", value: "desktop", description: "Shows Desktop client icon" },
	{ label: "Web / Browser (Chrome)", value: "web", description: "Shows Browser icon" },
	{ label: "Meta Quest / VR", value: "meta", description: "Shows VR Icon" },
	{ label: "Console (PlayStation)", value: "console", description: "Shows PlayStation Icon" },
];

var SPOOF = {
	desktop: { browser: "Discord Client" },
	web: { browser: "Chrome" },
	meta: { browser: "Discord VR" },
	console: { browser: "Discord Embedded" },
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

// gateway op code for IDENTIFY — same on every Discord client
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
// bumped on every teardown so stale setTimeout/interval chains from a killed
// reconnect cycle can tell they're dead and bail instead of firing into fresh state
var epoch = 0;

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
		} catch (e) {
			// not JSON / not an IDENTIFY frame, just let it through unmodified
		}
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
	// always re-patch the transport since a reconnect swaps the ws instance,
	// but the socket-level send override only needs to happen once
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
	var connectedAt = Date.now();
	try {
		ws.addEventListener("close", function (evt) {
			var elapsed = Date.now() - connectedAt;
			if (elapsed < 3000 && !socket.sessionId) log("reconnect closed after " + elapsed + "ms, code:", evt?.code);
		}, { once: true });
	} catch (e) {}
}

function watchForNewTransport(socket, previousWs, forEpoch) {
	var attempts = 0;
	var id = setInterval(function () {
		if (forEpoch !== epoch) {
			clearInterval(id);
			untrackInterval(id);
			return;
		}
		attempts++;
		var liveSocket = getSocket();
		if (liveSocket && liveSocket !== socket) {
			clearInterval(id);
			untrackInterval(id);
			log("socket instance swapped mid-reconnect, retargeting");
			if (!liveSocket.__psPatched) patchSocket(liveSocket);
			var liveWs = liveSocket.webSocket;
			if (liveWs) {
				patchTransport(liveSocket);
				watchForQuickFailure(liveWs, liveSocket);
			} else {
				watchForNewTransport(liveSocket, null, forEpoch);
			}
			return;
		}
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

	var forEpoch = epoch;

	try {
		if (!socket.__psPatched) {
			teardown();
			forEpoch = epoch; // teardown bumps epoch, grab the new one
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
				if (forEpoch !== epoch) return;
				var liveSocket = getSocket();
				if (liveSocket && liveSocket !== socket) {
					log("socket instance swapped during boot reconnect, retargeting");
					if (!liveSocket.__psPatched) patchSocket(liveSocket);
					var liveWs = liveSocket.webSocket;
					if (liveWs && (liveWs.readyState === 0 || liveWs.readyState === 1)) {
						patchTransport(liveSocket);
						watchForQuickFailure(liveWs, liveSocket);
					} else {
						watchForNewTransport(liveSocket, null, forEpoch);
					}
					return;
				}
				var fresh = socket.webSocket;
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

var ICONS = {
	off: { name: "PSMobileIcon", w: 64, h: 64, data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAFbklEQVR42u2bwW/cVBDGf+N1stmEtClQqqoNoAZQwwUOLRQuXIqEuCD+UrghBEJCSCAEB+AAiKS5lCgICISUJG2y6+Hgme7Lw5v12t4EFT/JUt2135v3vZlv3ou/ESo0VRUgsdtMRJQzaKqaAFLHDqky+XggVZ0FFoAukFq/0vR87eoDD4A9ETkcZ9u4llZY+fj/FoEV4DpwBTgHzEzad4nWB46AXeBn4EdV3RCRe3VAkBqTn7UJvwq8FACwZAB0gjCp2zJgYADsAJvAD8A3wFd2f8wbyoIgE0xeRCSz+zngBeBN4F3gGtALJt6pGmInuD8GggNxANwB3gM+Bn4SkfsBN2gZENIJPCWxlcBW+Q3gHfOANIpTCYxuqokB6/yyBFy0cY6AX4Ff7Fm3VRvlgKBdsdW/YX1kNmhIfk2TYNxnZmPfsLD4PACgcRL0lUVVO8Bl4Dlz+4Gx8gDYA/4w92zKE8I+5oEnLOMklnV6ZstlVe2IyCC0txYAEfG5+y8CTwbvurvdBb4EPgTWzYBkEmNGTF6sfwGeB94CbgFXA5JNDZjHgL/cVrf/JC4o4wEh+XnsnQ8AEfOANeAT4AMR2Z3SxmcdmLPJPmWe4ItzHlhS1V2fsJNhkxyQGsqL0bv7BsA6sB94TtMh4OOsAS8DFwK7FgO7jqayETKXmw3SnTfPzwf2uxvQMeOzipN3Yh3Y/UzAM4fRczN2JdMgwaK4HMXQnqslJtCK+V+ClNY5wYZK2++0olHZCZ4RcoaW3ZCU3ICp2TxbMNmsCtBJjbgsSpOncSocNU4lD0imYJieEQCVSeZ/3VoAWgBaAFoAWgBaAFoAWgBaAFoAWgBaAFoAWgBaAFoAWgBaAFoAWgBaACo2OSWbGxVgNSlk0hAI/6pj/6412UD4JNFY/7kQeGhwg14RA9qopzXpARn5V+F+8H1+UFNEqZovv/fnUrkz9YCiT1MJuXChO2UuEBtnrsD2Sp/hm/KAeXKx5IvAlqpumTEd/0JcM6QGNuFLNsaKjVmbgNMahoUrcA54hVy0sAd8Sy6WcAWZqzxkAi/zdxJylWiPXJB5G7hpY9bODHUACBm5CzzDUNF5zQBIgueVf39BloIMEl4a8EvPVv8W8HQEanKaABSh7TrBZeBtchHlIHpOS8ZpUjCGq0MWyEVaoXKslhekDRGTa/NmyNWbF6e8GfLxatufTslArblbrPv+VAGIWV2jmC3S6rjL7pPL3Q8iUnR3nifX+/UYiiyLyFcKyLJStmnaA6QgLt3QPXKJ+xfAhrnxrP1+aBNbAV4HVsk1f6NIUs/SA8aRTVLA8gfkIsrPyKW0G7bqXfv9AUMprGeVVdvwUNDfKJtOjQS1ZJi4ru9v4Dtb/e+BP6PxjwJPuGAkejUAIGM6ZTgTA+Da/D5D9WZZ1t4Dfge27f1w4g7otj2zP+G21osoDifdDk96Fujbat4LJlGGrXvAs7ZZ6oqI2pXZ5Qeerq38sr1TNgN4LdE4uyp5gAay80xVd8h1wTEwnQIC1ACA6+RFFpmqrkUhMgg44DZ5Oc7cCTvGLCJRMZt2REQDlXi9ipHgGOrpZ2BI/xa4rxuTjBlnmVzrfxO4PyLF9YDHLRWmY0Jx4Acus2Xbwuwh+E3XDLkXDOy0t25u3bPVGpUC42PspQb+3JYyrErzDLNl1SITpcuqWWAT+Mj25a9xvGiKEoNX2elJwX6gD3xttmxOMwvEh5gd4FOLwcROfwsMNfvpiMmM2imO2umNYvsjc/c7wPtmy050OGuubjDggbDFhZOrxuBL9ltaQF5liKmo8sxLZg9tonc5zcLJGISw87MsnQWOlc6WKZKqfbp61IqnKxn5KJXP/wOb3yJVdmVzlAAAAABJRU5ErkJggg==" },
	web: { name: "PSGlobeIcon", w: 64, h: 64, data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAKh0lEQVR4nNWbf4xdVRHHP+/tbqmVWotBiohSaqSlFG0RBQryI5Ia6w8KEhuMEWhiNPywSqtgogK1GoX4E02UGKlK6B+1LFhpDAZFAUUUtKAiEFAjkqJCu/7Ydnffe/4x57tn3tlz77vv7dsmTnJz37v3nDkzc2bmzMw5t8bMQQ2oh3sLaHTZf8D1bYZ736E2Azjr4ZpIng8AC4CXAYcCLwZmBxpGgT3As8AzwO5M/0FMEM1+EttPAQwQZ0v/lwNnAKcAxwEvB17QAc8o8DTwMHAvcDfwoMMrrepWo2YMNOOCZcBm4BFMIOnVxGZ3PLkmiKqeXruATcDSknEPONSwWRacBdyGMSPCx7EZ3Q+MhauISS+gBlFI/t0YsB043Y0rX3FAwUt+Oca4Z2Af5Ux2c0kgqTC2MVUjDggMhvtBmKrvJ3p5/W4BfwW+A1wGnAO8FbgceJ52z150SQua7q7fE67d1cBQoMlr5IyAmF8GPOCImAgEt4A/AhcB8wpw/IbIYNms557LX7QCnq3h96+AJQmNfQchPh8YcQRJRVvAVxICBsL/WeF+Ap39gHA9DLwbWAl8OmnzONEPXIhp3j5M0zytfQMh/BDts+7vw6HN4eFec3ep6HDSJ8d8A/gbcFhCw1mYCZ2JxQ+ersXYStECLkneTRuE6GOOeD+DmrF7gd8C/wltod0mV1HOvH+3NvQ5CHNuOduW0xN9c4E7Qv+NybueQQg+SLvKV/HemsFDgJOAP9NuLkXM3x/6pUzLnHLLntoOYqtDC7g04aFrENJzqcZ8g2jfO4E5wCuAv5T0yQng7cn4VUER4gDwg4DrnB5xTarXYuBfRNssW6clpBbw7dD/BqoJTwJsYstlT0QThfBCzBxHgWMSnjqCpDiExeBldlvE1BjwWSzBaZa0S/u0gC2Bjl5VV4JbhPmjhwIvlSNGIbiW9lktYn4ceIJy59bpkpDGgDeE8evu3m2UJ+GtDfg3JbwVglRoCe3xu4/IFPFNYI7tOEzlRogh6zi2Lld1mDKRTwY6hpiqAYOBvkFiraGMIfXfHsY4xvUrBCG8vSLh8rQ14GsV+5Sp/4aEwFXADkydq8IAUWtqWAo+Dvww4bGQ+ZMdYU8CNwHvwXL62zHn8k3gHaGPt613Yfn79dhaXOYn0msvcEvA8xrg88DvwrvngPWBhs1YQeX4MF6RXQ9icQTEGObkMiHo4Y5A9GpixFUFcoT8gejhizx/C4vrjyRGjLsK2utSreF5LMz25rAWy1A9XW8OY+0Iz6aYgR4swpjf7joPMjUA0f8U1EZE3Uy5I9Xzax2Od4ZnO4FPYdUhxRi+7z4s0xQMhbHXAY8CXwa+RYxDmmG8xTkhyGFcExqfTnQ4vYCQ/4zyZVTPfwychvmA54CzHa5PuPZPY/nEB4CjgfnAR4GFoa0maAGWt6wBvhv6KlXfnPA82bEOPBUGkaftpdIizTiR8gCq6NoW+g8RTWJlwHdwMpbyiwbmI4Yw7fMg+5cAHnX8tRG8LDS4LvzvZfYHHAF3UT77PgZoYBHnJZiD8+aWi/tlgnUsxb4z4HpVaDMHE8ZCLBhqJtcKz7sY/XB4eR/RnnqF91VkPnWGYiCXCJUlQUtD/zuAV7r330/okM/ZEN4PeiS3OoJOKSCkCETYqRjz/yXG9p2YF3HbsFWnW83Tcnelw7mFqBXeBCWA4ZS/QSycVYdr3PNOICSXljBZNvNNzO8cEvBMp7i5FIslHsOc49W0C0H3J1LejsAyJ83YF8LzTgKQ85wP/IP2lLiKADQj3Qi8CHLauojoZ/x9FON5UtqHE4Oep7BIrsruy0BAehnwkvC7F//xDNMvazeIAZFWj/eGu3aVtNc4G9uim4TVxFn5SHg2RDFokBrG+D+pbvM5DbihYEyfvLQtXR1oA1sd9mfoks9ZjUM+zyE4KtxbBQNIM0T89Zj9tioS6KEe+q3B9gzHiYLVO82eCC8DP8NbiEuyp0s4PM+sI0pnL/CWEoLB4u2bsfqdt61eLjmmW5iae9TD84ewyK6TeaXV61wIrmcX+44Xh4c+3t6BBRRSKd1PShBOh/lUCLuwzPOlWBDz1aTdJtptPAXReBdxZ6lIAOt8xwuIGuBtZkF4P8sN+sXQbpTyHd1ehdDC8oFRR5OKMj91NOc0QRrw9YTZnAAugKjSex0S2V4D+AaWpo65d7uJYaiis9yhBV9BqgJ1Ylg8HzOHBjH0rWMh7BXhfc7nyL5vcjhTUJ89/uGJTFVn/X4WeL/reChwT6a99vhzFWC/3V0lOepUSH0Qi/5yCZue/Zx2r5/y9Trf6QjilnZuyWhhqe0Zrs+5WD3waOCXGSJ3YTn5zsw7j7fbjFF+amWgI5c3gPmwdCwfCLXFAWkonErMI9lKzKZehFVbjsJKYHdi2eRK2mdmI7ZZsRFLR3N4qwpBfdY42lPm3xQEleLU/8e94PRjmGLHoc4+pLwH8wctbDPzQqZCLniZizlSEfMYUfhVNk9aWKktrQpL9edikWVOqOLtVs+7JLihgwBy6pv+34rZZsq4nKafrROwbbDZoY+qyp3ODTQxwWsX2ju6esB3fwEu8XZFaN+WDq+gs/NJzUJtdWpjhFi1KQpY0rNFgiHg7w5/2dgtLIO8PBGC8GpvMOcAm8Si6SQdKn7KPrstY2mgNsl2AKmwr0j56k0VU2hgQVMdi1VqwOvJO1b9/z2uuOIlN0GsBvd6GPFJqhdR/KbqEBa8zAnPO+UU9dC3hjlgbau1sP0ExTLpeADfI8YXbQjBSsbdnAFIbeszAU/VzUhpykUJnqpa18Q2axZimnAdxRosIb064XmKEHLrZxWf0MRs+GzaoUwj9O58imP3Ktc+4rml3ORJsLeV0aSHp9GbH/AD340lG/MCzqJih5auOsVLV6erUfA716Z0a8y/0FmbbmckdWB/wvbvioSg8VaRD1x6HTc1lRZmKqXMi8gaVlz02+LdEpQecz2VqcufZn8Bdqiyl9mvIpgJrDK0hArb415Cm2m3n14uFUhzttdL/NHtlRZdK61QmqlZxFOdvTonMTWCZZHCL9Bs6NTpdE6ZFKn+r+nyiIwn7Fjg3/S2x5cS8raAM60wvdaN0c/iirbbuj4kJRCB5xHVqRcCpYafC/iUJ6jQ0e/Zb7oxlTH2fIhagcr6aQjBb4FDexb3cYe338wrT+jbadGrHEPdmIMEthtLVQWLiYet+qH6vr5wVb+YF6RHZrtVWTG4wuG8kf7Nvqdlfb+ZFwjheVgRtRuTyNXif8TUqtB0VH4EC6k9rX0HIV4K/IL8DJQJ4EZiMHJl8m46s/4Alk57GmcM5MBmYYebVL9PiyT+8l+TCA7D6v+tgj5ldi58+7GATcfhZpx5gV9Tj8dy7HTGiwoSX8JOghxM1KJOGpT7aGoYiyFyNB0QSGP7N2KC8B9OSRjpjtMYljrnZl6Fktxnc+MY42e6cbuK8GYC0sPMx2KmUXTY0TtO/wFl2XL4CKbqy9w4fflwsp+SGyDOIBhxy7EzhyuxTZQj6e7T2fuAn2C7w9pi6+unszOhOpqZoo+nF2Dlq/mYMFpYRWcP/+cfT+dwa7bkyLoB2bZfJfoO/wOB2VJXnvBMKgAAAABJRU5ErkJggg==" },
	meta: { name: "PSVrIcon", w: 64, h: 64, data: "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" },
	console: { name: "PSConsoleIcon", w: 64, h: 64, data: "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" },
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
	var Card = revenge.components.Card;
	var RadioTableRow = revenge.components.RadioTableRow;

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

	var warning = Card
		? React.createElement(
				Card,
				{ style: { marginHorizontal: 16, marginTop: 12, marginBottom: 8 } },
				React.createElement(Text, { style: { fontSize: 15, fontWeight: "700", color: "#F0B232", marginBottom: 6 } }, "Use at your own risk"),
				React.createElement(Text, { style: { fontSize: 13, lineHeight: 18 } },
					"This spoofs your Discord gateway IDENTIFY payload, which is against Discord's Terms of Service. Your account could be actioned for using this.")
			)
		: React.createElement(
				View,
				{ style: { borderWidth: 1, borderColor: "#F0B232", backgroundColor: "rgba(240,178,50,0.08)", borderRadius: 12, padding: 14, marginHorizontal: 16, marginTop: 12, marginBottom: 8 } },
				React.createElement(Text, { style: { fontSize: 15, fontWeight: "700", color: "#F0B232", marginBottom: 6 } }, "Use at your own risk"),
				React.createElement(Text, { style: { fontSize: 13, color: "rgba(255,235,205,0.85)", lineHeight: 18 } },
					"This spoofs your Discord gateway IDENTIFY payload, which is against Discord's Terms of Service. Your account could be actioned for using this.")
			);

	var rows = RadioTableRow
		? React.createElement(
				View,
				{ style: { marginHorizontal: 16, borderRadius: 12, overflow: "hidden" } },
				PLATFORMS.map(function (opt) {
					var selected = current === opt.value;
					var rowIcon = getRowIcon(opt.value, fallbackIcon);
					return React.createElement(RadioTableRow, {
						key: opt.value,
						label: opt.label,
						subLabel: opt.description,
						icon: rowIcon ? React.createElement(TableRowAssetIcon || Image, { source: rowIcon }) : undefined,
						selected: selected,
						onPress: function () { select(opt.value); },
					});
				})
			)
		: React.createElement(
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
		React.createElement(Text, { style: { fontSize: 12, fontWeight: "700", color: "rgba(255,255,255,0.45)", letterSpacing: 0.5, textTransform: "uppercase", marginHorizontal: 16, marginBottom: 8 } }, "Select a platform to spoof"),
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
	var forEpoch = epoch;
	var id = setInterval(function () {
		if (forEpoch !== epoch) {
			clearInterval(id);
			untrackInterval(id);
			return;
		}
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

function startBootWatchdog() {
	var elapsed = 0;
	var lastSeenSocket = getSocket();
	var id = setInterval(function () {
		elapsed += 500;
		var live = getSocket();
		if (live && live !== lastSeenSocket) {
			lastSeenSocket = live;
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

		startBootWatchdog();

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