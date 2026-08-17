const { jsx, jsxs } = revenge.react.ReactJSXRuntime;

  const settings = revenge.jsonStorage.getJsonStorage(
    revenge.jsonStorage.pluginStoragePathFor("k1ngop.last-online-tracker", "storage.json"),
    { default: { label: "Active", timeFormat: "relative", persist: false, dmList: false, memberList: true, header: true }, load: true }
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
      if (typeof ts === "number" && ts > 0) lastSeen.set(id, ts);
  };

  const markSeen = (userId) => {
    lastSeen.delete(userId);
    lastSeen.set(userId, Date.now());
    if (lastSeen.size > MAX_TRACKED) lastSeen.delete(lastSeen.keys().next().value);
    if (settings.cache?.persist) schedulePersist();
  };
  const getSeen = (userId) => lastSeen.get(userId);
  const isOffline = (userId) => {
    try {
      return (revenge.discord.flux.Stores.PresenceStore?.getStatus?.(userId) ?? "online") === "offline";
    } catch {
      return false;
    }
  };

  let unsubPresence = null;
  const startPresence = () => {
    unsubPresence = revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (e) => {
      for (const { user, status, clientStatus } of e?.updates ?? [])
        if (status === "offline" && !Object.keys(clientStatus ?? {}).length) markSeen(user.id);
      return e;
    });
  };
  const stopPresence = () => (unsubPresence?.(), (unsubPresence = null));

  const locate = (mod) => {
    if (typeof mod?.default === "function") return { parent: mod, key: "default" };
    if (typeof mod?.default?.type === "function") return { parent: mod.default, key: "type" };
    if (typeof mod?.default?.render === "function") return { parent: mod.default, key: "render" };
    if (typeof mod?.type === "function") return { parent: mod, key: "type" };
    if (typeof mod?.render === "function") return { parent: mod, key: "render" };
    return null;
  };
  const matchesName = (node, name) =>
    node?.type?.name === name || node?.type?.type?.name === name || node?.type?.render?.name === name;

  const byExactName = revenge.modules.finders.filters.createFilterGenerator(
    ([name], _mod, resolved) =>
      (resolved?.name || resolved?.default?.name || resolved?.type?.name || resolved?.default?.type?.name ||
        resolved?.render?.name || resolved?.default?.render?.name) === name,
    ([name]) => `withExactName(${name})`,
    1
  );

  const LABELS = ["Active", "Last seen", "Online", "Seen"];

  function SettingsComponent() {
    const current = settings.use() ?? settings.cache;
    const [, forceUpdate] = revenge.react.React.useReducer((x) => x + 1, 0);
    revenge.react.React.useEffect(() => {
      const id = setInterval(forceUpdate, 500);
      return () => clearInterval(id);
    }, []);

    return jsx(revenge.components.Page, {
      children: jsxs(revenge.react.ReactNative.ScrollView, {
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
              jsx(revenge.discord.design.Design.Text, {
                variant: "text-xs/medium",
                color: "text-muted",
                style: { paddingHorizontal: 12, paddingBottom: 4 },
                children: "These act as one on/off switch right now (any one enabled shows it everywhere) - per-surface control isn't in yet."
              }),
              jsx(revenge.discord.design.Design.TableSwitchRow, {
                label: "DM list",
                subLabel: "Off by default - can look inconsistent or flicker in the DM list if your message previews is set to All.",
                value: current?.dmList ?? false,
                onValueChange: (v) => settings.set({ dmList: v })
              }),
              jsx(revenge.discord.design.Design.TableSwitchRow, {
                label: "Member list",
                subLabel: "Server and DM member lists both",
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
              subLabel: "A saved time only updates the next time that person goes offline again - can look outdated meanwhile. Off by default.",
              value: current?.persist ?? false,
              onValueChange: (v) => (settings.set({ persist: v }), !v && clearPersisted())
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

  const shownFor = new Set();

export default plugin({
    async start({ cleanup }) {
      await settings.get();
      await loadPersisted();
      startPresence();
      cleanup(stopPresence, flushPersist);

      cleanup(
        revenge.modules.finders.getModules(byExactName("MessagesItemChannelContent"), (mod) => {
          const loc = locate(mod);
          if (!loc) return;
          cleanup(
            revenge.patcher.instead(loc.parent, loc.key, (args, orig) => {
              const props = args[0];
              const rendered = orig(...args);
              const actNode = revenge.utils.tree.findInTree(rendered, (n) => matchesName(n, "ActivityStatus"), WALK);
              if (actNode?.props) actNode.props.__dmListRow = true;
              if (settings.cache?.dmList !== true) return rendered;

              const recipients = props?.channel?.recipients;
              if (recipients?.length !== 1) return rendered;
              const userId = recipients[0];
              if (shownFor.has(userId)) return (shownFor.delete(userId), rendered);

              const seenAt = getSeen(userId);
              if (!isOffline(userId) || seenAt === undefined) return rendered;

              const nameNode = revenge.utils.tree.findInTree(
                rendered, (n) => n?.props?.children?.[0]?.props?.variant === "text-md/medium", WALK
              );
              if (nameNode) {
                const original = nameNode.props.children;
                nameNode.props.children = jsxs(revenge.react.ReactNative.View, {
                  style: { flexDirection: "column" },
                  children: [
                    jsx(revenge.react.ReactNative.View, { style: { flexDirection: "row", alignItems: "center" }, children: original }),
                    jsx(revenge.discord.design.Design.Text, { variant: "text-xs/medium", color: "text-muted", children: `${settings.cache?.label ?? "Active"} ${formatTime(seenAt)}` })
                  ]
                });
              }
              return rendered;
            })
          );
        }, { max: Infinity })
      );

      cleanup(
        revenge.modules.finders.getModules(byExactName("ActivityStatus"), (mod) => {
          const loc = locate(mod);
          if (!loc) return;
          cleanup(
            revenge.patcher.instead(loc.parent, loc.key, (args, orig) => {
              const props = args[0];
              const rendered = orig(...args);
              const enabled = props?.__dmListRow
                ? settings.cache?.dmList === true
                : settings.cache?.header !== false || settings.cache?.memberList !== false;
              if (!props?.userId || !enabled) return rendered;

              const seenAt = getSeen(props.userId);
              if (!isOffline(props.userId) || seenAt === undefined) return rendered;

              shownFor.add(props.userId);
              const label = `${settings.cache?.label ?? "Active"} ${formatTime(seenAt)}`;
              return hasVisibleText(rendered)
                ? jsxs(revenge.react.ReactNative.View, {
                    style: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
                    children: [rendered, jsx(revenge.discord.design.Design.Text, { variant: "text-xs/medium", color: "text-muted", children: ` · ${label}` })]
                  })
                : jsx(revenge.discord.design.Design.Text, { variant: "text-xs/medium", color: "text-muted", children: label });
            })
          );
        }, { max: Infinity })
      );
    },
    SettingsComponent
});