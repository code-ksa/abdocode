/**
 * ب2 (09-16) — القناةُ اللينكسيّة لسطح المكتب: X11 عبر xdotool (نوافذ/تركيز/نقر/كتابة/مفاتيح/تمرير/سحب)، شجرةُ الواجهة عبر AT-SPI2
 * (pyatspi)، واللقطةُ عبر ImageMagick (`import`). العقدُ نفسُه: الفعلُ المصنَّف نفسُه، وشكلُ JSON نفسُه الذي يفسّره `runDesktop`
 * (hwnd/pid/title/left/top/right/bottom، foreground/moved/blocked، elements/how/verified…) — فلا مفسِّرَ ثانياً ولا حرّاسَ ثانية.
 *
 * السكربتُ بايثون واحد يُقرأ من stdin (لا اقتباسَ صدفة)، والفعلُ ووسائطُه base64 داخلَه. من ويندوز يُقاس عبر WSLg: المشغّلُ يمرّ
 * `wsl.exe -d <distro> -e bash -lc "python3 -"` ومساراتُ اللقطات تُترجم إلى /mnt/<حرف>/.
 * WSLg: تطبيقاتُ GTK تفتح Wayland افتراضاً فلا يراها xdotool — الإقلاعُ بـ`GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb`؛ وحافلةُ AT-SPI تحتاج
 * حافلةَ جلسةٍ واحدةً ثابتة يشترك فيها القارئُ والتطبيقُ (`/tmp/abdo-desk-bus`).
 */
import { runDesktop, type DesktopAction, type DesktopBackend, type DesktopBound, type DesktopRunner, type UiContext } from "./desktop-control"

export const WSL_DISTRO_DEFAULT = "Ubuntu-24.04"
/** مسارُ wsl.exe المطلق: Bun لا يجده بالاسم في PATH من داخل بعض القشور (مقيس 09-16). */
export const wslExe = (): string => `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\wsl.exe`
export const LINUX_BUS = "/tmp/abdo-desk-bus"

const PY = String.raw`
import base64, json, os, subprocess, sys, time
A = json.loads(base64.b64decode(ARGS).decode("utf-8"))
os.environ.setdefault("DISPLAY", ":0")
os.environ.setdefault("GDK_BACKEND", "x11")
os.environ.setdefault("QT_QPA_PLATFORM", "xcb")
os.environ.setdefault("NO_AT_BRIDGE", "0")
BUS_PATH = A.get("bus", "/tmp/abdo-desk-bus")
BUS = "unix:path=" + BUS_PATH
os.environ["DBUS_SESSION_BUS_ADDRESS"] = BUS
DEVNULL = subprocess.DEVNULL

def gdbus_ok(dest, path, method):
    try:
        r = subprocess.run(["gdbus", "call", "--session", "--dest", dest, "--object-path", path, "--method", method], capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False

def ensure_buses():
    # مقيس 09-16 على WSLg: حافلةُ الجلسة تموت مع انتهاء أمر wsl.exe والملفُّ يبقى — الحياةُ تُقاس بنداءٍ لا بوجود الملفّ، والإطلاقُ منفصلٌ (setsid).
    if not gdbus_ok("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetId"):
        try: os.remove(BUS_PATH)
        except OSError: pass
        subprocess.Popen(["setsid", "dbus-daemon", "--session", "--nofork", "--address=" + BUS], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, start_new_session=True)
        for _ in range(20):
            time.sleep(0.15)
            if gdbus_ok("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.GetId"): break
    # حافلةُ الوصول (AT-SPI) تُطلق على حافلة الجلسة نفسِها كي يراها التطبيقُ والقارئُ معاً.
    if not gdbus_ok("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"):
        subprocess.Popen(["setsid", "/usr/libexec/at-spi-bus-launcher", "--launch-immediately"], stdin=DEVNULL, stdout=DEVNULL, stderr=DEVNULL, start_new_session=True)
        for _ in range(20):
            time.sleep(0.15)
            if gdbus_ok("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"): break

if A["kind"] in ("ui", "set", "press", "open"):
    ensure_buses()

def out(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n"); sys.stdout.flush(); sys.exit(0)

def sh(*args, timeout=15, inp=None):
    r = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, input=inp)
    return r.stdout.strip()

def wpath(p):
    # مسارُ ويندوز (C:\a\b.png) يصير /mnt/c/a/b.png حين يُقاس عبر WSL؛ مسارُ لينكس يبقى.
    if len(p) > 2 and p[1] == ":" and p[2] in "\\/":
        return "/mnt/" + p[0].lower() + p[2:].replace("\\", "/")
    return p

def geometry(wid):
    g = {}
    for line in sh("xdotool", "getwindowgeometry", "--shell", str(wid)).splitlines():
        if "=" in line:
            k, v = line.split("=", 1); g[k] = v
    try:
        x, y, w, h = int(g.get("X", 0)), int(g.get("Y", 0)), int(g.get("WIDTH", 0)), int(g.get("HEIGHT", 0))
    except ValueError:
        return (0, 0, 0, 0)
    return (x, y, w, h)

def wtitle(wid):
    try: return sh("xdotool", "getwindowname", str(wid))
    except Exception: return ""

def wpid(wid):
    try: return int(sh("xdotool", "getwindowpid", str(wid)))
    except Exception: return 0

def windows():
    ws = []
    ids = sh("xdotool", "search", "--onlyvisible", "--name", "").split()
    for wid in ids:
        t = wtitle(wid)
        if not t: continue
        x, y, w, h = geometry(wid)
        if w <= 0: continue
        ws.append({"hwnd": int(wid), "pid": wpid(wid), "title": t, "left": x, "top": y, "right": x + w, "bottom": y + h})
    return ws

def active():
    try: return int(sh("xdotool", "getactivewindow"))
    except Exception: return 0

def activate(wid):
    subprocess.run(["xdotool", "windowactivate", "--sync", str(wid)], capture_output=True, timeout=5)
    time.sleep(0.15)
    return active() == wid

def guard():
    # الحارسُ الذي يسبق كلّ حقن: المقدّمةُ هي النافذةُ المربوطة — يُرفع مرّةً إن لم تكن، وإلّا رفضٌ مسمّى. المستطيلُ يُقرأ الآن.
    want = int(A["bound"]["hwnd"])
    if active() != want:
        activate(want)
        if active() != want:
            out({"ok": False, "error": "focus moved", "foreground": wtitle(active())})
    x, y, w, h = geometry(want)
    if w <= 0 or h <= 0: out({"ok": False, "error": "window gone"})
    return want, x, y, w, h

def tail(want, extra):
    fg = active(); moved = fg != want
    o = {"ok": (not moved), "blocked": False, "moved": moved, "asked": 1, "accepted": 1, "foreground": wtitle(fg)}
    o.update(extra); out(o)

KEYS = {"enter": "Return", "return": "Return", "tab": "Tab", "esc": "Escape", "escape": "Escape", "backspace": "BackSpace", "delete": "Delete", "del": "Delete",
        "space": "space", "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
        "win": "super", "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift", "insert": "Insert", "printscreen": "Print"}

ROLES = {"push button": "Button", "toggle button": "Button", "text": "Edit", "entry": "Edit", "password text": "Edit", "check box": "CheckBox", "radio button": "RadioButton",
         "combo box": "ComboBox", "list": "List", "list box": "List", "list item": "ListItem", "menu item": "MenuItem", "menu": "Menu", "menu bar": "MenuBar",
         "page tab": "TabItem", "page tab list": "Tab", "label": "Text", "link": "Hyperlink", "slider": "Slider", "spin button": "Spinner", "frame": "Window",
         "window": "Window", "panel": "Pane", "filler": "Pane", "document text": "Document", "tree item": "TreeItem", "table cell": "DataItem", "scroll bar": "ScrollBar"}

def atspi_window(pid, title):
    import pyatspi
    desk = pyatspi.Registry.getDesktop(0)
    for app in desk:
        try:
            if app is None or app.get_process_id() != pid: continue
        except Exception:
            continue
        frames = [c for c in app]
        for f in frames:
            try:
                if f.name == title: return f
            except Exception: pass
        if frames: return frames[0]
    return None

def frame_origin(root, wx, wy):
    # مقيس 09-16 على WSLg: أصلُ AT-SPI (مكتبيّ) لا يطابق أصلَ xdotool للنافذة نفسِها (فرقُ الإطار/الترجمة) فكانت العناصرُ «خارج الشاشة» بإحداثيّاتٍ سالبة —
    # الإحداثيّاتُ النسبيّة تُحسب من إطار النافذة في AT-SPI نفسِه فتبقى متّسقةً مع بعضها؛ وتعذّرُه يعيد أصلَ xdotool.
    try:
        import pyatspi
        e = root.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if e.width > 0: return (int(e.x), int(e.y))
    except Exception: pass
    return (wx, wy)

def walk(root, max_depth, cap):
    items = []
    def rec(el, depth):
        for i in range(el.childCount):
            if len(items) >= cap: return
            try: c = el.getChildAtIndex(i)
            except Exception: continue
            if c is None: continue
            items.append(c)
            if depth < max_depth: rec(c, depth + 1)
    rec(root, 1)
    return items

def describe(el, i, wx, wy):
    import pyatspi
    role = el.getRoleName()
    kind = ROLES.get(role, role.title().replace(" ", "") or "Pane")
    st = el.getState()
    enabled = st.contains(pyatspi.STATE_ENABLED)
    password = role == "password text"
    pats = []
    try:
        acts = el.queryAction(); names = [acts.getName(k) for k in range(acts.nActions)]
        if any(n in ("click", "press", "activate") for n in names): pats.append("Invoke")
        if "toggle" in names: pats.append("Toggle")
    except Exception: pass
    val = None
    try:
        el.queryEditableText(); pats.append("Value")
    except Exception: pass
    try:
        t = el.queryText(); pats.append("Text") if "Text" not in pats else None
        if not password: val = t.getText(0, min(t.characterCount, 80))
    except Exception: pass
    if st.contains(pyatspi.STATE_SELECTABLE): pats.append("SelectionItem")
    if st.contains(pyatspi.STATE_EXPANDABLE): pats.append("ExpandCollapse")
    x = y = -1; w = h = 0
    try:
        ext = el.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        if ext.width > 0: x, y, w, h = int(ext.x - wx), int(ext.y - wy), int(ext.width), int(ext.height)
    except Exception: pass
    name = el.name or ""
    if kind == "Edit" and name == val: name = ""
    ident = ""
    try:
        attrs = dict(a.split(":", 1) for a in el.getAttributes() if ":" in a); ident = attrs.get("id", "")
    except Exception: pass
    o = {"ref": i, "type": kind, "name": name, "id": ident, "x": x, "y": y, "w": w, "h": h, "patterns": pats, "enabled": enabled, "password": password}
    if val is not None: o["value"] = val
    return o

def locate():
    want, wx, wy, ww, wh = guard()
    root = atspi_window(wpid(want), wtitle(want))
    if root is None: out({"ok": False, "error": "the window does not announce an accessibility tree (AT-SPI): launch it with GDK_BACKEND=x11 on the same session bus"})
    items = walk(root, int(A["ui"]["depth"]), 400)
    idx = int(A["ref"]) - 1
    if idx >= len(items): out({"ok": False, "error": "ref beyond the tree (the UI changed) - run desk ui again", "count": len(items)})
    el = items[idx]
    fx, fy = frame_origin(root, wx, wy)
    d = describe(el, idx + 1, fx, fy)
    exp_type, exp_name = A.get("expType", ""), A.get("expName", "")
    name_ok = d["type"] == "Edit" or d["name"] == exp_name
    if d["type"] != exp_type or not name_ok:
        out({"ok": False, "error": "the UI changed since desk ui - run desk ui again", "nowType": d["type"], "nowName": d["name"]})
    return want, el, d

k = A["kind"]
if k == "windows":
    out({"ok": True, "windows": windows()})
elif k == "shot":
    path = wpath(A["shotPath"])
    if A.get("scope") != "screen" and A.get("bound"):
        want, x, y, w, h = guard()
        subprocess.run(["import", "-window", str(want), path], capture_output=True, timeout=20)
        out({"ok": os.path.exists(path), "scope": "window", "width": w, "height": h, "left": x, "top": y, "title": wtitle(want), "path": path})
    subprocess.run(["import", "-window", "root", path], capture_output=True, timeout=20)
    dims = sh("identify", "-format", "%w %h", path).split() if os.path.exists(path) else ["0", "0"]
    out({"ok": os.path.exists(path), "scope": "screen", "width": int(dims[0]), "height": int(dims[1]), "left": 0, "top": 0, "path": path})
elif k == "open":
    before = {w["hwnd"] for w in windows()}
    app = A["app"]
    try:
        p = subprocess.Popen(["bash", "-lc", "exec " + app], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        out({"ok": False, "error": "could not start: " + str(e)})
    fresh = []; deadline = time.time() + 8
    while time.time() < deadline:
        time.sleep(0.25)
        fresh = [w for w in windows() if w["hwnd"] not in before]
        if fresh: time.sleep(0.4); break
    if not fresh:
        needle = os.path.basename(app.split()[0]).lower()
        same = [w for w in windows() if needle in w["title"].lower()]
        if not same: out({"ok": False, "error": "no new window appeared within 8s (is the app installed, and does it open an X11 window?)"})
        win = same[0]; existing = True
    else:
        mine = [w for w in fresh if w["pid"] == p.pid] or fresh
        win = mine[-1]; existing = False
    focused = activate(win["hwnd"])
    others = [{"title": w["title"], "pid": w["pid"]} for w in fresh if w["hwnd"] != win["hwnd"]]
    out({"ok": True, "hwnd": win["hwnd"], "pid": win["pid"], "title": win["title"], "left": win["left"], "top": win["top"], "right": win["right"], "bottom": win["bottom"], "existing": existing, "focused": focused, "others": others})
elif k == "focus":
    needle = A["title"].lower()
    ws = windows()
    hit = None
    if needle.startswith("pid:"):
        hit = next((w for w in ws if str(w["pid"]) == needle[4:]), None)
    else:
        hit = next((w for w in ws if needle in w["title"].lower()), None)
    if hit is None:
        out({"ok": False, "error": "no window matches", "count": len(ws), "windows": [{"title": w["title"], "pid": w["pid"]} for w in ws[:15]]})
    if not activate(hit["hwnd"]):
        out({"ok": False, "error": "could not bring the window to the front", "foreground": wtitle(active())})
    x, y, w, h = geometry(hit["hwnd"])
    out({"ok": True, "hwnd": hit["hwnd"], "title": hit["title"], "pid": hit["pid"], "left": x, "top": y, "right": x + w, "bottom": y + h})
elif k == "click":
    want, wx, wy, ww, wh = guard()
    if A["x"] >= ww or A["y"] >= wh: out({"ok": False, "error": "point is outside the window now", "width": ww, "height": wh})
    sx, sy = wx + A["x"], wy + A["y"]
    sh("xdotool", "mousemove", str(sx), str(sy)); time.sleep(0.04)
    btn = "3" if A["button"] == "right" else "1"
    if A["button"] == "double": sh("xdotool", "click", "--repeat", "2", "--delay", "60", btn)
    else: sh("xdotool", "click", btn)
    tail(want, {"x": sx, "y": sy, "button": A["button"]})
elif k == "type":
    want, wx, wy, ww, wh = guard()
    text = A["text"]
    subprocess.run(["xdotool", "type", "--delay", "8", "--file", "-"], input=text, text=True, capture_output=True, timeout=60 + len(text) // 10)
    tail(want, {"chars": len(text)})
elif k == "key":
    want, wx, wy, ww, wh = guard()
    parts = [KEYS.get(p, p) for p in A["combo"].split("+")]
    sh("xdotool", "key", "--clearmodifiers", "+".join(parts))
    tail(want, {"combo": A["combo"]})
elif k == "scroll":
    want, wx, wy, ww, wh = guard()
    sh("xdotool", "mousemove", str(wx + ww // 2), str(wy + wh // 2))
    btn = {"up": "4", "down": "5", "left": "6", "right": "7"}[A["direction"]]
    sh("xdotool", "click", "--repeat", str(int(A["count"])), "--delay", "30", btn)
    tail(want, {"direction": A["direction"], "count": int(A["count"])})
elif k == "drag":
    want, wx, wy, ww, wh = guard()
    x1, y1, x2, y2 = int(A["x1"]), int(A["y1"]), int(A["x2"]), int(A["y2"])
    if x1 >= ww or y1 >= wh or x2 >= ww or y2 >= wh: out({"ok": False, "error": "a point is outside the window now", "width": ww, "height": wh})
    sx, sy, ex, ey = wx + x1, wy + y1, wx + x2, wy + y2
    sh("xdotool", "mousemove", str(sx), str(sy)); time.sleep(0.04)
    sh("xdotool", "mousedown", "1"); time.sleep(0.06)
    for i in range(1, 13):
        sh("xdotool", "mousemove", str(int(sx + (ex - sx) * i / 12)), str(int(sy + (ey - sy) * i / 12))); time.sleep(0.025)
    sh("xdotool", "mouseup", "1"); time.sleep(0.04)
    tail(want, {"x1": sx, "y1": sy, "x2": ex, "y2": ey})
elif k == "ui":
    want, wx, wy, ww, wh = guard()
    root = atspi_window(wpid(want), wtitle(want))
    if root is None: out({"ok": True, "count": 0, "capped": False, "elements": [], "width": ww, "height": wh, "note": "no AT-SPI tree"})
    items = walk(root, int(A["depth"]), 400)
    fx, fy = frame_origin(root, wx, wy)
    out({"ok": True, "count": len(items), "capped": len(items) >= 400, "elements": [describe(el, i + 1, fx, fy) for i, el in enumerate(items)], "width": ww, "height": wh})
elif k == "set":
    want, el, d = locate()
    text = A["text"]; how = ""
    try:
        et = el.queryEditableText(); et.setTextContents(text); how = "value-pattern"
    except Exception:
        try: el.queryComponent().grabFocus()
        except Exception: pass
        time.sleep(0.08)
        sh("xdotool", "key", "--clearmodifiers", "ctrl+a")
        subprocess.run(["xdotool", "type", "--delay", "8", "--file", "-"], input=text, text=True, capture_output=True, timeout=60)
        how = "typed"
    time.sleep(0.15)
    readback = None
    if not d["password"]:
        try:
            t = el.queryText(); readback = t.getText(0, t.characterCount)
        except Exception: pass
    verified = readback is not None and readback.replace("\r", "") == text.replace("\r", "")
    out({"ok": True, "blocked": False, "how": how, "verified": verified, "readback": None if readback is None else readback[:80], "password": d["password"], "name": A.get("expName", ""), "type": A.get("expType", ""), "foreground": wtitle(active())})
elif k == "press":
    want, el, d = locate()
    how = ""
    try:
        acts = el.queryAction(); names = [acts.getName(i) for i in range(acts.nActions)]
        for pref in ("click", "press", "activate", "toggle"):
            if pref in names:
                acts.doAction(names.index(pref)); how = "toggle" if pref == "toggle" else "invoke"; break
    except Exception: pass
    if not how:
        if d["x"] < 0 or d["w"] <= 0: out({"ok": False, "error": "element has no clickable area and no invoke pattern"})
        # مركزُ العنصر بإحداثيّات AT-SPI المكتبيّة نفسِها (لا بجمع أصل xdotool على إحداثيّاتٍ نسبيّة لإطار AT-SPI).
        try:
            import pyatspi
            e = el.queryComponent().getExtents(pyatspi.DESKTOP_COORDS); cx, cy = int(e.x + e.width / 2), int(e.y + e.height / 2)
        except Exception:
            want2, wx, wy, ww, wh = guard(); cx, cy = wx + d["x"] + d["w"] // 2, wy + d["y"] + d["h"] // 2
        sh("xdotool", "mousemove", str(cx), str(cy)); time.sleep(0.04); sh("xdotool", "click", "1"); how = "click-center"
    time.sleep(0.15)
    out({"ok": True, "blocked": False, "how": how, "name": A.get("expName", ""), "type": A.get("expType", ""), "foreground": wtitle(active())})
else:
    out({"ok": False, "error": "unknown action " + str(k)})
`

/** سكربتُ بايثون لفعلٍ واحد — الشكلُ نفسُه الذي يُخرجه سكربتُ ويندوز فيقرؤه المفسِّر المشترك. */
export function linuxScript(action: DesktopAction, shotPath = "", bound?: DesktopBound, ui?: UiContext, _selfPids: readonly number[] = []): string {
  const expect = (action.kind === "set" || action.kind === "press") && ui !== undefined ? ui.elements.find((e) => e.ref === action.ref) : undefined
  const args = { ...action, shotPath, bound, ui: ui === undefined ? undefined : { depth: ui.depth }, expType: expect?.type ?? "", expName: expect?.name ?? "", bus: LINUX_BUS }
  return `ARGS = "${Buffer.from(JSON.stringify(args), "utf8").toString("base64")}"\n${PY}`
}

/** المشغّل: python3 يقرأ السكربتَ من stdin — محلّيّاً على لينكس، أو عبر wsl.exe من ويندوز (القياسُ على WSLg). */
export const linuxRunner = (options: { readonly wslDistro?: string } = {}): DesktopRunner => ({
  async run(script, timeoutMs) {
    const argv = options.wslDistro === undefined
      ? ["bash", "-lc", "python3 -"]
      : [wslExe(), "-d", options.wslDistro, "-e", "bash", "-lc", "python3 -"]
    const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
    child.stdin.write(script)
    await child.stdin.end()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* انتهى */ } }, timeoutMs)
    try {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      // wsl.exe يكتب أحياناً UTF-16 بأصفارٍ داخل النصّ — تُنزع كي يُقرأ آخرُ سطر JSON.
      return { code, stdout: stdout.replace(/\u0000/gu, ""), stderr: stderr.replace(/\u0000/gu, ""), timedOut }
    } finally { clearTimeout(timer) }
  },
})

export const linuxBackend = (options: { readonly wslDistro?: string } = {}): DesktopBackend => Object.freeze({
  id: "linux-x11" as const,
  platform: "linux" as const,
  label: options.wslDistro === undefined ? "لينكس — X11 عبر xdotool + AT-SPI2 + ImageMagick" : `لينكس على WSLg (${options.wslDistro}) — X11 عبر xdotool + AT-SPI2 + ImageMagick`,
  run: (action: DesktopAction, runOptions: Parameters<typeof runDesktop>[1]) => runDesktop(action, { ...runOptions, runner: runOptions.runner ?? linuxRunner(options), script: linuxScript }),
})
