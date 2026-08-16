const { jsx, jsxs, Fragment } = revenge.react.ReactJSXRuntime;
const { React, ReactNative } = revenge.react;
const { getModules, filters } = revenge.modules.finders;
const { patcher, utils, jsonStorage } = revenge;

const getName = (m) => m?.name || m?.default?.name || m?.type?.name || m?.default?.type?.name || m?.render?.name || m?.default?.render?.name;
const withExactName = filters.createFilterGenerator(([n], _k, m) => getName(m) === n, ([n]) => `withExactName(${n})`, 1);

function patchTarget(m) {
	if (typeof m?.default === "function") return { parent: m, key: "default" };
	if (typeof m?.default?.type === "function") return { parent: m.default, key: "type" };
	if (typeof m?.default?.render === "function") return { parent: m.default, key: "render" };
	if (typeof m?.type === "function") return { parent: m, key: "type" };
	if (typeof m?.render === "function") return { parent: m, key: "render" };
	return null;
}

const settings = jsonStorage.getJsonStorage(
	jsonStorage.pluginStoragePathFor("k1ngop.platform-indicators", "storage.json"),
	{ default: { dmTopBar: true, userList: true, profileUsername: true, fallbackColors: false, oldUserListIcons: false }, load: true },
);

function SettingsPage() {
	const s = settings.use() ?? settings.cache;
	const set = (k, v) => settings.set({ [k]: v });
	const { Design } = revenge.discord.design;

	const rows = [
		["dmTopBar", "Show icons on the DM top bar"],
		["userList", "Show icons on the users and DMs list"],
		["profileUsername", "Show icons on user profiles"],
		["fallbackColors", "Theme compatibility mode"],
	];

	return jsx(revenge.components.Page, {
		children: jsxs(Design.TableRowGroup, {
			children: [
				...rows.map(([key, label]) =>
					jsx(Design.TableSwitchRow, { label, value: s?.[key] ?? key !== "fallbackColors", onValueChange: (v) => set(key, v) }, key),
				),
				jsx(Design.TableSwitchRow, {
					label: "Old user list icon style",
					subLabel: "Moves status indicators to the right",
					value: s?.oldUserListIcons ?? false,
					onValueChange: (v) => set("oldUserListIcons", v),
				}),
			],
		}),
	});
}

const FALLBACK_COLORS = { online: "#23a55a", dnd: "#f23f43", idle: "#f0b232", offline: "#80848e" };
const STATUS_TOKENS = { online: "STATUS_ONLINE", dnd: "STATUS_DANGER", idle: "STATUS_WARNING", offline: "STATUS_OFFLINE" };

function statusColor(status, useFallback) {
	if (useFallback) return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
	try {
		const token = revenge.discord.common.tokens.Tokens?.colors?.[STATUS_TOKENS[status]];
		if (typeof token === "string") return token;
		if (typeof token?.resolve === "function") return token.resolve();
	} catch {}
	return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
}

const PNG_ICONS = {
	mobile: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAD9klEQVR4nO2cT6hUVRzHP7+Z9zQJihCxZRBuDEQoapEQbRIhqBbSyq2L1kXLxGgRBAkiRNBCXJrlSgQlitrVwo2LCEHUghAqMNTXm5lvi3sOc9513vvdvzMy73zgcmfuO/ec3/3c3z3nDrxzoAMkWfL5FUlnJd2U9J/6ZyTpD0lfSzo8K6aFIsnCNpT0maSHc5CyFV9J2hVja3t9rSoIAQwAAReAt8PnSTg+q/5xKLMS9mOnmUHYtgwlbLH8d8ARYATIzLTZib0iaRj2H4e7tyZpsqDMiayF/ak0xqY0ziBJAzObSHoO+BUYsnnWQHGHDfge+BN4F7gLnAPubxLbEDgKPJ+c74ZGkcEC9pvZbzHWalfWEZJWwv79cMfWt7irMav+lbQazrst6USFdo5UqL9MLPthGmsTGp/I9Jl/Ofm8GRbKPAF8IOkmsAd4S9I14CEb+xGY9j3vJd/rxvdSKdbadCHoGQoBXvrHR+aT5NhB4NuK7dURFON5OnxfiKA0mJQ4SsWsScvF/gGmo1+V4KvIifUPS8da0YWgMq1GjceNPgT9APzNoxk0L14Fdi+g3Y1IGoT91dLI8cKC47qcjGZX0lib0EcGPRVezob4b8ldMqDo31a7rLQPQWMzG0vCzOYmSJLCi2unj3Xj1NsuLLug1tm07IJakwU5ZEEOWZBDFuSQBTksu6A8zPdNFuSQBTlkQQ5ZkEMW5LDsgvIw3zdZkEMW5JAFOWRBDlmQw7ILysN832wXQY3/y2O7CGpMFuSQBTlkQQ7LLigP832TBTlkQQ5ZkEMW5JAFOSy7oDzM900W5JAFOWRBDlmQQxbksOyCWg/zfUxmGcTZPh3PK6nSbpWpobXoQ9C9MMtnnlOhiO1JWu+y0j4EvSZpL9P5W3WIKdckC+IMxz1Un2Pv0qWgGNCZDutsypiO5s72kUFNsiZezH2KGYOrDeqJdNoH9TGKDWpsUMj5HTgG7AcOACfZ+LjVqfOx66SbDlWxn7gHHDaz68nfPpJ0FzhNu8dlob/m4536h+oLBKSMQx3fmNl1STs1XYdoCHwB3KKQ0+SxFfBXKdbadCHolzYBADeCkLGZKbwiTMxsBNwJZZpkggE/t4gLaCco3tXzwDr1FxKIUl8MUgYhe1YBk/QksK9BnArlHwAXS7HOF00XWPo0TOSPixtVZRwWJHhzRt2fhzKjmnXGGE6kMS6EpM9YkXQpueiRqq1EFcusqVj/7A1J70i6kNRVhUmpzYuSYkYudrE3TRd52yHpTI2LqnLRdRlJOqXihlkXcjqxK8niQmqSXgeOA4eAZ5m+Sszqn5Ts46gWjw1nlJt17ohiya8fgS/N7KdyTG34H5Hx+ajyLWlhAAAAAElFTkSuQmCC", path: "PlatformIndicators/Mobile.png" },
	desktop: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAECklEQVR4nO2cPW8dRRSGn3N9YwzmKwEaUAogBZRIkdKSIn8ACYr8AGgi2b8hDUoHJTTpQaKEloYCEUokGkKBhIT4RjF2Yu++FHOGu957945l7+7YvvNIq73emZ2ZfefM7Ix8zhoLkGSLrp93zExz1+IPF2UNqBZlXAUWaWAxoSmKpE3gsSytzMdDM9uJf0RNTNLEzGpJ68B7wDvAy8DjuVqaiV3gR+AT4CMzeyRpEi3oReAz4FrGBp4mvgbeMrOfTdIG8CVBnEeEMTjJ2Lic1EAFrBNEenMK3CKIs+8JkVWbqOMEvUbQ4hpwyyR9B7zmmVbVctrUfv7eJO0CG60MAv5mdazIgGdoLHucPZPUFEGe6U/gqp+N8ytUfLaLwD0/Rw0AmHbcKOA3M/tn6BaeBiRVdBhBl0AAF3xluQoWdKErwzKBZBZG4HndesRna00zhyhvrQRFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoARFoATLvDssur8scX4468Rn64wsWCbQvru9nFt18GeTtN+VoUsgA56XtMZqOFBdpMOK2j6KkVxOnLG+sYNpupw4OwUqOEtd8EZrxaznHvj5yYxtOMSy17yNcEAQ4SGwDbzux7Zfaw65MdoyL0LmIVYRXP+3zezDZoKkLeCDRp4s5BQoOmzvAK8Av7fSnwPuA5u0nLvHZALs5ai4RdebNDd7E0Iv1cwCOMbCCMNnE7hpZlXzAG56WsX41hP1uD8B7hIsaWyB8HoF3JG0JeklP7aAO56WY79Ye713xw6oS1lCjBndTOQbavjNBdSdlpBMeePi26oidFKu8PRDIZnm8QoxqPdt4FXmY8hOSlzOL7POo2w1BPxF/1a0B/wAfMosqNfGCAuPG8IXgG+Apzjeazve84AQy/Zro+w+WBgWPgVixEszqH6H2XzQCy56H1a5Aeya2R89lHWIRR8W+H8v5hcOGhn7Yo0wp1wmxGUdd9EXrWUKXJb0U6PsXmhqEFm4We0zPqwRk3XFL1Vd9R6BeO8VM/tqjFi2MdcYb5zSspYyhkC1pAlwo4c64703vMwci9t+kGS+dEDSdQUqnZxYxnUve73nOXN4vHfj76mke5JqSQc9CHTgZX0rabqozjOBpEuSrkr6vNXzfRDL+sLruJT7eY+EpInC0Lot6Rfv6Wav93lEa6y9rtted6+W1NvY1WzL8gRhK9AZiz4Q+8CzZvavWjuDk3Dc9cgcLs6E8KGi94F3vfyh54aasLj7GNiVfzCqr8IHm/0lPc1s5TwkRvgv8Nn5jEbf80DOOoe0oFHXJkNtOf4DQI4jaO3mfK8AAAAASUVORK5CYII=", path: "PlatformIndicators/Desktop.png" },
	web: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAANoElEQVR4nN2ca5BdRRHHe3Y3QZJNQoCAFJFXSECQIDGAyBctEFEeUn5CEQyUKJASlQJ8UCqoH9BSQniVUKKUAuIDBUlhhBiqeAiYIAJBgkCFt7zUIDEhye79+aG79/SdPefsuXd3Y2FX3br3nnOmp/s/PT09PTMnyRYiIIlIEpEeu9RKKbUalu2J5USElBJjL+VwSuNdgSuXUhooudcnItuIyDQRmSwiE02mjSKyTkReF5G1KaXBirKNQe6WxgUgs5beHBRgLxE5UETmi8i7RGQ3EZkhCk5vxmZQFKRXReQZEXlURFaIyIqU0uMZ3z4RGRwPqxpTgAyYntjiwCEicpyIHCEKSl8diwZyDYjIKhFZKiI3pZTuD3WNG1CjJqA3/N4WWAisYDhtBjbZ9yDQsk9Ofn0QGLDnB0qeux84DdimTJb/OQE9ZjkCbAOcBzyfKfomsNGUjZT/b0IO2uYM2GeALwFTg1w99dKPPzh94fcpwNNBYLeUnAaA9V0AU0VuYU5PACcEuba8NQHJKwb2Bm7LgBmgaN1BYDlwDvB+YDawK7APsDiA1gkY/h0tqIVaqdMSYE8HCbPyLQWOd6kFwOsBmNyf/AQ4oIbXkaFsE3DKaDPt1noz8GP7/W/MmqLc4wlOj38DlwQh3QJciZeBD8VyQJ+1ZA8wwa7/PCs/EjgPoI3yAeArDAf2UWCW8T4ZWGfXv0fRqOPjlwI4k4FbQuu5xbjz/A8a71Tx6bXWfDdFd2kCziqgP+N1KPAj4ELUGifa9T77fiew0sr/Gpg0LiAFcKYCd1mFuQN2RR4DPgf8CfgZsKMB4lbkStxuzzexnkHgYCs30UAudb4UluIg9QO/NF7LCaPcWIGT7DOpBpw6utn4xDjp0w3B8S50TVQ68OlFQffum/L74fdVxusO02X0PsmYeJfwbtUEHHeaA8DywOss4AY0LqoKEJ38/gZ05Et00eqEeAi40njfZNdHN7pRmKkPx51YjlvHh02YYzooG8svdUVHoUcMS35hfBdFHbth6gxPMIadDsX+/JeNzwpT2q2nKa81wA6MsktglgRsjfpHKEKAzoJJY5SA3dFYwudMVVQ1lwIdan/TAJA6kOZ1pchwvbzRZwH/NN32oNPuGxg1GWkiOI+jw/xIzzUhr/PaTKYhv9glSO42jjf+t0f+nYATu1aL4TPqFkUU+xxwCGp5y9CW3xTKxylAE3IH/Sww3eXKlQiy9mQA1oIXQPLhv1lXo4hX+k04T0vklAd3Zwce53QIRhkN2OePDkDgfyjwA2BblzlXvE6/AGgCZgJvAC8AU0YENyB7bibwS+gwfx6w1K5tBB4BvolG10MtDHwKnVVj5e61392kN95rPHcGjqbo9k8BH7N7M8NzfcDba3R0GX26c4HxO7cWZIqAcArwogGwGDiC9mRUopiVD0ObopUmAXPt92zUGkeKfQj3L0JDhO3QPNMT4ZnoE/8CrAWeBM5HG+2xAMRQZA1MrtD778Cr6Eyh3IoorOcUq/ia7H5PGbpWcV0E64HmAyXK5eT3Vmb8Ph+eWU/hC6t4LbM6J1IEiTPRfNWpqMXvDXwcuBYd0QBOj1iUIRkVmWfKTaS9n/so0kNNf6XwZy7g7zsA6LbAZxbauj8FjkJzSXdWlH8BuB7YNW8wk+dwNAZaRTGJdWoBD5bqRWGOB9jD97vVVAHQhALo09AUiAtSRTF2ugC4HM033ZDx/SCaYn0N9W8Xo5H6DLu/L5qrPpOiZ8RG3hOYgI7Ubo3uHw+KmHgBZ/Jte2hhvD4KgJzvF41v08xhTvtQWLNbZD+wfUmdvajvcrDvQ7tTH+aYw7MX2jMergB8d5juFC39sCmxm13vyoJo74bbA69Q5Iua0AA6SFyOdvU2x0n7sJ8Is3kKpzwT+L7xu8yuTQS2Mrn2on3S7LI9TOxmoUV8pBmgzlk1ACf7f11Quil5a15qPCaU1ZPXlQNooG1EfdjR2TPLKuTaDMwZ4kPRDT4ZHnqwToCRwLGWegdwdhfgeGu+CRxsSnaT5vA80RkUUf0SNEa7yf7nFu0Nc6LziAB5jtnN21cEGglHMWpNQR3khqBwJ+RgfsH4dj1BpWiw/QIo2O/lJSA5QJdEgNwc/2A3fd50bCcCBqA9Mu3E5zhFPzCqSWmQK8ZkewN72O/3lADkjeNJvp6+lFLLmHjsMEF0w8CDJtyIuycM5EFgBxE5M5TptGu0rMzdKSWANNp19pTSoBtBSml1kLdsOuKNsQvQl1IacAWmi4gPmS0ROSWl9JzoRoQmAvpzZ4luZ3FFu6V+a5zKujuxrJRSyw0Bdfi9IvKtskfte4bolpyhymaF/vc6OiepNe/QBbxr7Uyz5FqTLra6qovRPpR35MApAuLvZF3KKa4Gz4oF54YbLeB9dn3Y8FpR8STgtxWVdkpe3n1gDA5j/NMffo9oTQGcQ0M9dQ25Xyx8kF305Nh9wL5llVMElVujgdgyNG/MCBU2JV8HexE4MAcBnSLcQjHvmlUmZwlAnpO+x+qpakjXYX4sPD/c9Ac2A4vIzJiiJRaVKDZW5DJsQLvDbFS5nWhf8gbNZm5HzeSZwgJ3oXAlVY3p1w+MDOZmDzmTtcFqhvwBGuu8QjGHGUtwckGhSM6ttf/ePTwA9LxTqUsIck8zuXP+ZTRXpBhp1ksxNCO6Ta4lIlsDZ6SUsG11PvXoEQ0HfOcqolvjaq18hPs5Rb4TRbfvTRPdu9grxY7ZlogsACallDZTYkUWMvSmlF4XkSV2edjG0CCj74+0qzqh9G0s+Z4bgBsp+rr35UsrWj0vHxNb7l86JQ8665aX1gBHmYzDglsK13BwjRzOay2wXSzch+Z4KSnoyv0LTci/zcpMBL6GDsnXoZk5p5g+yCsn3OsWsJy8qz1CxRyS9vDA07dVWwKfxEGmcGA+Nynz7vHaQ1iyvESIY4F/hGc3okn2z6JJrGNp36bnFMF0i+tkRIz7FneLegXZXM9d0d5Slh93PZcNlWH4ZLVqidm7i9MdqMJTgY+i+3SOMQFOR0GZUwLiTujmp3nAcWhrOf9c4KYg+XMvowHrMCtC3cJWFHPOMkNw3Rd7z4oAnZg9VEV5t3g5u78c2D0z7T7C4l4m+HTgiiDwXRQ7SaLydeQyX2Q8t8rqcB0XjKCjy3DCUDkK05tTU7CKmQPl5u3lNwGHUb4aWgoYsD+66dz/fwRdxm6yVOSK3UOx3jUsA4nuals3As9N5KkeilzOw0HhppRX9KZ9fz22XhURtqaE/74LzTc9NWk4l+MR4PgMGF9JrRqtodD5IULQ6Y6s1w6FLLX/nRwQiX29JRqzPC0iV1klZfFGUdhiLBOq17ICXmZGSR11crRE46Wrgek2g/fjEYimYqaKxlY5T9f5VsOibVXDY4SDKtBtSm7qvzN+3aRKXZbjMp6dyNBCl7B60Tmjr8NXjV6E6/OjHJ5IGkSRXikiD5mstS1fQUMJJ/vu6DiAydBC17euyHg2ZmNljkkpDaaUNpj1XClqPa0Snq7rn0XkATRR164/hac/o8uWc/Jd8NHhNsrbUFjPYYFXN+QhyfXAN9CQpI6f63pqxCIXLl8F7San7MKB7ghZiKZh2wCoAchl6Af+OoJSnVIVH5/CvEjJFpihVjUz9AndYimcXqfkzHcUkctEZBU6Gs0LXbm8oMrQk1JaJyKr7fJoThQOijrkQalOAXuXW5RSekMUg/KJdWjBqWhCqlsrguGR9yC61Fu5H5BiWJ6P7uIYTfq2CTn/Z1Grrd2Q4UK6HzjJmHQSPJaRb9VzoE+L9ZQ0zhT0zAWMT54pkuv2iTKZmoBUN4HtlDzyfhLbUkN5tLs74285Lg/YVhsqwKnql5jwp0qROBrtOVAXYJaIHOT+xm/6skxKaY2I3CjqF0ZKwnVLHgq8ISKfoWaJqRQgiyR7UkpPichCUeXGQtiWCXK4VzUkcVjXFxE/LTReRyrdaZ+WUnpaVNfOBwOGp0I6OYpQZ9ZDS7sldZ2fPTvW5DpcHOvtimg/zLIkq6Abcr/yGsWxpHiOYj7Dj3SOJbnst8DYrP3H0aXb41A5ueJ+/mvoFCK6YxXGZ/Ryme9E52cjD+nSoI+bM00ppfUicpSI3CW6orG5S8x9juNnWSdY/z9dRPYX9XVj7Xs2i8p8t4gcnVLaIDKk29gQxTCcLzN32hU89vih8etFrWc1owtMy8hjMFCZJ0ddxpwoQEq0r6x24lAdgJWB79boXMiVGguKMl1COIYwLuAEZeLyyYnocpAL1KT141bfnQKvX9n10Ubunv4Fzf8syOUed6J95JkN3BoEzF8ZUUbeukMLfejWXVewG4rdCXTj+l6B/5YBJwMq5pJPolh8dBDq8i8tNE8zI/D4Wxcg5a+mWAOcHHiOaq/3qIn24wZT0ReMxMXBOFktW9Z+CT0+fjW6AQvqLTAuEsbnnge+CkwzWbo6BDxuRLs1TUMXDu8rUTAezKvzN3GDd93rcVagibnpZbKMlsbjBUttb55Czz4cJyJHiq44lG1RaUmxr9F3jFSRv2DpNtEXLN0b6uoVfW3XmMU3W/oVXXOkeEXXviKyuxSv6Mp9hW9BeU10GWmV6KLCSt+tGvi+NV7RVUbUv+StV4qXvPWLrqmJ6Eve1ovIWvl/fMlbGZlVveVeE/hfAf+VyrXnFFkAAAAASUVORK5CYII=", path: "PlatformIndicators/Web.png" },
	embedded: { url: "data:image/png;base64,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", path: "PlatformIndicators/Console.png" },
	vr: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABmJLR0QA/wD/AP+gvaeTAAAEkklEQVR4nO2aTWwWRRzGnylWKFSJqR+JH1hMjBI9YVGr9aCGIFoTSKgSBCon9QRoSGqiHJSrwYRoohf1oCR+JGo4oAbl5AdGaWrQeAJFFEupUik1xfbnYbbh7fLux+zOtm/I/JL3sPvO/J9n/rM7uzszUiAQCAQCgUAgEAgEAoHABYXxGQxoktQlaYWkOyTdJOkqSc0+dWoYlzQo6WdJX0vaK+lLY8xkRXrFAFqBPuBXZp8jwDagdbbzIkkC1gPHZzcndfkDWDebiVkA7J7lJOThbWB+0XYWGoOANtn7vaOo8AxzQNJKY8ywa0XnBGHv7f2SbnOoNio7oPqmVfkfAAck3WeMGa3AxzmAd3Nc1vuBJ4BbgHkVemkCbgA2AZ8Ckxm+dlflZcpQb4aBg0BnpSbS/XUA32Z4fKwq8YXAYIrwW8DcSsTdfDYDr6X4PA5cUoXwcxnJ8frSWQbAAK+n+H3Wt+Ac4FiCWH/alYN9HbjSq6EcRFdS0u32GzCnTPAW4OlIYCylJ6DOmBP1YC/wPecGzp+Au0q12r0dHaQP3GPAN8Bm8j5MgEXAoYykTPF5nfrNwPsJ5U8Cl3nPRHp79uZsywBwbVawFuDHnAEBNtWJ8XJGnTWVZaN+mzY4tGeAtAcN9iPPhetj9duBsxl1Hqo8K9M9LXJs0+a0YP0OgcaIPbmALRl1fgAurjwr0z0Z4IxDuw7U1m+KxVvioP2XMYbYuRsTyo5L2iXpXmNMFZ8ciUQeTzlUubX24KLYny69+2+dc5cmlO0zxux0iO2beEem0VJ7EL+CXDhb59yxhLJflNDxQeEZxjIJqscrkk7Ezn1kjOn3rDNjxG+xUhhjjgLLJG2RdLWkryS96lOjIIWvIK8JkiRjzC+StvqOWxKXMWgavm+xRiUkKIOGGaQblXAFZeAtQYUDNTgut9i0HMQTNFTeS0Pi0vF/1h7EE3Te/E4KLdlFGgaXhcN9if8Ay4CJnF+9/wELyrjGLtt0A29iZxyHo98h4A3gQeyGiDIarZHXvG1amhWwL2cwgO4Sxu/BTn9kMQDcXULnYYf2bMsb9HHgRI6AHxc0/RT5exXsJNyTBbX25Ig/CGxwDTwfWA1sB95LCDwJ3O8YdyPZK6BJWusdtZanxPsAeB5YBZQbT7GLhqcThH4H2nPG6cRtdi/OKHB7Tq32yFtSHL+LB6RPxh8F7syo3wOMlEjOFKeAVRlanZGnJHZ5TU4kegV22SaJCeAdYAXQhl1svA5YC+zLaPTfwFbgZmAJ8EyUiDQ+AdYA12DnnduAByIPaU/iYapayAQeyTBdhDPAeVtpsIt+WYuWRXi0kuTUGN/h0ewEsDZFax3538vysKPS5NQYf9GD2XFgYw6t3qhsWV6YidzUGu8BhgqaPQx0OWh1RXWKMAT0VJmLNOOXAztJfgWIcxL7XuX8iYLdJbKd/J0yAryE3U9ZGC97eoCFklZLWi5pqaTFkuZKGpF0WNJ3sps+9xhjxkpqzZPULWml7D7JxbLrcaclHZF0UNJnkj40xvxTRisQCAQCgUAgEAgEAoFA4ALkf3fdNZwwErJ3AAAAAElFTkSuQmCC", path: "PlatformIndicators/VR.png" },
};

function normalizePlatform(p) {
	p = String(p || "").toLowerCase();
	if (p === "ios" || p === "android") return "mobile";
	if (p === "oculus" || p === "quest" || p === "samsung_gear_vr") return "vr";
	return p;
}

function PlatformIcon({ platform, color, iconSize = 16 }) {
	const icon = PNG_ICONS[normalizePlatform(platform)];
	if (!icon) return jsx(ReactNative.View, { children: jsx(ReactNative.View, { style: { width: iconSize, height: iconSize, borderRadius: 100, backgroundColor: color } }) });
	return jsx(ReactNative.View, { children: jsx(ReactNative.Image, { style: { height: iconSize, width: iconSize, tintColor: color }, source: { uri: icon.url, width: iconSize, height: iconSize, path: icon.path, allowIconTheming: true } }) });
}

let presence, presenceTicks = 0, presenceResetAt, myId;

function getPresence() {
	if (!presenceResetAt) presenceResetAt = setTimeout(() => { presenceTicks = 0; presenceResetAt = null; }, 5000);
	if (!presence || presenceTicks === 0) presence = revenge.discord.flux.Stores.PresenceStore?.getState?.();
	presenceTicks = (presenceTicks + 1) % 20;
	return presence;
}

function getStatuses(userId) {
	myId ??= revenge.discord.flux.Stores.UserStore?.getCurrentUser?.()?.id;

	if (userId === myId) {
		const sessions = revenge.discord.flux.Stores.SessionsStore?.getSessions?.() ?? {};
		return Object.values(sessions).reduce((acc, s) => {
			const client = s?.clientInfo?.client;
			if (!client || client === "unknown") return acc;
			acc[normalizePlatform(client)] = s.status;
			return acc;
		}, {});
	}
	return getPresence()?.clientStatuses?.[userId];
}

function StatusIcons({ userId, size = 16 }) {
	const rerender = utils.react.useReRender();
	React.useEffect(() => revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (p) => { rerender(); return p; }), [rerender]);
	const statuses = getStatuses(userId) ?? {};
	return jsx(Fragment, {
		children: Object.keys(statuses).map((p) =>
			jsx(PlatformIcon, { platform: p, color: statusColor(statuses[p], settings.cache?.fallbackColors), iconSize: size }, p),
		),
	});
}

const WALK = { walkable: new Set(["props", "children"]) };
const hasUser = (n) => n?.props?.user?.id !== undefined;
const safely = (fn) => { try { fn(); } catch {} };

export default plugin({
	async start({ cleanup }) {
		await settings.get();

		cleanup(revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (p) => { presence = null; return p; }));

		cleanup(getModules(withExactName("ChannelHeader"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.after(target.parent, target.key, (result) => {
				safely(() => {
					if (!settings.cache?.dmTopBar || result?.type?.type?.name !== "PrivateChannelHeader") return;
					cleanup(patcher.after(result.type, "type", (header) => {
						safely(() => {
							const userId = utils.tree.findInTree(header, hasUser, WALK)?.props?.user?.id;
							if (!userId) return;

							const container = utils.tree.findInTree(header, (n) => n?.key === "DMTabsV2HeaderIcons", WALK);
							if (container) return void (container.props.children = jsx(StatusIcons, { userId }));

							const inner = header.props?.children?.props?.children?.props?.children?.[1];
							if (inner && typeof inner.type === "function") {
								const unpatch = patcher.after(inner, "type", (r) => {
									unpatch();
									safely(() => {
										if (!utils.tree.findInTree(r, (n) => n?.key === "DMTabsV2Header-v2", WALK)) {
											r.props.children[0]?.props?.children?.push(jsx(StatusIcons, { userId }, "DMTabsV2Header-v2"));
										}
									});
									return r;
								});
								cleanup(unpatch);
							}
						});
						return header;
					}));
				});
				return result;
			}));
		}));

		cleanup(getModules(withExactName("UserProfileContent"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.after(target.parent, target.key, (result) => {
				safely(() => {
					const primary = utils.tree.findInTree(result, (n) => n?.type?.name === "PrimaryInfo", WALK);
					if (!primary) return;
					cleanup(patcher.after(primary, "type", (a) => {
						safely(() => {
							if (a?.type?.name !== "UserProfilePrimaryInfo") return;
							cleanup(patcher.after(a, "type", (b) => {
								safely(() => {
									const name = utils.tree.findInTree(b, (n) => n?.type?.name === "DisplayName", WALK);
									if (!name) return;
									cleanup(patcher.after(name, "type", (c) => {
										safely(() => {
											const userId = name.props?.user?.id;
											if (userId && settings.cache?.profileUsername) c?.props?.children?.push(jsx(StatusIcons, { userId }, "UserProfileIcons"));
										});
										return c;
									}));
								});
								return b;
							}));
						});
						return a;
					}));
				});
				return result;
			}));
		}));

		cleanup(getModules(filters.withProps("DisplayName"), (mod) => {
			cleanup(patcher.instead(mod, "DisplayName", (args, orig) => {
				const result = orig(...args);
				safely(() => {
					const user = args[0]?.user;
					if (user?.id && result && settings.cache?.profileUsername) {
						result.props?.children?.props?.children?.[0]?.props?.children?.push(jsx(StatusIcons, { userId: user.id }, "DisplayNameIcons"));
					}
				});
				return result;
			}));
		}));

		cleanup(getModules(withExactName("UserRow"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				safely(() => {
					const user = props?.user;
					if (!settings.cache?.userList || !user?.id) return;
					if (utils.tree.findInTree(result?.props?.label, (n) => n?.key === "TabsV2MemberListStatusIconsView", WALK)) return;

					result.props.label = jsxs(ReactNative.View, {
						style: { justifyContent: settings.cache?.oldUserListIcons ? "space-between" : "flex-start", flexDirection: "row", alignItems: "center" },
						children: [
							result.props.label,
							jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: user.id }) }, "TabsV2MemberListStatusIconsView"),
						],
					}, "TabsV2MemberListStatusIconsView");
				});
				return result;
			}));
		}, { max: Infinity }));

		cleanup(getModules(withExactName("MessagesItemChannelContent"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				safely(() => {
					if (!settings.cache?.userList || props?.channel?.recipients?.length !== 1) return;
					const recipientId = props.channel.recipients[0];
					utils.tree.findInTree(result, (n) => n?.props?.children?.[0]?.props?.variant?.includes?.("channel-title"), WALK)
						?.props?.children?.push(jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: recipientId }) }, "TabsV2RedesignDMListIcons"));
				});
				return result;
			}));
		}));
	},
	SettingsComponent: SettingsPage,
});