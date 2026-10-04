const { jsx, jsxs } = revenge.react.ReactJSXRuntime;

const settings = revenge.jsonStorage.getJsonStorage(
  revenge.jsonStorage.pluginStoragePathFor("k1ngop.last-online-tracker", "storage.json"),
  { default: { label: "Active", timeFormat: "relative", persist: true, dmList: true, memberList: true, header: true }, load: true }
);
const lastSeenStorage = revenge.jsonStorage.getJsonStorage(
  revenge.jsonStorage.pluginStoragePathFor("k1ngop.last-online-tracker", "lastseen.json"),
  { default: {}, load: false }
);

const formatRelative = (ms) => {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s | 0}s ago`;
  const m = s / 60;
  if (m < 60) return `${m | 0}m ago`;
  const h = m / 60;
  if (h < 24) return `${h | 0}h ago`;
  const d = h / 24;
  return d < 7 ? `${d | 0}d ago` : `${(d / 7) | 0}w ago`;
};
const formatTime = (ts) =>
  settings.cache?.timeFormat === "exact"
    ? new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : formatRelative(Date.now() - ts);
const labelFor = (ts) => `${settings.cache?.label ?? "Active"} ${formatTime(ts)}`;

const MAX_TRACKED = 500;
const lastSeen = new Map();

let persistTimer = null;
const schedulePersist = () => {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => lastSeenStorage.set(Object.fromEntries(lastSeen)), 1500);
};
const flushPersist = () => {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  lastSeenStorage.set(Object.fromEntries(lastSeen));
};
const clearPersisted = () => (lastSeen.clear(), lastSeenStorage.set({}));

const loadPersisted = async () => {
  if (!settings.cache?.persist) return;
  await lastSeenStorage.get();
  for (const [id, ts] of Object.entries(lastSeenStorage.cache ?? {}))
    if (typeof ts === "number" && ts > 0) {
      lastSeen.set(id, ts);
      armIfOnline(id);
    }
};

const markSeen = (userId) => {
  lastSeen.delete(userId);
  lastSeen.set(userId, Date.now());
  if (lastSeen.size > MAX_TRACKED) lastSeen.delete(lastSeen.keys().next().value);
  if (settings.cache?.persist) schedulePersist();
};
const getSeen = (userId) => lastSeen.get(userId);
const inVoice = (userId) => {
  try {
    return !!revenge.discord.flux.Stores.VoiceStateStore?.getVoiceStateForUser?.(userId);
  } catch {
    return false;
  }
};

const isOffline = (userId) => {
  try {
    const status = revenge.discord.flux.Stores.PresenceStore?.getStatus?.(userId) ?? "online";
    return status === "offline" || status === "invisible";
  } catch {
    return false;
  }
};

const seenOnline = new Set();
const armIfOnline = (userId) => {
  if (!isOffline(userId)) seenOnline.add(userId);
};

let unsubPresence = null;
const startPresence = () => {
  unsubPresence = revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (e) => {
    for (const u of e?.updates ?? []) {
      const id = u?.user?.id ?? u?.userId;
      if (!id) continue;
      if (u.status === "offline") {
        if (seenOnline.has(id)) markSeen(id);
        seenOnline.delete(id);
      } else if (u.status) {
        seenOnline.add(id);
      }
    }
    return e;
  });
};
const stopPresence = () => (unsubPresence?.(), (unsubPresence = null));

const unwrap = (holder, key, depth = 0) => {
  const v = holder?.[key];
  if (typeof v === "function") return { parent: holder, key };
  if (!v || typeof v !== "object" || depth > 4) return null;
  return unwrap(v, "type", depth + 1) ?? unwrap(v, "render", depth + 1);
};
const locateNamed = (mod, names) => {
  for (const name of names) {
    const loc = unwrap(mod, name);
    if (loc) return loc;
  }
  return null;
};
const nameOf = (r) =>
  r?.name || r?.default?.name || r?.type?.name || r?.default?.type?.name ||
  r?.render?.name || r?.default?.render?.name || r?.default?.type?.render?.name || r?.default?.type?.type?.name;

const idOf = (mod, resolved) => nameOf(resolved) || nameOf(mod) || nameOf(mod?.exports);

const hasKey = (o, k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

const byExactName = revenge.modules.finders.filters.createFilterGenerator(
  (names, mod, resolved) =>
    names.includes(idOf(mod, resolved)) || names.some((n) => hasKey(resolved, n) || hasKey(mod?.exports, n)),
  (names) => `withExactName(${names.join("|")})`,
  1
);

const problems = [];
const patched = { dmList: false, activityStatus: false };

const GROUPS = {
  activity: /Activity|Presence|StatusText/,
  dm: /^(DM|DMs|DirectMessage|PrivateChannel|PrivateChannels|MessagesItem)/,
  member: /^(Member|GuildMember|UserRow|MemberList)/,
  header: /ChannelHeader|ChannelTitle|DMHeader|ChatHeader|ChannelToolbar/
};
const SHAPED = /^(MessagesItemChannel|UserRow)/;
const shape = (v) =>
  v == null ? String(v) : typeof v === "function" ? "fn" : typeof v === "object" ? `obj{${Object.keys(v).slice(0, 6)}}` : typeof v;
const probe = {
  count: 0,
  neighbors: new Set(),
  shapes: new Map(),
  traces: new Map(),
  inner: [],
  hits: new Set(),
  slot: { shown: 0, voice: 0, skipped: 0 },
  lastRow: null,
  ...Object.fromEntries(Object.keys(GROUPS).map((g) => [g, new Set()]))
};

const scanFilter = revenge.modules.finders.filters.createFilterGenerator(
  (_args, mod, resolved) => {
    probe.count++;
    const names = new Set();
    const add = (n) => typeof n === "string" && /^[A-Z]/.test(n) && names.add(n);
    add(idOf(mod, resolved));
    for (const src of [resolved, mod?.exports]) {
      if (!src || typeof src !== "object") continue;
      try {
        const keys = Object.keys(src);
        for (const k of keys) {
          const v = src[k];
          if (typeof v === "function" ? /^[A-Z]/.test(k) : v?.$$typeof) {
            add(k);
            if (SHAPED.test(k)) probe.shapes.set(k, shape(v));
          }
        }
        if (probe.neighbors.size < 6 && keys.some((k) => /ActivityStatus/i.test(k) && typeof src[k] === "function"))
          probe.neighbors.add(keys.slice(0, 10).join("/"));
      } catch {}
    }
    for (const n of names) for (const g in GROUPS) if (GROUPS[g].test(n)) probe[g].add(n);
    return false;
  },
  () => "scanNames",
  1
);
const listOf = (set) => [...set].sort().slice(0, 40).join(", ") || "none";

const LABELS = ["Active", "Last seen", "Online", "Seen"];

function SettingsComponent() {
  const current = settings.use() ?? settings.cache;
  const [, forceUpdate] = revenge.react.React.useReducer((x) => x + 1, 0);
  revenge.react.React.useEffect(() => {
    const id = setInterval(forceUpdate, 500);
    return () => clearInterval(id);
  }, []);

  const failed = [
    ...problems,
    ...(patched.dmList ? [] : ["DM list patch not applied"]),
    ...(patched.activityStatus ? [] : ["Member list / header patch not applied"])
  ];
  const issues = failed.length
    ? [
        ...failed,
        `probed ${probe.count} modules`,
        ...Object.keys(GROUPS).map((g) => `${g}: ${listOf(probe[g])}`),
        `neighbors: ${[...probe.neighbors].join(" | ") || "none"}`,
        `shapes: ${[...probe.shapes].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        `trace: ${[...probe.traces].map(([k, v]) => `${k} ${v}`).join(" | ") || "none"}`,
        `hit: ${[...probe.hits].join(", ") || "-"}`,
        `slot: shown ${probe.slot.shown}, voice ${probe.slot.voice}, skipped ${probe.slot.skipped}`,
        `inner: ${probe.inner.join(" || ") || "none"}`
      ]
    : [];

  return jsx(revenge.components.Page, {
    children: jsxs(revenge.react.ReactNative.ScrollView, {
      contentContainerStyle: { paddingTop: 16, paddingBottom: 40, gap: 16 },
      children: [
        jsx(revenge.discord.design.Design.TableRowGroup, {
          title: "Label",
          children: jsx(revenge.discord.design.Design.TableRadioGroup, {
            defaultValue: current?.label ?? "Active",
            onChange: (v) => settings.set({ label: v }),
            children: LABELS.map((v) => jsx(revenge.discord.design.Design.TableRadioRow, { label: v, value: v }, v))
          })
        }),
        jsx(revenge.discord.design.Design.TableRowGroup, {
          title: "Time format",
          children: jsxs(revenge.discord.design.Design.TableRadioGroup, {
            defaultValue: current?.timeFormat ?? "relative",
            onChange: (v) => settings.set({ timeFormat: v }),
            children: [
              jsx(revenge.discord.design.Design.TableRadioRow, { label: "Relative (5m ago)", value: "relative" }),
              jsx(revenge.discord.design.Design.TableRadioRow, { label: "Exact (2:34 PM)", value: "exact" })
            ]
          })
        }),
        jsxs(revenge.discord.design.Design.TableRowGroup, {
          title: "Where to show it",
          children: [
            jsx(revenge.discord.design.Design.TableSwitchRow, {
              label: "DM list",
              subLabel: "Can look inconsistent or flicker if your message previews are set to All.",
              value: current?.dmList ?? true,
              onValueChange: (v) => settings.set({ dmList: v })
            }),
            jsx(revenge.discord.design.Design.TableSwitchRow, {
              label: "Member list",
              subLabel: "Server and DM member lists",
              value: current?.memberList ?? true,
              onValueChange: (v) => settings.set({ memberList: v })
            }),
            jsx(revenge.discord.design.Design.TableSwitchRow, {
              label: "DM header",
              value: current?.header ?? true,
              onValueChange: (v) => settings.set({ header: v })
            })
          ]
        }),
        jsx(revenge.discord.design.Design.TableRowGroup, {
          title: "Persistence",
          children: jsx(revenge.discord.design.Design.TableSwitchRow, {
            label: "Save last-seen across restarts",
            subLabel: "A saved time only updates when that person goes offline again, so it can look outdated until then.",
            value: current?.persist ?? true,
            onValueChange: (v) => (settings.set({ persist: v }), !v && clearPersisted())
          })
        }),
        issues.length > 0 &&
          jsx(revenge.discord.design.Design.TableRowGroup, {
            title: "Diagnostics",
            children: jsx(revenge.discord.design.Design.Text, {
              variant: "text-sm/medium",
              color: "text-muted",
              children: issues.join("\n")
            })
          })
      ]
    })
  });
}

const WALK = { walkable: new Set(["props", "children", "subtitle", "label"]) };

const hasVisibleText = (node) => {
  if (node == null || node === "") return false;
  if (typeof node === "string") return node.trim().length > 0;
  if (Array.isArray(node)) return node.length > 0 && node.some(hasVisibleText);
  if (node && typeof node === "object")
    return "children" in (node.props || {}) ? hasVisibleText(node.props.children) : true;
  return false;
};

const text = (children) => jsx(revenge.discord.design.Design.Text, { variant: "text-xs/medium", color: "text-muted", children });
let pluginCleanup = null;

const tname = (n) =>
  typeof n?.type === "string"
    ? n.type
    : n?.type?.displayName || n?.type?.name || n?.type?.type?.name || n?.type?.render?.name || (n?.type ? "?" : typeof n);

const dumpTree = (n, d = 4) => {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return JSON.stringify(String(n).slice(0, 30));
  if (Array.isArray(n)) return `[${n.slice(0, 6).map((c) => dumpTree(c, d)).join(", ")}]`;
  if (typeof n !== "object") return typeof n;
  const p = n.props ?? {};
  const keys = Object.keys(p).filter((k) => k !== "children").slice(0, 4).join(",");
  const extra = d > 0 ? ["subtitle", "label", "title"].filter((k) => p[k] != null).map((k) => ` ${k}=${dumpTree(p[k], d - 1)}`).join("") : "";
  const kids = d > 0 && p.children != null ? ` > ${dumpTree(p.children, d - 1)}` : "";
  return `${tname(n)}(${keys}${p.variant ? ` v=${p.variant}` : ""})${extra}${kids}`;
};

const callInner = (type, props) => {
  if (typeof type === "function" && !type.prototype?.isReactComponent) return type(props);
  if (type && typeof type === "object") {
    if (type.type) return callInner(type.type, props);
    if (typeof type.render === "function") return type.render(props, null);
  }
  return jsx(type, props);
};

const ours = new WeakSet();
const rowWrappers = new Map();
let inDmRow = false;
const wrapRow = (type) => {
  if (ours.has(type)) return type;
  if (!rowWrappers.has(type)) {
    const wrapper = (props) => {
      let rendered;
      inDmRow = true;
      try {
        rendered = callInner(type, props);
      } finally {
        inDmRow = false;
      }
      return decorateRow(props, rendered);
    };
    ours.add(wrapper);
    rowWrappers.set(type, wrapper);
  }
  return rowWrappers.get(type);
};

const isPassthrough = (n) =>
  !!n && typeof n === "object" && !Array.isArray(n) && n.type != null && typeof n.type !== "string" && n.props?.children == null;

const channelNodes = (node, out = [], depth = 0) => {
  if (!node || typeof node !== "object" || depth > 12) return out;
  if (Array.isArray(node)) {
    node.forEach((c) => channelNodes(c, out, depth + 1));
    return out;
  }
  if (!node.props) return out;
  if (typeof node.type !== "string" && node.props.channel) out.push(node);
  else channelNodes(node.props.children, out, depth + 1);
  return out;
};

const noteTree = (tree) => {
  probe.lastRow = tree;
  if (probe.inner.length >= 3) return;
  const dump = dumpTree(tree, 4);
  if (!probe.inner.includes(dump)) probe.inner.push(dump);
};

const combine = (native, label) =>
  jsxs(revenge.react.ReactNative.View, {
    style: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
    children: [native, text(` · ${label}`)]
  });

const overlayStatus = (props, rendered, on) => {
  const id = props?.userId;
  if (!on || !id) return rendered;
  armIfOnline(id);
  const seenAt = getSeen(id);
  if (!isOffline(id) || seenAt === undefined) return rendered;
  if (!hasVisibleText(rendered)) {
    probe.slot.shown++;
    return text(labelFor(seenAt));
  }
  if (inVoice(id)) {
    probe.slot.voice++;
    return combine(rendered, labelFor(seenAt));
  }
  probe.slot.skipped++;
  return rendered;
};

const statusWrappers = new Map();
const wrapStatusType = (type) => {
  if (ours.has(type)) return type;
  if (!statusWrappers.has(type)) {
    const wrapper = (props) =>
      overlayStatus(props, callInner(type, props), settings.cache?.header !== false || settings.cache?.memberList !== false);
    ours.add(wrapper);
    statusWrappers.set(type, wrapper);
  }
  return statusWrappers.get(type);
};

const rewriteStatus = (args) => {
  const [type, props] = args;
  if (inDmRow || !props?.userId || !props.textStyle || (typeof type !== "function" && typeof type !== "object")) return args;
  args[0] = wrapStatusType(type);
  probe.hits.add("status rewritten");
  return args;
};

const baseChildren = new WeakMap();
const restoreName = (node) => {
  if (!baseChildren.has(node.props)) return;
  node.props.children = baseChildren.get(node.props);
  baseChildren.delete(node.props);
};

const decorateRow = (props, rendered) => {
  if (isPassthrough(rendered)) return jsx(wrapRow(rendered.type), rendered.props);
  noteTree(rendered);
  if (settings.cache?.dmList !== true) return rendered;
  try {
    const nameNode = revenge.utils.tree.findInTree(
      rendered,
      (n) => !ours.has(n) && (baseChildren.has(n?.props) || n?.props?.children?.[0]?.props?.variant === "text-md/medium"),
      WALK
    );
    if (!nameNode) {
      const deeper = channelNodes(rendered);
      for (const n of deeper) n.type = wrapRow(n.type);
      probe.hits.add(deeper.length ? `descend ${deeper.length}` : "none");
      return rendered;
    }
    probe.hits.add("name");

    const channel = props?.channel ?? revenge.discord.flux.Stores.ChannelStore?.getChannel?.(props?.channelId);
    const id = channel?.recipients?.length === 1 ? channel.recipients[0] : undefined;
    if (id !== undefined) armIfOnline(id);
    const seenAt = id !== undefined ? getSeen(id) : undefined;
    if (seenAt === undefined || !isOffline(id)) {
      restoreName(nameNode);
      return rendered;
    }

    const original = baseChildren.has(nameNode.props) ? baseChildren.get(nameNode.props) : nameNode.props.children;
    baseChildren.set(nameNode.props, original);
    const nameRow = jsx(revenge.react.ReactNative.View, { style: { flexDirection: "row", alignItems: "center" }, children: original });
    ours.add(nameRow);
    nameNode.props.children = jsxs(revenge.react.ReactNative.View, {
      style: { flexDirection: "column" },
      children: [nameRow, text(labelFor(seenAt))]
    });
  } catch (e) {
    probe.hits.add(`error ${e?.message ?? e}`);
  }
  return rendered;
};

export default plugin({
  async start({ cleanup, plugin }) {
    pluginCleanup = cleanup;
    const step = (name, fn) => {
      try {
        return fn();
      } catch (e) {
        problems.push(`${name}: ${e?.message ?? e}`);
      }
    };

    await step("settings.get", () => settings.get());
    await step("loadPersisted", () => loadPersisted());
    step("startPresence", () => startPresence());
    step("scan", () => cleanup(revenge.modules.finders.getModules(scanFilter(), () => {}, { max: Infinity })));

    const rowNames = ["MessagesItemChannelFast", "MessagesItemChannelFlash", "MessagesItemChannelLegend"];
    step("getModules(rows)", () => cleanup(
      revenge.modules.finders.getModules(byExactName(...rowNames), (mod) => {
        for (const name of rowNames) {
          const loc = locateNamed(mod, [name]);
          if (!loc) continue;
          try {
            patched.dmList = true;
            cleanup(
              revenge.patcher.instead(loc.parent, loc.key, (args, orig) => {
                const out = orig(...args);
                if (!out || out.type == null || typeof out.type === "string") return out;
                if (!probe.traces.has(name))
                  probe.traces.set(name, `props{${Object.keys(args[0] ?? {}).slice(0, 10)}} out ${tname(out)}`);
                return jsx(wrapRow(out.type), out.props);
              })
            );
          } catch (e) {
            problems.push(`rows ${name}: ${e?.message ?? e}`);
          }
        }
      }, { max: Infinity })
    ));

    globalThis.__lotDump = () =>
      JSON.stringify({ problems, patched, hits: [...probe.hits], slot: probe.slot, traces: [...probe.traces], inner: probe.inner }, null, 1);
    globalThis.__lotTree = (depth = 8) => dumpTree(probe.lastRow, depth);
    cleanup(() => (delete globalThis.__lotDump, delete globalThis.__lotTree));
    step("cleanup(stopPresence, flushPersist)", () => cleanup(stopPresence, flushPersist));

    if (plugin.startedLate) step("requireReload", () => plugin.requireReload());

    step("hook jsx", () => {
      const runtime = revenge.react.ReactJSXRuntime;
      for (const key of ["jsx", "jsxs"]) cleanup(revenge.patcher.before(runtime, key, rewriteStatus));
      cleanup(revenge.patcher.before(revenge.react.React, "createElement", rewriteStatus));
      patched.activityStatus = true;
    });
  },
  SettingsComponent
});
  
